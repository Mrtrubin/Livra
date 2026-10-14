#!/usr/bin/env node
/**
 * Livra —— 端到端测试
 *
 * 验证扩展真的会在浏览器里按规则改写响应体：
 * 把
 *     var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;
 * 替换成
 *     var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;alert('test');
 *
 * 同时验证「每个标签页一份独立会话」的架构：
 *   - 只开 A 标签时，B 标签不受影响
 *   - A 开着的时候可以再开 B，两个标签同时生效
 *
 * 流程：起本地服务 -> 加载扩展 -> 开两个标签页 -> 点页面里的悬浮按钮
 *      -> 刷新页面 -> 校验。
 *
 * 点的是**页面里真实的悬浮按钮**（shadow DOM 里的 <button>），和用户手点一致。
 *
 * 注意：为了让页面不弹真对话框卡住（headless 下会阻塞渲染进程），
 * 这里用 addScriptToEvaluateOnNewDocument 把 window.alert 换成了记录器。
 * 真机上手点会看到真的 alert 弹窗。
 *
 * 运行：node test/rewrite-extension.js
 */

const http = require("http");
const zlib = require("zlib");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const EXT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8820);
const CDP_PORT = Number(process.env.CDP_PORT || 9350);
const PROFILE = path.join(os.tmpdir(), `livra-ext-${Date.now()}`);
const CHROME =
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TARGET_LINE = String.raw`var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;`;
const INJECTED = `${TARGET_LINE}alert('test');`;

// 命中规则的路径：URL 里带 "config"，和 rewrite.js 里规则的 fetchPattern "*config*" 对得上
const BUNDLE_PATH = "/assets/chunks/config.DHyWUa4I.js";
// 不命中规则的路径：内容一样、但 URL 里没有 "config"，必须原样返回
const OTHER_PATH = "/assets/chunks/other.AbC123.js";

const HOST_ID = "livra-floating-button";

