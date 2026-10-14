#!/usr/bin/env node
/**
 * 响应体正则改写 —— 端到端测试程序（不依赖扩展）
 *
 * 用 CDP 的 Fetch 域拦截 JS 响应，把
 *     var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;
 * 替换成
 *     var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;console.log('test');
 * 然后验证页面真的执行了注入后的代码。
 *
 * 这个程序不依赖扩展，直接用 CDP 复现扩展里要做的事，
 * 所以它同时是「机制验证」和「后续实现的参考代码」。
 * （扩展内的版本见 test/rewrite-extension.js）
 *
 * 运行：
 *   node test/rewrite-response.js
 *
 * 可用环境变量覆盖：
 *   FIND      要查找的字符串
 *   REPLACE   替换成的字符串
 *   GZIP=0    不用 gzip 发 JS（默认用 gzip，贴近真实 CDN）
 *   PORT / CDP_PORT / CHROME
 */

const http = require("http");
const zlib = require("zlib");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8810);
const CDP_PORT = Number(process.env.CDP_PORT || 9340);
const PROFILE = path.join(os.tmpdir(), `rewrite-test-${Date.now()}`);
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// 必须用 String.raw：这段字符串里有 \. ，普通字符串字面量 '\.' 会把反斜杠吃掉，
// 变成 '.'，匹配就完全不对了。
const FIND =
  process.env.FIND ||
  String.raw`var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;`;

const REPLACE =
  process.env.REPLACE ||
  String.raw`var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;console.log('test');`;

const USE_GZIP = process.env.GZIP !== "0";

// 被测的「线上 bundle」，中间那行就是查找目标
const BUNDLE = [
  '(()=>{"use strict";',
  FIND,
  "window.__appLoaded = true;",
  'console.log("原始 bundle 已执行");',
  "})();",
  ""
].join("\n");

/* ------------------------------------------------------------------ */
/* 核心：把字面量字符串变成安全的正则                                     */
/* ------------------------------------------------------------------ */

// 查找串里全是正则元字符 ( ) { } . * + ? ^ $ | [ ] \ ，不转义的话 new RegExp 直接报错
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RULES = [
  {
    name: "注入 console.log('test')",
    urlPattern: /\/app\.js(\?|$)/,
    find: new RegExp(escapeRegExp(FIND), "g"),
    replacement: REPLACE
  }
];

/* ------------------------------------------------------------------ */
/* 改写要用到的两个工具函数（扩展里也会是这两个）                          */
/* ------------------------------------------------------------------ */

// 正文已经被 CDP 解压过了，所以 content-encoding 必须删掉，content-length 必须重算，
// 否则浏览器会拿明文去 gunzip，直接报错。
function prepareHeaders(headers, body) {
  const out = [];
  for (const { name, value } of headers || []) {
    const lower = name.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length") continue;
    out.push({ name, value });
  }
  out.push({ name: "Content-Length", value: String(Buffer.byteLength(body, "utf8")) });
  return out;
}

function headerValue(headers, name) {
  const hit = (headers || []).find(h => h.name.toLowerCase() === name);
  return hit ? hit.value : "";
}

// 只处理文本类响应；图片/字体等二进制一律放行
function isTextual(contentType) {
  return /json|javascript|ecmascript|xml|text\/|charset=/i.test(contentType || "");
}

function applyRules(url, text) {
  let out = text;
  const hits = [];

  for (const rule of RULES) {
    if (!rule.urlPattern.test(url)) continue;

    // 带 /g 的正则 test() 有 lastIndex 状态，连续调用会漏匹配
    rule.find.lastIndex = 0;
    if (!rule.find.test(out)) continue;

    rule.find.lastIndex = 0;
    out = out.replace(rule.find, rule.replacement);
    hits.push(rule.name);
  }

  return { text: out, hits };
}

// 从注入的代码里把 console.log('xxx') 的参数抠出来，
// 用来断言「这行代码真的在页面里执行了」—— 比的是 console 的输出值，不是源码
function extractLoggedValue(snippet) {
  const match = String(snippet).match(/console\.log\(\s*['"`]([^'"`]*)['"`]\s*\)/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/* CDP 连接                                                           */
/* ------------------------------------------------------------------ */

function connect(url, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();

    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method && onEvent) {
        onEvent(msg);
      }
    };

    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
    ws.onopen = () =>
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
          });
        },
        close() { ws.close(); }
      });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(pathname) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/app.js") {
      const raw = Buffer.from(BUNDLE, "utf8");
      const body = USE_GZIP ? zlib.gzipSync(raw) : raw;

      const headers = {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": body.length
      };
      if (USE_GZIP) headers["content-encoding"] = "gzip";

      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>rewrite test</title></head>' +
      '<body><h1>rewrite test</h1><script src="/app.js"></script></body></html>'
    );
  });
  await new Promise(r => server.listen(PORT, "127.0.0.1", r));

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
    "about:blank"
  ], { stdio: "ignore" });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJSON("/json/version"); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error("Chrome 调试端口没起来");
  console.log(`Chrome ${version.Browser}`);

  // 建一个空白页，先把 Runtime / Fetch 打开，再导航过去，
  // 这样页面加载时 /app.js 的请求就会被拦到
  const browser = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  await sleep(600);

  const list = await getJSON("/json/list");
  const pageTarget = list.find(t => t.id === targetId);

  const consoleLogs = [];
  const interceptLog = [];
  let rewritten = false;
  let beforeText = "";
  let afterText = "";

  const page = await connect(pageTarget.webSocketDebuggerUrl, async msg => {
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLogs.push(
        (msg.params.args || []).map(a => (a.value !== undefined ? a.value : a.description)).join(" ")
      );
      return;
    }

    if (msg.method !== "Fetch.requestPaused") return;

    const { requestId, request, responseStatusCode, responseHeaders } = msg.params;
    const reply = (method, params) => page.send(method, params).catch(() => {});

    // 每一条都必须回应，漏一条页面就永久卡住
    if (responseStatusCode == null || (responseStatusCode >= 300 && responseStatusCode < 400)) {
      return reply("Fetch.continueRequest", { requestId });
    }

    if (!isTextual(headerValue(responseHeaders, "content-type"))) {
      return reply("Fetch.continueRequest", { requestId });
    }

    if (!RULES.some(r => r.urlPattern.test(request.url))) {
      return reply("Fetch.continueRequest", { requestId });
    }

    try {
      const { body, base64Encoded } = await page.send("Fetch.getResponseBody", { requestId });

      // 注意：纯文本 JSON/JS 也常常返回 base64Encoded=true，
      // 所以不能拿这个字段判断二进制，只能按 content-type 判
      const text = Buffer.from(body, base64Encoded ? "base64" : "utf8").toString("utf8");

      const { text: out, hits } = applyRules(request.url, text);

      if (!hits.length) {
        interceptLog.push(`放行（正则不匹配） ${request.url}`);
        return reply("Fetch.continueRequest", { requestId });
      }

      beforeText = text;
      afterText = out;
      rewritten = true;
      interceptLog.push(`改写 ${request.url}  [${hits.join(", ")}]`);

      return reply("Fetch.fulfillRequest", {
        requestId,
        responseCode: responseStatusCode,
        responsePhrase: "OK",
        responseHeaders: prepareHeaders(responseHeaders, out),
        body: Buffer.from(out, "utf8").toString("base64")
      });
    } catch (error) {
      interceptLog.push(`出错回退放行 ${request.url}: ${error.message}`);
      return reply("Fetch.continueRequest", { requestId });
    }
  });

  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Response" }],
    handleAuthRequests: false
  });

  await page.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);

  const evaluate = async expression => {
    const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return "EXC: " + (r.exceptionDetails.exception?.description || "").split("\n")[0];
    return r.result.value;
  };

  const appLoaded = await evaluate("window.__appLoaded === true");
  const received = await evaluate(`fetch('/app.js').then(r => r.text())`);

  /* ---------------- 报告 ---------------- */

  const injected = REPLACE.replace(FIND, "");
  const expectedLog = extractLoggedValue(injected);
  const line = "─".repeat(62);

  console.log(`\n${line}`);
  console.log(`规则      : ${FIND}   ->   ${REPLACE}`);
  console.log(`响应编码  : ${USE_GZIP ? "gzip" : "identity"}`);
  console.log(line);
  console.log(`拦截日志  : ${interceptLog.length ? interceptLog.join("\n            ") : "（没有任何请求被拦截）"}`);
  console.log(`\n改写前    : ${JSON.stringify(beforeText)}`);
  console.log(`改写后    : ${JSON.stringify(afterText)}`);
  console.log(`\n页面 console : ${JSON.stringify(consoleLogs)}`);
  console.log(`window.__appLoaded : ${appLoaded}`);
  console.log(line);

  const checks = [
    ["JS 响应被拦截并改写", rewritten],
    ["页面收到的是改写后的内容", typeof received === "string" && received.includes(injected)],
    [
      `注入的语句真的在页面里执行了（console 输出 ${JSON.stringify(expectedLog)}）`,
      expectedLog != null && consoleLogs.includes(expectedLog)
    ],
    ["原 bundle 其余代码仍然正常执行", appLoaded === true]
  ];

  let allPass = true;
  for (const [name, ok] of checks) {
    if (!ok) allPass = false;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }

  console.log(line);
  console.log(allPass ? "全部通过 ✓" : "存在失败项 ✗");

  page.close();
  browser.close();
  chrome.kill("SIGKILL");
  server.close();

  // Chrome 退出需要一点时间，太早删 profile 会 ENOTEMPTY
  await sleep(600);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    // 临时目录，删不掉也无所谓
  }

  process.exit(allPass ? 0 : 1);
}

main().catch(error => {
  console.error("测试程序异常:", error.message);
  process.exit(1);
});