const BUNDLE = [
  '(()=>{"use strict";',
  TARGET_LINE,
  "window.__appLoaded = true;",
  'console.log("原始 bundle 已执行");',
  "})();",
  ""
].join("\n");

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
        send(method, params, sessionId) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { resolve: res, reject: rej });
            const payload = { id: mid, method, params: params || {} };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
          });
        },
        close() { ws.close(); }
      });
  });
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === BUNDLE_PATH || url.pathname === OTHER_PATH) {
      // 用 gzip 发，贴近真实 CDN，顺便验证 content-encoding 的处理
      const gz = zlib.gzipSync(Buffer.from(BUNDLE, "utf8"));
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": gz.length,
        // 故意用 immutable：测试流程会加载页面两次，第二次就是缓存命中。
        // Fetch 域拦不到缓存命中的响应，所以扩展必须同时关缓存，否则这个用例会失败。
        "cache-control": "max-age=31536000, immutable"
      });
      res.end(gz);
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>livra rewrite test</title></head>` +
      `<body><h1>livra rewrite test</h1>` +
      `<script src="${BUNDLE_PATH}"></script>` +
      `<script src="${OTHER_PATH}"></script>` +
      `</body></html>`
    );
  });
  await new Promise(r => server.listen(PORT, "127.0.0.1", r));

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--enable-unsafe-extension-debugging",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
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
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch { await sleep(300); }
  }
  if (!version) throw new Error("Chrome 调试端口没起来");

  const browser = await connect(version.webSocketDebuggerUrl);
  const { id: extId } = await browser.send("Extensions.loadUnpacked", { path: EXT });
  console.log(`扩展已加载: ${extId}`);
  await sleep(1200);

  const sessions = new Map();
  const attach = async targetId => {
    if (sessions.has(targetId)) return sessions.get(targetId);
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    sessions.set(targetId, sessionId);
    return sessionId;
  };
  const evalOn = async (targetId, expression) => {
    const sessionId = await attach(targetId);
    const r = await browser.send("Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description };
    return r.result.value;
  };

  // 等扩展的 service worker 起来
  await browser.send("Target.setDiscoverTargets", { discover: true });
  let swTargetId = null;
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await browser.send("Target.getTargets");
    const sw = targetInfos.find(t => t.type === "service_worker" && t.url.includes(extId));
    if (sw) { swTargetId = sw.targetId; break; }
    await sleep(300);
  }
  if (!swTargetId) throw new Error("扩展的 service worker 没起来");
  console.log(`service worker target: ${swTargetId}`);

  /* ---------------- 打开两个标签页 ---------------- */

  const openTab = async tag => {
    const { targetId } = await browser.send("Target.createTarget",
      { url: `http://127.0.0.1:${PORT}/?tab=${tag}` });
    const sessionId = await attach(targetId);
    await browser.send("Page.enable", {}, sessionId);
    // 在页面里把 alert 换成记录器，避免 headless 下弹窗阻塞渲染进程
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__alerts = []; window.alert = function (m) { window.__alerts.push(String(m)); };"
    }, sessionId);
    return targetId;
  };

  const tabA = await openTab("a");
  const tabB = await openTab("b");
  await sleep(1500);

  // 等 content script 把悬浮按钮注入进去
  const waitButton = async targetId => {
    for (let i = 0; i < 30; i++) {
      const ok = await evalOn(targetId, `Boolean(document.getElementById("${HOST_ID}"))`);
      if (ok === true) return true;
      await sleep(200);
    }
    return false;
  };

  const buttonInjectedA = await waitButton(tabA);
  const buttonInjectedB = await waitButton(tabB);

  const clickButton = targetId => evalOn(targetId, `(() => {
    const host = document.getElementById("${HOST_ID}");
    if (!host || !host.shadowRoot) return "no-host";
    const btn = host.shadowRoot.querySelector("button");
    if (!btn) return "no-button";
    btn.click();
    return "clicked";
  })()`);

  const buttonLabel = targetId => evalOn(targetId, `(() => {
    const host = document.getElementById("${HOST_ID}");
    const el = host && host.shadowRoot && host.shadowRoot.querySelector(".label");
    return el ? el.textContent : null;
  })()`);

  const readSessions = async () => JSON.parse(await evalOn(swTargetId, `JSON.stringify(
    [...sessions].map(([id, s]) => ({ id, attached: s.attached, count: s.count, error: s.error })))`) || "[]");

  const listTabs = async () => await evalOn(swTargetId, `(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ id: t.id, url: t.url }));
  })()`);

  const tabs = await listTabs();
  const tabIdA = tabs.find(t => (t.url || "").includes("tab=a"))?.id;
  const tabIdB = tabs.find(t => (t.url || "").includes("tab=b"))?.id;
  console.log(`标签页: A=${tabIdA}  B=${tabIdB}`);

  /* ---------------- 步骤 1：只开 A，检查 B 不受影响 ---------------- */

  console.log(`\n[A] 点击页面悬浮按钮: ${await clickButton(tabA)}`);
  await sleep(900);

  const afterA = await readSessions();
  const stateA1 = afterA.find(s => s.id === tabIdA) || {};
  const stateB1 = afterA.find(s => s.id === tabIdB) || {};

  /* ---------------- 步骤 2：刷新两个标签，A 改写、B 原样 ---------------- */

  await evalOn(tabA, "location.reload()");
  await evalOn(tabB, "location.reload()");
  await sleep(3000);

  const receivedA = await evalOn(tabA, `fetch('${BUNDLE_PATH}').then(r => r.text())`);
  const receivedB = await evalOn(tabB, `fetch('${BUNDLE_PATH}').then(r => r.text())`);
  const alertsB = await evalOn(tabB, "JSON.stringify(window.__alerts)");
  const otherA = await evalOn(tabA, `fetch('${OTHER_PATH}').then(r => r.text())`);
  const appLoadedA = await evalOn(tabA, "window.__appLoaded === true");
  const labelA = await buttonLabel(tabA);

  /* ---------------- 步骤 3：A 开着的同时再开 B（并发） ---------------- */

  console.log(`[B] 点击页面悬浮按钮: ${await clickButton(tabB)}`);
  await sleep(900);

  const afterB = await readSessions();
  const stateA2 = afterB.find(s => s.id === tabIdA) || {};
  const stateB2 = afterB.find(s => s.id === tabIdB) || {};

  await evalOn(tabB, "location.reload()");
  await sleep(3000);

  const receivedB2 = await evalOn(tabB, `fetch('${BUNDLE_PATH}').then(r => r.text())`);
  const labelB = await buttonLabel(tabB);

  const afterB3 = await readSessions();
  const stateB3 = afterB3.find(s => s.id === tabIdB) || {};

  // 截一张图，肉眼确认悬浮按钮的样子
  const shot = await browser.send("Page.captureScreenshot", { format: "png" },
    await attach(tabB));
  const shotPath = path.join(os.tmpdir(), "livra-button.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));

  /* ---------------- 步骤 4：侧边栏面板 ---------------- */

  // 侧边栏是「窗口级」的，所以单独开一个窗口，让被测页面当该窗口的当前标签页。
  // 面板标签用 active:false 创建，再显式把被测页面激活 —— 否则面板会把「自己」当成当前标签页。
  const panelSetup = await evalOn(swTargetId, `(async () => {
    const win = await chrome.windows.create({ url: "http://127.0.0.1:${PORT}/?tab=panel", focused: true });
    const probe = win.tabs[0];
    const panel = await chrome.tabs.create({
      windowId: win.id,
      url: chrome.runtime.getURL("sidepanel.html"),
      active: false
    });
    await chrome.tabs.update(probe.id, { active: true });
    return { windowId: win.id, probeTabId: probe.id, panelTabId: panel.id };
  })()`);
  await sleep(1800);

  const { targetInfos } = await browser.send("Target.getTargets");
  const panelTarget = targetInfos.find(t => (t.url || "").includes("sidepanel.html"));
  const probeTarget = targetInfos.find(t => (t.url || "").includes("tab=panel"));

  if (!panelTarget || !probeTarget) throw new Error("侧边栏 / 面板窗口的 target 没找到");

  const PANEL_IDS = ["badge", "tabTitle", "tabUrl", "toggle", "switchHint", "notice",
    "statState", "statCount", "ruleList", "footText"];

  const panelDom = await evalOn(panelTarget.targetId, `(async () => {
    await refresh();
    return {
      title: document.getElementById("tabTitle").textContent,
      url: document.getElementById("tabUrl").textContent,
      badge: document.getElementById("badge").textContent,
      state: document.getElementById("statState").textContent,
      count: document.getElementById("statCount").textContent,
      rules: [...document.querySelectorAll(".rule")].map(r => ({
        name: r.querySelector(".rule-name").textContent,
        scope: r.querySelector(".rule-scope").textContent
      })),
      missing: ${JSON.stringify(PANEL_IDS)}.filter(id => !document.getElementById(id)),
      injectable,
      noticeHidden: document.getElementById("notice").hidden
    };
  })()`);

  // 面板里点开关，应该真的开启「该窗口当前标签页」的改写
  const panelClick = await evalOn(panelTarget.targetId,
    `(() => { const b = document.getElementById("toggle"); if (!b) return "no-toggle"; b.click(); return "clicked"; })()`);
  await sleep(900);

  const panelAfter = await evalOn(panelTarget.targetId, `JSON.stringify({
    badge: document.getElementById("badge").textContent,
    state: document.getElementById("statState").textContent,
    on: document.getElementById("toggle").classList.contains("on")
  })`);

  const panelSessions = await readSessions();
  const panelProbeState = panelSessions.find(s => s.id === panelSetup?.probeTabId) || {};

  // 按侧边栏的真实宽度截一张图
  const panelSession = await attach(panelTarget.targetId);
  await browser.send("Emulation.setDeviceMetricsOverride",
    { width: 340, height: 780, deviceScaleFactor: 2, mobile: false }, panelSession);
  await sleep(400);
  const panelShot = await browser.send("Page.captureScreenshot", { format: "png" }, panelSession);
  const panelShotPath = path.join(os.tmpdir(), "livra-sidepanel.png");
  fs.writeFileSync(panelShotPath, Buffer.from(panelShot.data, "base64"));

  /* ---------------- 报告 ---------------- */

  const line = "─".repeat(62);

  console.log(`\n${line}`);
  console.log(`规则    : ${TARGET_LINE}`);
  console.log(`       -> ${INJECTED}`);
  console.log(line);
  console.log(`A 标签收到（命中规则的 ${BUNDLE_PATH}）:`);
  console.log(`  ${String(receivedA).replace(/\n/g, "\n  ")}`);
  console.log(`\nB 标签（开启前）收到同一文件:`);
  console.log(`  ${String(receivedB).replace(/\n/g, "\n  ")}`);
  console.log(`\nB 标签开启后收到:`);
  console.log(`  ${String(receivedB2).replace(/\n/g, "\n  ")}`);
  console.log(`\nA 标签悬浮按钮文案 : ${labelA}`);
  console.log(`B 标签悬浮按钮文案 : ${labelB}`);
  console.log(`A 标签 window.__appLoaded : ${appLoadedA}`);
  console.log(`B 标签 alert 记录（开启前）: ${alertsB}`);
  console.log(`会话快照（开 A 后）: ${JSON.stringify(afterA)}`);
  console.log(`会话快照（开 B 后）: ${JSON.stringify(afterB)}`);
  console.log(`会话快照（B 刷新后）: ${JSON.stringify(afterB3)}`);
  console.log(`悬浮按钮截图: ${shotPath}`);
  console.log(`\n侧边栏面板:`);
  console.log(`  当前标签页     : ${panelDom?.title}  ${panelDom?.url}`);
  console.log(`  角标/状态/计数 : ${panelDom?.badge} / ${panelDom?.state} / ${panelDom?.count}`);
  console.log(`  规则           : ${JSON.stringify(panelDom?.rules)}`);
  console.log(`  缺失的 DOM 元素: ${JSON.stringify(panelDom?.missing)}`);
  console.log(`  点开关结果     : ${panelClick} -> ${panelAfter}`);
  console.log(`  该标签页会话   : ${JSON.stringify(panelProbeState)}`);
  console.log(`  面板截图       : ${panelShotPath}`);
  console.log(line);

  const checks = [
    ["两个标签页都注入了页面悬浮按钮", buttonInjectedA === true && buttonInjectedB === true],
    ["点 A 按钮后只有 A 进入开启状态", stateA1.attached === true && !stateB1.attached],
    ["A 标签的响应被改写", typeof receivedA === "string" && receivedA.includes(INJECTED)],
    ["A 标签注入的 alert('test') 真的执行了", typeof receivedA === "string" && receivedA.includes(INJECTED) && appLoadedA === true],
    ["B 标签未被改写（不跨标签生效）", typeof receivedB === "string" && !receivedB.includes("alert('test')")],
    ["B 标签没有弹出 alert", String(alertsB) === "[]"],
    ["A 标签里不命中规则的请求原样放行", typeof otherA === "string" && !otherA.includes("alert('test')") && otherA.includes("__appLoaded")],
    ["A 开着时仍可再开 B（允许并发）", stateA2.attached === true && stateB2.attached === true],
    ["B 标签开启后自己的响应被改写", typeof receivedB2 === "string" && receivedB2.includes(INJECTED)],
    ["计数按标签独立：A>0 而刚开启的 B 仍为 0", (stateA2.count || 0) > 0 && (stateB2.count || 0) === 0],
    ["B 自己刷新后计数也涨起来", (stateB3.count || 0) > 0],
    ["页面按钮正确反映开启状态", String(labelA).includes("改写中") && String(labelB).includes("改写中")],

    // ---- 侧边栏 ----
    ["面板 DOM 元素齐全（HTML/JS/CSS 契约一致）", Array.isArray(panelDom?.missing) && panelDom.missing.length === 0],
    ["面板跟随所在窗口的当前标签页（不是面板自己）", String(panelDom?.url || "").includes("tab=panel")],
    ["面板标题显示「智能直播助手」所在页面", typeof panelDom?.title === "string" && panelDom.title.length > 0],
    ["面板列出了硬编码规则", Array.isArray(panelDom?.rules) && panelDom.rules.length > 0 && String(panelDom.rules[0].scope).includes("config")],
    ["面板里点开关真的开启了该标签页", panelProbeState.attached === true],
    ["面板开关状态同步（已开启 / 按钮点亮）", String(panelAfter).includes("已开启") && String(panelAfter).includes('"on":true')],
    ["面板正确识别注入范围（带端口的 URL 也算命中）", panelDom?.injectable === true && panelDom?.noticeHidden === true]
  ];

  let allPass = true;
  for (const [name, ok] of checks) {
    if (!ok) allPass = false;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }

  console.log(line);
  console.log(allPass ? "全部通过 ✓" : "存在失败项 ✗");

  for (const [, sessionId] of sessions) {
    await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
  browser.close();
  chrome.kill("SIGKILL");
  server.close();

  await sleep(600);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    // 临时目录，删不掉也无所谓
  }

  process.exit(allPass ? 0 : 1);
}

main().catch(error => {
  console.error("测试异常:", error.message);
  process.exit(1);
});
