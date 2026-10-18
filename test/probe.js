#!/usr/bin/env node
/**
 * probe.js —— 直播间轻量探测器（不依赖扩展）
 *
 * 用途：纯粹用 CDP 观察 live.douyin.com 页面，挖「发弹幕」这条链路。
 * 和 test/bridge.js 的区别：bridge 驱动 Livra 扩展，probe 只看页面本身。
 *
 * 用法：
 *   node test/probe.js targets              列出所有 target
 *   node test/probe.js login                看当前有没有登录抖音
 *   node test/probe.js page                 直播间页面结构（播放器/输入框/发送按钮）
 *   node test/probe.js net [秒数]           抓网络请求（含 webcast/chat/im），默认 15s
 *   node test/probe.js exec <JS>            在主世界执行一段 JS（returnByValue）
 *   node test/probe.js focus                把直播间标签拉到前台
 *   node test/probe.js shot [路径]          截图
 *   node test/probe.js watch [秒数]         持续观察输入框/发送按钮出现情况
 */

const fs = require("fs");
const path = require("path");

const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const LIVE_HINT = process.env.LIVE_HINT || "live.douyin.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // method -> callback
  }

  static async connect() {
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const client = new Cdp(ws);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`连不上 http://127.0.0.1:${CDP_PORT}，测试浏览器起了吗？`));
    });

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && client.pending.has(msg.id)) {
        const p = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const cb of client.handlers.get(msg.method) || []) cb(msg);
      }
    };

    return client;
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }

  async sessionOf(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  async target(hint = LIVE_HINT, type = "page") {
    const list = await this.send("Target.getTargets").then((r) => r.targetInfos);
    return list.find((t) => t.type === type && t.url.includes(hint));
  }

  async evalIn(targetId, expression) {
    const sessionId = await this.sessionOf(targetId);
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || "执行出错" };
    }
    return r.result.value;
  }

  close() {
    this.ws.close();
  }
}

/* ============================ 页面探针 ============================ *
 *
 * 目标：搞清楚「用户手动发一条弹幕」到底经过了哪些代码。
 *
 * 抖音发弹幕的真实请求是带 a_bogus 签名的 GET /webcast/room/chat/?...&content=xxx，
 * 自造请求必被拒，所以只能**借用页面自己的函数**。要借用就得先知道它在哪 ——
 * 做法是 hook fetch/XHR，在页面自己发请求的那一刻顺着调用栈把沿途的函数全捞出来。
 *
 * 两个坑（踩过）：
 *   1. V8 的 CallSite 只在 prepareStackTrace 回调执行期间有效，回调一返回就释放，
 *      所以 getFunction()/getThis() 必须在回调里同步调完，不能存 CallSite 回头用。
 *   2. 默认 stackTraceLimit 只有 10，而算 a_bogus 的安全 SDK 自己就占十几帧，
 *      不调大根本看不到外面的业务函数。
 * ================================================================== */

const INSTALL_PROBE_JS = String.raw`(() => {
  if (window.__probe) {
    return JSON.stringify({ already: true, reqs: window.__probe.reqs.length, ws: window.__probe.ws.length });
  }

  const p = window.__probe = {
    t0: Date.now(),
    reqs: [],        // 命中的发弹幕请求（带调用栈）
    ws: [],          // WebSocket 握手
    logs: [],
    frames: 0,
    fns: new Map()   // "文件:行:函数名" -> 函数本体，抓完可以回头直接调
  };

  Error.stackTraceLimit = 120;

  const CHAT_RE = /webcast\/room\/chat|im\/send|danmaku/i;
  const log = (m) => { p.logs.push(m); if (p.logs.length > 60) p.logs.shift(); };

  /**
   * 把任意值安全地摊平成字符串 —— 这是整个探针最关键的一步。
   *
   * 发弹幕的文本一定以某种形式躺在**某一帧的入参**里。只要能把每一帧的参数
   * 忠实快照下来，就能直接指着它说：改这个参数、调这个函数，就能发任意内容 ——
   * 全程不用碰输入框 DOM。
   *
   * 三种哨兵都有含义，别改成空串，否则分不清「本来就是空」和「读不出来」：
   *   "…深层" 超过 3 层不展开了
   *   "…循环引用" 对象自我引用
   *   "<读不了>" getter 抛异常（React 某些内部属性会）
   */
  function snapshot(value, depth, seen) {
    depth = depth || 0;
    seen = seen || new WeakSet();
    if (depth > 3) return "…深层";
    if (value === null) return "null";
    if (value === undefined) return "undefined";

    const t = typeof value;
    if (t === "string") {
      return value.length > 400 ? value.slice(0, 400) + "…(共" + value.length + "字符)" : value;
    }
    if (t === "number" || t === "boolean") return String(value);
    if (t === "function") return "f " + (value.name || "(匿名)") + "/" + value.length;
    if (t === "symbol") return String(value);

    try {
      if (value instanceof Node) return "<" + value.nodeName.toLowerCase() + ">";
      if (value instanceof Event) return "<Event " + value.type + ">";
    } catch (e) {}

    if (seen.has(value)) return "…循环引用";
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const head = value.slice(0, 8).map((v) => snapshot(v, depth + 1, seen)).join(", ");
        return "[" + head + (value.length > 8 ? ", …" : "") + "]";
      }
      const keys = Object.keys(value).slice(0, 14);
      return "{" + keys.map((k) => k + ":" + snapshot(value[k], depth + 1, seen)).join(", ") + "}";
    } catch (e) {
      return "<读不了>";
    }
  }

  /** 抓调用栈：每一帧的函数名 + 位置 + **入参快照** */
  function capture() {
    const frames = [];
    const previous = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 120;

    Error.prepareStackTrace = (_, sites) => {
      for (const site of sites) {
        const file = String(site.getFileName() || "");
        if (/agent|extensions|chrome-extension:|devtools/i.test(file)) continue;

        let name = "(匿名)";
        try { name = site.getFunctionName() || site.getFunction()?.name || "(匿名)"; } catch (e) {}

        const line = site.getLineNumber();
        const short = file.split("/").pop();

        // ⚠ CallSite 出了回调就失效，getFunction/getArguments/getThis 必须就地取完
        let fn = null, thisArg, argTexts = null;
        try { fn = site.getFunction(); } catch (e) {}
        try { thisArg = site.getThis(); } catch (e) {}
        try {
          const raw = site.getArguments && site.getArguments();
          argTexts = raw ? Array.from(raw).map((a) => snapshot(a)) : null;
        } catch (e) {}

        frames.push({ name, file: short, line, args: argTexts });

        if (typeof fn === "function") {
          const key = name + "@" + short + ":" + line;
          if (!p.fns.has(key)) p.fns.set(key, { fn, thisArg, argSnapshot: argTexts });
        }
      }
      return sites;
    };

    try { void new Error().stack; } catch (e) {}
    Error.prepareStackTrace = previous;
    Error.stackTraceLimit = limit;

    return frames.slice(0, 40);
  }

  function record(url, method, body) {
    if (!CHAT_RE.test(String(url))) return;

    let content = null;
    try { content = new URL(url, location.href).searchParams.get("content"); } catch (e) {}
    if (!content && typeof body === "string") {
      const m = /(?:^|&)content=([^&]*)/.exec(body);
      if (m) { try { content = decodeURIComponent(m[1]); } catch (e) { content = m[1]; } }
    }

    const query = String(url).split("?")[1] || "";
    p.reqs.push({
      at: Date.now(),
      method: method || "GET",
      url: String(url),
      content,
      queryKeys: [...new Set(query.split("&").map((s) => s.split("=")[0]))],
      frames: capture()
    });

    log("REQ " + (method || "GET") + " content=" + (content || "(无)"));
  }

  /* ---- XMLHttpRequest ---- */
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origXhrSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url) {
    this.__m = method;
    this.__u = String(url);
    return origOpen.apply(this, arguments);
  };
  OrigXHR.prototype.send = function (body) {
    try { record(this.__u, this.__m, typeof body === "string" ? body : null); } catch (e) {}
    return origXhrSend.apply(this, arguments);
  };

  /* ---- fetch ---- */
  const OrigFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      record(url, (init && init.method) || "GET", init && init.body);
    } catch (e) {}
    return OrigFetch.apply(this, arguments);
  };

  /* ---- WebSocket：记握手 + 数帧，二进制帧太大不存 ---- */
  const OrigWS = window.WebSocket;
  const origWSAdd = OrigWS.prototype.addEventListener;
  const origSend = OrigWS.prototype.send;

  OrigWS.prototype.send = function (data) {
    p.frames++;
    return origSend.apply(this, arguments);
  };
  OrigWS.prototype.addEventListener = function (type, listener, opts) {
    if (type === "message") {
      return origWSAdd.call(this, type, function (ev) {
        p.frames++;
        return listener.apply(this, arguments);
      }, opts);
    }
    return origWSAdd.apply(this, arguments);
  };

  function WrappedWS(url, protocols) {
    p.ws.push({ at: Date.now(), url: String(url).slice(0, 160) });
    return new OrigWS(url, protocols);
  }
  WrappedWS.prototype = OrigWS.prototype;
  Object.defineProperty(WrappedWS, "name", { value: "WebSocket", configurable: true });
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    try { WrappedWS[k] = OrigWS[k]; } catch (e) {}
  }
  window.WebSocket = WrappedWS;

  return JSON.stringify({ installed: true, note: "已 hook fetch / XHR / WebSocket，等待你手动发一条弹幕" });
})()`;

/* ============================ 发送链路静态探查 ============================ *
 * 不发弹幕、只读地摸清 ①界面 → ②页面JS → ③网络 三层：
 *   - contenteditable 输入框在哪、被谁包着
 *   - React fiber 上挂着哪些回调（发送逻辑就藏在这里）
 *   - a_bogus 签名由哪个 SDK 提供
 * ================================================================== */

const DIG_UI_JS = String.raw`(() => {
  const out = {编辑器: null, 祖先链: [], 发送回调: [], 签名SDK: [], 其它线索: {}};

  /* ---------- ① 输入框 ---------- */
  const editor = document.querySelector('[contenteditable="true"]');
  if (!editor) return JSON.stringify({ 错误: "没找到 contenteditable 输入框" });

  const r = editor.getBoundingClientRect();
  out.编辑器 = {
    tag: editor.tagName.toLowerCase(),
    cls: String(editor.className).slice(0, 90),
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    contenteditable: editor.getAttribute("contenteditable"),
    富文本库: String(editor.className).includes("editor-kit") ? "editor-kit（字节自研）" : "未知"
  };

  // 往上爬 6 层，看输入框被什么容器包着（能看出是哪个业务组件）
  let el = editor.parentElement;
  for (let i = 0; el && i < 6; i++) {
    const er = el.getBoundingClientRect();
    out.祖先链.push({
      层: i,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 80),
      e2e: el.getAttribute("data-e2e") || "",
      rect: [Math.round(er.width), Math.round(er.height)]
    });
    el = el.parentElement;
  }

  /* ---------- ② React fiber：发送回调就挂在 fiber.props 上 ---------- */
  // React 同时挂两个键：__reactFiber$（组件树节点）、__reactProps$（绑在上面的 props）
  const fbKey = Object.keys(editor).find((k) => k.startsWith("__reactFiber$"));
  const psKey = Object.keys(editor).find((k) => k.startsWith("__reactProps$"));

  if (psKey) {
    const props = editor[psKey];
    for (const [k, v] of Object.entries(props)) {
      if (typeof v !== "function") continue;
      out.发送回调.push({
        来源: "输入框自身props",
        键: k,
        函数名: v.name || "(匿名)",
        参数个数: v.length,
        函数体片段: String(v).slice(0, 120)
      });
    }
  }

  // 顺着 fiber.return 往上翻 25 层，收集所有名字/函数体像发送的回调
  const fiber = fbKey ? editor[fbKey] : null;
  if (fiber) {
    const HINT = /send|comment|chat|danmaku|submit|post|emit|key/i;
    const seen = new Set();
    let node = fiber, depth = 0;
    while (node && depth < 25) {
      const props = node.memoizedProps;
      if (props && typeof props === "object") {
        for (const [k, v] of Object.entries(props)) {
          if (typeof v !== "function" || k.startsWith("__")) continue;
          let body = "";
          try { body = String(v); } catch (e) { continue; }

          // 名字像发送，或者函数体里提到了发弹幕的接口
          const 命中 = HINT.test(k) || HINT.test(v.name || "") || /room\/chat|sendComment|danmaku/i.test(body.slice(0, 4000));
          if (!命中) continue;
          if (seen.has(v)) continue;
          seen.add(v);

          out.发送回调.push({
            来源: "fiber↑" + depth,
            键: k,
            函数名: v.name || "(匿名)",
            参数个数: v.length,
            提到发弹幕接口: /room\/chat|sendComment|danmaku/i.test(body.slice(0, 4000)),
            函数体片段: body.slice(0, 160)
          });
        }
      }
      node = node.return;
      depth++;
    }
  } else {
    out.其它线索.fiber = "没读到 React fiber 键";
  }

  /* ---------- 签名 SDK：a_bogus 是它算的 ---------- */
  const 可疑键 = Object.keys(window).concat(Object.getOwnPropertyNames(window));
  const KEY_RE = /acrawler|signature|secsdk|bdms|slardar|msToken|monitor|captain|security|webmssdk|abogus|a_bogus/i;
  out.签名SDK = [...new Set(可疑键)].filter(k => KEY_RE.test(k)).map(k => {
    let 类型 = typeof window[k];
    let 成员 = [];
    try {
      if (window[k] && typeof window[k] === "object") {
        成员 = Object.keys(window[k]).slice(0, 12);
      }
    } catch (e) {}
    return { 全局名: k, 类型, 成员 };
  });

  /* ---------- 其它：script 里的安全域名、请求工具 ---------- */
  out.其它线索.script域名 = [...new Set([...document.querySelectorAll("script[src]")]
    .map(s => { try { return new URL(s.src).host; } catch (e) { return ""; } })
    .filter(Boolean))].slice(0, 14);
  out.其它线索.有空WebSocket个数 = 0;

  return JSON.stringify(out, null, 1);
})()`;

const show = (label, value) => {
  if (typeof value === "string") console.log(`${label}: ${value}`);
  else console.log(`${label}:\n${JSON.stringify(value, null, 1)}`);
};

/* ============================ 命令 ============================ */

const commands = {
  async targets() {
    const cdp = await Cdp.connect();
    const list = await cdp.send("Target.getTargets").then((r) => r.targetInfos);
    for (const t of list) {
      console.log(`${t.type.padEnd(14)} ${t.title.slice(0, 34).padEnd(36)} ${t.url.slice(0, 90)}`);
    }
    cdp.close();
  },

  /** 抖音有没有登录：看 cookie 里的关键字段 + 页面上有没有登录入口 */
  async login() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    show("页面", await cdp.evalIn(live.targetId, `JSON.stringify({
      url: location.href,
      hasLoginBtn: !![...document.querySelectorAll('*')].find(e => /登录/.test(e.textContent||'') && e.children.length===0),
      avatarFound: !!document.querySelector('[class*="avatar"], [data-e2e*="avatar"]')
    }, null, 1)`));

    // getCookies 必须在 page session 上发，browser-level session 没有这个域
    const sessionId = await cdp.sessionOf(live.targetId);
    const cookies = await cdp.send("Network.getCookies", {
      urls: ["https://live.douyin.com/", "https://www.douyin.com/", "https://.douyin.com/"],
    }, sessionId);
    const KEY = ["sessionid", "sessionid_ss", "sid_tt", "passport_csrf_token", "ttwid", "msToken", "odin_tt", "uid_tt", "sid_guard"];
    show("关键 cookie", cookies.cookies
      .filter((c) => KEY.includes(c.name))
      .map((c) => `${c.name} = ${String(c.value).slice(0, 14)}${c.value.length > 14 ? "…" : ""}  (${c.domain})`));

    const logged = KEY.filter((k) => cookies.cookies.some((c) => c.name === k));
    console.log(`\n判定：${logged.length >= 2 ? "✅ 已登录" : "❌ 未登录 —— 需要在窗口里扫码登录"}（${logged.join(", ") || "无"}）`);
    cdp.close();
  },

  /** 直播间页面结构：找输入框和发送按钮 */
  async page() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    show("结构", await cdp.evalIn(live.targetId, `(() => {
      const desc = el => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 70),
          e2e: el.getAttribute('data-e2e') || '',
          ph: el.getAttribute('placeholder') || '',
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          visible: !!(el.offsetParent || el.getClientRects().length)
        };
      };
      const editors = [...document.querySelectorAll('[contenteditable="true"]')].map(desc);
      const inputs = [...document.querySelectorAll('input, textarea')].filter(e=>e.offsetParent).map(desc);
      const btns = [...document.querySelectorAll('button, [role="button"]')]
        .map(e => ({...desc(e), text: (e.textContent||'').trim().slice(0,14)}))
        .filter(b => /发送|发表|评论|聊天|说点|弹幕|聊聊/.test(b.text));
      return JSON.stringify({
        title: document.title,
        url: location.href,
        isLive: !!document.querySelector('video'),
        websocketsSeen: typeof window.__LIVRA_WS_COUNT__,
        editors, inputs, sendButtons: btns
      }, null, 1);
    })()`));
    cdp.close();
  },

  /** 只读摸清 ①界面 → ②页面JS → ③网络（不发弹幕） */
  async ui() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");
    console.log(await cdp.evalIn(live.targetId, DIG_UI_JS));
    cdp.close();
  },

  /** 顺着 React fiber 往上爬，看「发送」回调挂在哪个组件上 */
  async chain(depth = "30") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(editor).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      const nameOf = (node) => {
        const t = node.type;
        if (!t) return node.tag === 6 ? "(文本)" : "(?)";
        if (typeof t === "string") return t;
        if (typeof t === "function") return t.displayName || t.name || "(匿名函数组件)";
        if (typeof t === "object") return t.displayName || t.name || "forwardRef/memo";
        return "(?)";
      };

      const SEND_HINT = /onSend|sendMessage|handleSend|onConfirm|onSubmit|onEnter|setInputVal/i;
      const rows = [];
      let node = editor[fbKey], depth = 0;
      const max = ${Number(depth) || 30};

      while (node && depth < max) {
        const props = node.memoizedProps;
        const fnKeys = [], sends = [];
        if (props && typeof props === "object") {
          for (const k of Object.keys(props)) {
            if (typeof props[k] !== "function") continue;
            fnKeys.push(k);
            if (SEND_HINT.test(k)) sends.push(k + "(" + props[k].length + ")");
          }
        }
        rows.push({
          层: depth,
          组件: nameOf(node),
          回调: fnKeys.slice(0, 14),
          发送类: sends
        });
        node = node.return;
        depth++;
      }
      return JSON.stringify(rows, null, 1);
    })()`));
    cdp.close();
  },

  /** 抓网络：WebSocket 握手 + webcast/chat 请求 */
  async net(sec = "15") {
    const seconds = Number(sec) || 15;
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    const sessionId = await cdp.sessionOf(live.targetId);
    await cdp.send("Network.enable", {}, sessionId);

    const hits = [];
    cdp.on("Network.requestWillBeSent", (m) => {
      const u = m.params.request.url;
      if (/webcast|danmaku|chat|im\/|room\//i.test(u)) {
        hits.push({ at: Date.now(), phase: "REQ", type: m.params.type, url: u.slice(0, 240), method: m.params.request.method });
      }
    });
    cdp.on("Network.webSocketCreated", (m) => {
      hits.push({ at: Date.now(), phase: "WS_OPEN", url: m.params.url.slice(0, 240) });
    });
    cdp.on("Network.responseReceived", (m) => {
      const u = m.params.response.url;
      if (/webcast|chat\/\?|room\/chat/i.test(u)) {
        hits.push({ at: Date.now(), phase: "RES", status: m.params.response.status, url: u.slice(0, 240) });
      }
    });

    console.log(`监听 ${seconds}s…（现在可以去窗口里手动发一条弹幕）`);
    await sleep(seconds * 1000);

    const t0 = hits.length ? hits[0].at : Date.now();
    for (const h of hits) {
      const { at, phase, ...rest } = h;
      console.log(`[+${((at - t0) / 1000).toFixed(1)}s] ${phase.padEnd(8)} ${JSON.stringify(rest)}`);
    }
    console.log(`\n共 ${hits.length} 条`);
    cdp.close();
  },

  async exec(expr) {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");
    show("结果", await cdp.evalIn(live.targetId, expr));
    cdp.close();
  },

  async focus() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    const sessionId = await cdp.sessionOf(live.targetId);
    await cdp.send("Page.bringToFront", {}, sessionId);
    await sleep(600);
    show("焦点", await cdp.evalIn(live.targetId, `JSON.stringify({hasFocus: document.hasFocus()})`));
    cdp.close();
  },

  /** 轮询等直播间 UI 就绪 */
  async watch(sec = "30") {
    const seconds = Number(sec) || 30;
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    for (let i = 0; i < seconds; i++) {
      const st = await cdp.evalIn(live.targetId, `JSON.stringify({
        ready: document.readyState,
        video: !!document.querySelector('video'),
        editors: document.querySelectorAll('[contenteditable="true"]').length,
        bodyLen: document.body.innerText.length
      })`);
      console.log(`${i}s ${st}`);
      const parsed = JSON.parse(st);
      if (parsed.video && parsed.editors) {
        console.log("✅ 直播间 UI 就绪（播放器 + 输入框都在）");
        break;
      }
      await sleep(1000);
    }
    cdp.close();
  },

  /** 把窗口放大到能露出右侧聊天区（输入框在右栏，窄窗口会被挤出视口） */
  async window(width = "1560", height = "980", left = "30", top = "20") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: live.targetId });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: Number(width), height: Number(height), left: Number(left), top: Number(top), windowState: "normal" },
    });

    await sleep(1000);
    // 直播间 UI 是按初始宽度算的，改完尺寸要重载一次才肯重排
    await cdp.send("Page.reload", {}, await cdp.sessionOf(live.targetId));
    console.log("重载页面，等 UI 就绪…");
    await sleep(7000);

    show("调整后", await cdp.evalIn(live.targetId, `JSON.stringify({
      viewport: [innerWidth, innerHeight],
      editorRect: (() => {
        const e = document.querySelector('[contenteditable="true"]');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      })(),
      editorInView: (() => {
        const e = document.querySelector('[contenteditable="true"]');
        if (!e) return false;
        const r = e.getBoundingClientRect();
        return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
      })()
    })`));
    cdp.close();
  },

  /**
   * 注入探针：hook fetch / XMLHttpRequest / WebSocket，把所有带 content 的
   * webcast/room/chat 请求连同**调用栈**一起记下来。
   * 这样用户手动发一条弹幕时，我们能看到完整的调用链。
   */
  async arm() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    const r = await cdp.evalIn(live.targetId, INSTALL_PROBE_JS);
    show("探针已装", r);
    cdp.close();
  },

  /** 读出探针记录到的东西 */
  async catch(cmd = "all") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    if (cmd === "clear") {
      show("已清空", await cdp.evalIn(live.targetId, `(() => {
        if (!window.__probe) return "探针没装";
        window.__probe.logs.length = 0; window.__probe.reqs.length = 0;
        window.__probe.ws.length = 0; window.__probe.frames = 0;
        return "ok";
      })()`));
      cdp.close();
      return;
    }

    const data = await cdp.evalIn(live.targetId, `(() => {
      if (!window.__probe) return JSON.stringify({ error: "探针没装，先跑 arm" });
      const p = window.__probe;
      const fmt = (f) => f.frames.map((fr, i) =>
        "  #" + String(i).padStart(2) + " " + fr.name + "  " + fr.file + ":" + fr.line +
        (fr.args && fr.args.length ? "\n      入参 " + fr.args.map((a) =>
          typeof a === "string" && a.length > 160 ? JSON.stringify(a.slice(0, 160)) + "…" : JSON.stringify(a)
        ).join("\n           ") : "")
      ).join("\n");

      return JSON.stringify({
        reqs: p.reqs.map(x => ({
          t: ((x.at - p.t0) / 1000).toFixed(2) + "s",
          method: x.method,
          content: x.content,
          urlHead: x.url.split("?")[0],
          queryKeys: x.queryKeys,
          fullUrl: x.url.length > 400 ? x.url.slice(0, 400) + "…" : x.url,
          frames: fmt(x)
        })),
        wsFrames: p.frames,
        wsOpens: p.ws,
        logs: p.logs
      }, null, 1);
    })()`);
    console.log(data);
    cdp.close();
  },

  /** 持续盯着，直到探针抓到一条带 content 的发送请求（或超时） */
  /**
   * 在抓到的调用栈里找：指定文本出现在哪些帧的**哪个参数**里。
   * 这是「不改输入框、直接调字节函数发任意内容」的关键证据 ——
   * 谁的参数里带着待发的文本，谁就是我们可以复用的入口。
   */
  async "find-content"(text) {
    if (!text) throw new Error("用法：node test/probe.js find-content <刚才发出的文本>");
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      if (!window.__probe) return JSON.stringify({ error: "探针没装/没抓到，先 arm 再手动发一条" });
      const target = ${JSON.stringify(text)};
      const encoded = encodeURIComponent(target);
      const hits = [];

      for (const req of window.__probe.reqs) {
        for (let i = 0; i < req.frames.length; i++) {
          const f = req.frames[i];
          if (!f.args) continue;
          const where = [];
          f.args.forEach((a, idx) => {
            if (typeof a === "string" && (a === target || a.includes(target) || a.includes(encoded))) {
              where.push("参数[" + idx + "] = " + JSON.stringify(a.length > 200 ? a.slice(0, 200) + "…" : a));
            }
          });
          if (where.length) {
            hits.push({
              帧序号: i,
              函数: f.name,
              位置: f.file + ":" + f.line,
              参数个数: f.args.length,
              命中: where
            });
          }
        }
      }

      return JSON.stringify({
        查找文本: target,
        抓到的请求数: window.__probe.reqs.length,
        命中帧: hits
      }, null, 1);
    })()`));
    cdp.close();
  },

  /**
   * dump 出 fiber 上「发送 / 写入」相关的候选函数的源码。
   * 纯读取，无副作用 —— 用来判断这些函数到底接不接受参数。
   *
   * ⚠ fn.length === 0 有两种可能：一种是真的不接参数，另一种是用了
   *   rest 参数（(...args)=>）或箭头函数默认值，length 也算 0。
   *   所以必须看源码才能判断能不能传值进去。
   */
  async hooks() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(editor).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      const WANT = /^(onSend|setInputVal|onChange|onClickTextArea|getHistoryData)$/;
      const found = [];
      let node = editor[fbKey], depth = 0;

      while (node && depth < 32) {
        const props = node.memoizedProps;
        if (props && typeof props === "object") {
          for (const k of Object.keys(props)) {
            if (!WANT.test(k)) continue;
            if (typeof props[k] !== "function") continue;
            if (found.some(f => f.fn === props[k])) continue;   // 同一个函数只留最深的
            found.push({ depth, key: k, fn: props[k] });
          }
        }
        node = node.return;
        depth++;
      }

      const MAPKEY = new Map();
      found.forEach((f, i) => { if (!MAPKEY.has(f.fn)) MAPKEY.set(f.fn, "__fn" + i); });
      // 挂到 window 上，后面的 dry-run 能直接引用
      window.__probeHooks = found.map(f => ({ key: f.key, depth: f.depth, fn: f.fn }));

      return JSON.stringify(found.map(f => ({
        key: f.key,
        depth: f.depth,
        参数个数: f.fn.length,
        源码: String(f.fn).replace(/\s+/g, " ").slice(0, 420)
      })), null, 1);
    })()`));
    cdp.close();
  },

  /**
   * 穿透一层包装：找出 onSend / setInputVal 内部真正干活的函数。
   *
   * 原理（看 dump 出来的源码就明白了）：
   *   setInputVal 是 `function(){ ... return t.current.apply(this, e) }`
   *     → 真身是闭包里的 t.current，拿不到，但**一定会经过 Function.prototype.apply**
   *   onSend(depth 11) 是 `... return e.apply(void 0, …)`
   *     → 真身是闭包里的 e，同理
   * 所以临时挂一层 Function.prototype.apply，同步调一次包装函数，
   * 就能把内层真身连同它收到的参数全部拷出来 —— 全程在内存里，不碰 DOM。
   *
   * 同时把 fetch / XHR 拦下来，保证**真的测试弹幕不会飞出去**。
   */
  async peek(which = "setInputVal", text = "LIVRA探针AAA") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const TAG = ${JSON.stringify(text)};
      const out = { 候选: [], 抓到调用: [], 拦截到URL: [] };

      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(editor).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      // 注意边界：这里**只 hook 业务层的发送函数**，绝不碰 byted_acrawler /
      // secsdk / securitySDK 这类安全 SDK。理由：
      //   1. 它们是风控资产，被 patch 可能当场判定环境异常，甚至连号一起限制；
      //   2. 也没必要 —— 签名对不对，看最终 URL 就能反推出来（见 README 里的结论）。
      // 整个探测保持在「借用页面自己的业务函数」这个层面上。

      const found = [];
      let node = editor[fbKey], depth = 0;
      while (node && depth < 32) {
        const props = node.memoizedProps;
        if (props && typeof props === "object") {
          for (const k of ["onSend", "setInputVal"]) {
            if (typeof props[k] !== "function") continue;
            if (found.some(f => f.fn === props[k])) continue;
            found.push({ depth, key: k, fn: props[k] });
          }
        }
        node = node.return; depth++;
      }
      out.候选 = found.map(f => ({ depth: f.depth, key: f.key, 参数个数: f.fn.length }));

      const want = ${JSON.stringify(which)};
      const target = found.find(f => f.key === want) || found[0];
      if (!target) return JSON.stringify({ error: "没找到候选函数" });
      out.本次调用 = { key: target.key, depth: target.depth };

      /* ---- 拦截：命中 /webcast/room/chat/ 的请求一律不许真的发出 ---- */
      const CHAT = /webcast\/room\/chat/i;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;

      XMLHttpRequest.prototype.send = function (body) {
        if (this.__u && CHAT.test(this.__u)) { out.拦截到URL.push(this.__u.slice(0, 260)); return; }
        return origSend.apply(this, arguments);
      };
      window.fetch = function (input, init) {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (CHAT.test(u)) {
          out.拦截到URL.push(u.slice(0, 260));
          return Promise.resolve(new Response('{"status_code":0}', {
            status: 200, headers: { "content-type": "application/json" }
          }));
        }
        return origFetch.apply(this, arguments);
      };

      /* ---- 临时挂在 apply 上，捞出内层真身 ---- */
      const origApply = Function.prototype.apply;
      Function.prototype.apply = function (thisArg, argsArray) {
        try {
          if (typeof this === "function" && out.抓到调用.length < 30) {
            const argShow = argsArray
              ? Array.from(argsArray).slice(0, 5).map(a => {
                  if (typeof a === "string") return a.length > 70 ? '"' + a.slice(0, 70) + '…"' : '"' + a + '"';
                  if (a === null) return "null";
                  if (a === undefined) return "undefined";
                  if (typeof a === "object") {
                    try { return "{" + Object.keys(a).slice(0, 6).join(",") + "}"; } catch (e) { return "{?}"; }
                  }
                  return String(a);
                }).join(", ")
              : "(null)";

            out.抓到调用.push({
              内层函数: this.name || "(匿名)",
              内层参数个数: (argsArray && argsArray.length) || 0,
              收到实参: argShow,
              thisArg类型: thisArg === undefined ? "undefined" : thisArg === null ? "null" : typeof thisArg,
              thisArg方法: thisArg && typeof thisArg === "object"
                ? Object.getOwnPropertyNames(thisArg).slice(0, 12) : [],
              内层源码: String(this).replace(/\s+/g, " ").slice(0, 220)
            });
          }
        } catch (e) {}
        return origApply.call(this, thisArg, argsArray);
      };

      let callErr = null;
      let retType = "";
      try {
        const ret = target.fn(TAG);
        retType = ret && typeof ret.then === "function" ? "Promise（异步）" : typeof ret;
      } catch (e) {
        callErr = String(e && e.message || e);
      }
      Function.prototype.apply = origApply;   // 立刻还原，窗口越短越好

      await new Promise(r => setTimeout(r, 1500));

      window.fetch = origFetch;
      XMLHttpRequest.prototype.send = origSend;

      out.返回值 = retType;
      out.调用是否抛错 = callErr;
      out.输入框当前文本 = editor.textContent;
      return JSON.stringify(out, null, 1);
    })()`));
    cdp.close();
  },

  /**
   * 找出 editor-kit 的编辑器实例 —— 这是「不碰 DOM 改内容」的关键钥匙。
   *
   * 从 peek 抓到的源码可以确认实例上有这些方法（n 就是实例）：
   *   n.getContent()                     读内容（delta 格式）
   *   n.getContentState() / .apply(delta) 直接改内容模型
   *   n.execCommand(cmd, payload)        执行编辑命令
   *   n.flushInput()                     把挂起的输入落进模型
   *   n.undoModule.batchedUndo(fn)       批量包一层，避免污染撤销栈
   *
   * 拿到它就能做到：读/写内容全部走实例 API，一次 DOM 都不碰，
   * 也不依赖 focus、不需要 execCommand("insertText")、不用 sleep 220ms。
   *
   * 扫描位置：hooks 链表（含 ref 的 .current）、类组件的 stateNode，
   * 以及 fiber props 里 register 之类的回调（趁沙箱不脏的时候）。
   */
  async editor() {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const KEYS = ["getContent", "execCommand", "getContentState", "flushInput", "undoModule"];
      const isEditor = (o) => {
        if (!o || typeof o !== "object") return false;
        let hit = 0;
        for (const k of KEYS) { try { if (typeof o[k] === "function") hit++; } catch (e) {} }
        return hit >= 3;
      };

      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(ed).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      const found = [];
      const seen = new Set();
      const remember = (obj, via, depth) => {
        if (!isEditor(obj) || seen.has(obj)) return;
        seen.add(obj);
        found.push({ via, depth, obj });
      };

      let node = ed[fbKey], depth = 0;
      while (node && depth < 40) {
        // hooks 链表
        let hook = node.memoizedState, hi = 0;
        while (hook && hi < 50) {
          const v = hook.memoizedState;
          remember(v, "hook[" + hi + "]", depth);
          try { if (v && typeof v === "object" && "current" in v) remember(v.current, "ref.current hook[" + hi + "]", depth); } catch (e) {}
          hook = hook.next; hi++;
        }
        // 类组件实例
        try { remember(node.stateNode, "stateNode", depth); } catch (e) {}
        node = node.return; depth++;
      }

      if (!found.length) return JSON.stringify({ 结论: "没扫到 editor 实例", 扫描层数: depth });

      // 把找到的实例挂到 window，后续可以直接用 __livraEditor 操作
      window.__probeEditor = found[0].obj;

      return JSON.stringify({
        找到实例数: found.length,
        详情: found.map(f => ({
          位置: f.via,
          fiber深度: f.depth,
          方法: (() => {
            const names = new Set();
            let o = f.obj;
            for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
              for (const k of Object.getOwnPropertyNames(p)) {
                try { if (typeof o[k] === "function") names.add(k); } catch (e) {}
              }
            }
            return [...names].slice(0, 46);
          })()
        })),
        已挂到: "window.__probeEditor",
        当前内容文本: (() => {
          try { return JSON.stringify(String(found[0].obj.getContent()).slice(0, 200)); } catch (e) { return "getContent 失败: " + e.message; }
        })()
      }, null, 1);
    })()`));
    cdp.close();
  },

  /**
   * 干跑（dry-run）一次「不碰 DOM 的发弹幕」：
   *   1. 用 editor-kit 实例的 setContent() 写内容（官方编程 API，不是 DOM hack）
   *   2. 调 fiber 上的 onSend()
   *   3. 在网络层拦下来，**保证弹幕真的不会飞出去**
   *   4. 回报这次被拦下来的 URL —— 里面的 content / a_bogus 就是签名阶段的证据
   *
   * ⚠ 只 hook 业务层（editor 实例 + onSend + fetch/XHR），不碰任何安全 SDK。
   */
  /**
   * 试出 editor 实例「写内容」的正确姿势。
   * setContent 不接受裸字符串（试过了，DOM 纹丝不动），它要的是 delta /
   * content-state 这类结构化入参。这里把候选格式挨个试一遍，看谁能让 DOM 真的变。
   */
  async edapi(text = "LIVRA写内容测试") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const TAG = ${JSON.stringify(text)};
      const out = {};

      let inst = window.__probeEditor;
      if (!inst) {
        const ed = document.querySelector('[contenteditable="true"]');
        const fbKey = ed && Object.keys(ed).find(k => k.startsWith("__reactFiber$"));
        if (!fbKey) return JSON.stringify({ error: "没找到 editor 实例，先跑 probe.js editor" });
        const KEYS = ["getContent", "execCommand", "getContentState", "flushInput", "undoModule"];
        const isEd = (o) => { let h = 0; for (const k of KEYS) { try { if (o && typeof o[k] === "function") h++; } catch (e) {} } return h >= 3; };
        let n = ed[fbKey], d = 0;
        while (n && d < 40 && !inst) {
          let hook = n.memoizedState, hi = 0;
          while (hook && hi < 50) {
            const v = hook.memoizedState;
            if (isEd(v)) { inst = v; break; }
            try { if (v && "current" in v && isEd(v.current)) { inst = v.current; break; } } catch (e) {}
            hook = hook.next; hi++;
          }
          n = n.return; d++;
        }
        if (inst) window.__probeEditor = inst;
      }
      if (!inst) return JSON.stringify({ error: "扫不到 editor 实例" });

      const ed = document.querySelector('[contenteditable="true"]');
      out.方法源码 = {};
      for (const m of ["setContent", "setHTML", "getContent", "execCommand"]) {
        try { out.方法源码[m] = String(inst[m]).replace(/\s+/g, " ").slice(0, 260); } catch (e) { out.方法源码[m] = "读不到"; }
      }

      const read = () => {
        let g = null;
        try { g = inst.getContent(); } catch (e) { g = "getContent 失败"; }
        return {
          DOM文本: (ed.textContent || "").replace(/\u200b/g, "").slice(0, 60),
          getContent类型: Array.isArray(g) ? "array" : typeof g,
          getContent摘要: (() => {
            try {
              if (Array.isArray(g)) return JSON.stringify(g).slice(0, 160);
              if (g && typeof g === "object") return "{" + Object.keys(g).slice(0, 8).join(",") + "}";
              return String(g).slice(0, 100);
            } catch (e) { return "读不了"; }
          })()
        };
      };

      out.尝试前 = read();
      out.尝试 = [];

      const trials = [
        ["setContent(字符串)", () => inst.setContent(TAG)],
        ["setContent(delta数组)", () => inst.setContent([{ insert: TAG }])],
        ["setHTML(字符串)", () => inst.setHTML(TAG)],
        ["setHTML(带标签)", () => inst.setHTML("<p>" + TAG + "</p>")],
        ["execCommand(setContent,字符串)", () => inst.execCommand("setContent", TAG)],
        ["getContentState().apply+insertText", () => {
          try {
            const st = inst.getContentState();
            // 先清空再写：用实例自己的 selection + apply
            const sel = inst.selection && inst.selection.getSelection && inst.selection.getSelection();
            return "getContentState keys=" + Object.keys(st).slice(0, 10).join(",") + " sel=" + (sel ? Object.keys(sel).slice(0, 6).join(",") : "无");
          } catch (e) { return "失败: " + e.message; }
        }]
      ];

      for (const [label, fn] of trials) {
        let r = null, err = null;
        try { r = fn(); } catch (e) { err = String(e && e.message || e); }
        await new Promise(res => setTimeout(res, 350));
        const after = read();
        out.尝试.push({
          方式: label,
          抛错: err,
          返回值: typeof r === "string" ? r.slice(0, 150) : String(r).slice(0, 150),
          DOM是否变化: after.DOM文本 !== out.尝试前.DOM文本,
          写入后DOM: after.DOM文本,
          写入目标态: after.DOM文本 === TAG
        });
      }

      // 收尾：把输入框清干净，别把测试痕迹留在人家直播间
      try {
        inst.setContent([]);
        await new Promise(res => setTimeout(res, 300));
      } catch (e) {}
      out.收尾后DOM = (ed.textContent || "").replace(/\u200b/g, "").slice(0, 60);

      return JSON.stringify(out, null, 1);
    })()`));
    cdp.close();
  },

  async trysend(text = "LIVRA干跑测试") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const TAG = ${JSON.stringify(text)};
      const out = { 步骤: [], 拦到的请求: [] };

      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(ed).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      /* ---- 找 editor 实例 ---- */
      const KEYS = ["getContent", "execCommand", "getContentState", "flushInput", "undoModule"];
      const isEditor = (o) => {
        if (!o || typeof o !== "object") return false;
        let hit = 0;
        for (const k of KEYS) { try { if (typeof o[k] === "function") hit++; } catch (e) {} }
        return hit >= 3;
      };

      let editorInst = null;
      let node = ed[fbKey], depth = 0;
      while (node && depth < 40 && !editorInst) {
        let hook = node.memoizedState, hi = 0;
        while (hook && hi < 50) {
          const v = hook.memoizedState;
          if (isEditor(v)) { editorInst = v; break; }
          try { if (v && typeof v === "object" && "current" in v && isEditor(v.current)) { editorInst = v.current; break; } } catch (e) {}
          hook = hook.next; hi++;
        }
        node = node.return; depth++;
      }

      if (!editorInst) {
        if (window.__probeEditor) { editorInst = window.__probeEditor; out.步骤.push("复用上次扫到的实例"); }
        else return JSON.stringify({ error: "没找到 editor 实例，先跑 probe.js editor" });
      } else {
        window.__probeEditor = editorInst;
        out.步骤.push("扫到 editor 实例 @ fiber深度" + depth);
      }

      /* ---- 找 onSend ---- */
      let node2 = ed[fbKey], d2 = 0, onSend = null;
      while (node2 && d2 < 40) {
        const props = node2.memoizedProps;
        if (props && typeof props.onSend === "function") { onSend = props.onSend; break; }
        node2 = node2.return; d2++;
      }
      if (!onSend) return JSON.stringify({ error: "没找到 onSend" });
      out.步骤.push("找到 onSend @ fiber深度" + d2);

      /* ---- 拦截网络：命中 /webcast/room/chat/ 一律不许真发 ---- */
      const CHAT = /webcast\/room\/chat/i;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;

      XMLHttpRequest.prototype.send = function (body) {
        if (this.__u && CHAT.test(this.__u)) {
          out.拦到的请求.push({ via: "xhr", url: this.__u, body: typeof body === "string" ? body.slice(0, 120) : null });
          return;
        }
        return origSend.apply(this, arguments);
      };
      window.fetch = function (input, init) {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (CHAT.test(u)) {
          out.拦到的请求.push({ via: "fetch", url: u });
          return Promise.resolve(new Response('{"status_code":0}', { status: 200, headers: { "content-type": "application/json" } }));
        }
        return origFetch.apply(this, arguments);
      };
      out.步骤.push("网络拦截已装 —— 这条弹幕不会真的发出去");

      /* ---- ① 用实例 API 写内容，不碰 DOM ---- *
       * 实测（见 edapi）：setContent(字符串) 和 setContent(delta数组) 都无效，
       * 能生效的是 execCommand("setContent", text) 和 setHTML(text)。
       * 优先走 execCommand —— 那是 editor-kit 对外暴露的官方命令接口。
       */
      out.写入前DOM = (ed.textContent || "").replace(/\u200b/g, "").slice(0, 60);
      out.写入方式 = [];
      const writers = [
        ["execCommand(setContent)", () => editorInst.execCommand("setContent", TAG)],
        ["setHTML", () => editorInst.setHTML(TAG)]
      ];
      for (const [label, fn] of writers) {
        try {
          fn();
          await new Promise(r => setTimeout(r, 400));
          const now = (ed.textContent || "").replace(/\u200b/g, "").slice(0, 60);
          const ok = now === TAG;
          out.写入方式.push({ 方式: label, 生效: ok, DOM: now });
          if (ok) break;
        } catch (e) {
          out.写入方式.push({ 方式: label, 生效: false, 抛错: String(e && e.message || e) });
        }
      }
      out.步骤.push("已用实例 API 写入内容");
      out.DOM侧文本 = (ed.textContent || "").replace(/\u200b/g, "").slice(0, 60);

      /* ---- ② 调发送 ---- */
      let err = null;
      try {
        const ret = onSend();
        out.onSend返回 = ret && typeof ret.then === "function" ? "Promise" : typeof ret;
      } catch (e) { err = String(e && e.message || e); }
      out.onSend错误 = err;

      await new Promise(r => setTimeout(r, 2500));

      XMLHttpRequest.prototype.send = origSend;
      window.fetch = origFetch;
      out.步骤.push("网络拦截已还原");

      /* ---- ③ 汇报：URL 里 content 和 a_bogus 都在，就证明了签名发生在 content 确定之后 ---- */
      out.分析 = out.拦到的请求.map(r => {
        let content = null;
        try { content = new URL(r.url, location.href).searchParams.get("content"); } catch (e) {}
        const ab = /[?&]a_bogus=([^&]*)/.exec(r.url);
        return {
          via: r.via,
          content,
          content等于本次文本: content === TAG,
          a_bogus: ab ? ab[1].slice(0, 20) + "…(共" + ab[1].length + "字符)" : "(无)",
          全部参数名: [...new Set((r.url.split("?")[1] || "").split("&").map(s => s.split("=")[0]))]
        };
      });

      return JSON.stringify(out, null, 1);
    })()`));
    cdp.close();
  },

  async reload(waitMs = "8000") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");
    await cdp.send("Page.reload", {}, await cdp.sessionOf(live.targetId));
    console.log(`页面已重载，等 ${Number(waitMs) / 1000}s 让直播间 UI 起来…`);
    await sleep(Number(waitMs));
    show("状态", await cdp.evalIn(live.targetId, `JSON.stringify({
      video: !!document.querySelector('video'),
      editor: !!document.querySelector('[contenteditable="true"]'),
      editorText: (document.querySelector('[contenteditable="true"]')?.textContent || "").replace(/\\u200b/g, "").slice(0, 40)
    })`));
    cdp.close();
  },

  /**
   * 终极验证：用 editor 实例 API 写内容（不碰 DOM）→ 用 CDP 发一个**真实**的回车
   * （isTrusted=true，和真人按键完全一样）→ 在网络层拦下来不让真发出去。
   *
   * 这样拿到的是一条**页面完全自愿产生的请求**，它的 content 和 a_bogus 都是真的，
   * 足以判断「内容是在签名之前还是之后被确定下来的」。
   *
   * ⚠ 仍然严格限制在业务层：editor 实例 + fetch/XHR。不碰 byted_acrawler 等安全 SDK。
   */
  /**
   * 源码优先：把 onSend 内部真正干活的那个 `e` 钓出来。
   *
   * 依据（来自 depth-11 onSend 的编译产物）：
   *   [4, e.apply(void 0, (0,r.ev)([], (0,r.CR)(i), !1))]
   * 即：arguments 原样透传给 e，且 this 恒为 undefined。
   * 所以只要临时挂一层 Function.prototype.apply，同步调一次 onSend，
   * 必然能捕获到 e 本体 —— 然后把它的**完整源码**吐回来做静态分析。
   *
   * 全程：网络层拦截（不真发）＋ 不碰任何 DOM。
   */
  async digsend(text = "看看这句") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const TAG = ${JSON.stringify(text)};
      const out = {};

      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(ed).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      let onSend = null, sendDepth = -1;
      let node = ed[fbKey], depth = 0;
      while (node && depth < 32) {
        const props = node.memoizedProps;
        if (props && typeof props.onSend === "function") { onSend = props.onSend; sendDepth = depth; break; }
        node = node.return; depth++;
      }
      if (!onSend) return JSON.stringify({ error: "没找到 onSend" });
      out.onSend位于fiber深度 = sendDepth;

      /* ---- 网络拦截：只记录，不放行 ---- */
      const CHAT = /webcast\/room\/chat/i;
      const blocked = [];
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;

      XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__u && CHAT.test(this.__u)) { blocked.push(this.__u); return; }
        return origSend.apply(this, arguments);
      };
      window.fetch = function (input) {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (CHAT.test(u)) { blocked.push(u); return Promise.resolve(new Response('{"status_code":0}', { status: 200, headers: { "content-type": "application/json" } })); }
        return origFetch.apply(this, arguments);
      };

      /* ---- 核心：挂 apply，把 e 抓出来 ---- */
      const origApply = Function.prototype.apply;
      const calls = [];

      Function.prototype.apply = function (thisArg, argsArray) {
        try {
          if (typeof this === "function" && calls.length < 24) {
            // I 就在某一帧的 this 上：照源码它该同时具备 editor / getTextInfo /
            // getPasteEditMethod，把 this 存下来才能事后精准识别
            try {
              if (thisArg && typeof thisArg === "object") {
                window.__probeThisArg = window.__probeThisArg || [];
                window.__probeThisArg.push(thisArg);
              }
            } catch (e) {}

            calls.push({
              fn: this,
              thisArgUndefined: thisArg === undefined,
              thisArg方法: thisArg && typeof thisArg === "object"
                ? Object.getOwnPropertyNames(thisArg).slice(0, 18) : [],
              argCount: (argsArray && argsArray.length) || 0,
              args: argsArray ? Array.from(argsArray).map(a => {
                if (typeof a === "string") return a.length > 240 ? a.slice(0, 240) + "…" : a;
                if (a === null || a === undefined) return String(a);
                if (typeof a === "function") return "f:" + (a.name || "匿名");
                try { return JSON.stringify(a).slice(0, 300); } catch (e) { return "<不可序列化>"; }
              }) : []
            });
          }
        } catch (e) {}
        return origApply.call(this, thisArg, argsArray);
      };

      let err = null;
      try { onSend(TAG); } catch (e) { err = String(e && e.message || e); }
      Function.prototype.apply = origApply;

      await new Promise(r => setTimeout(r, 1800));

      XMLHttpRequest.prototype.send = origSend;
      XMLHttpRequest.prototype.open = origOpen;
      window.fetch = origFetch;

      out.onSend是否抛错 = err;

      /* ---- 静态报告：每一帧的源码都给全，后续靠推理而不是再试 ---- */
      out.调用帧 = calls.map((c, i) => ({
        序号: i,
        函数名: c.fn.name || "(匿名)",
        形参数: c.fn.length,
        实参个数: c.argCount,
        this是否undefined: c.thisArgUndefined,
        this方法: c.thisArg方法,
        实参快照: c.args,
        完整源码: String(c.fn).replace(/\s+/g, " ")
      }));

      out.被拦截的请求 = blocked.map(u => u.slice(0, 200));
      out.钩子提示 = "重点看 this是否undefined=true 且形参数>=1 的帧 —— e.apply(void 0, …) 就落在那里";
      return JSON.stringify(out, null, 1);
    })()`));
    cdp.close();
  },

  /**
   * 终极证明：拿到 `p` 之后，能不能**完全绕过编辑器**直接发任意文本。
   *
   * 源码依据（e 的编译产物）：
   *   let{plainText:e, rtfElements:t} = I.getTextInfo()
   *   let n = t.length ? JSON.stringify(t) : ""
   *   let i = I.getPasteEditMethod()
   *   e && await p(e, n, w, void 0, i)      ← p 就是真正的发送函数
   *
   * 所以实验设计：
   *   1. 先正常输入文本 A 并发出去（唯一一次碰输入，用来把 p 钓出来）
   *   2. 拦截住请求，不真发
   *   3. 立刻用捕获到的 p 直接发**另一个**文本 B —— 不碰输入、不碰编辑器
   *   4. 如果两条请求的 content 分别是 A 和 B，证明 p 可以直接复用
   */
  async proof(textA = "主播好", textB = "这个不错") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");
    const sessionId = await cdp.sessionOf(live.targetId);
    await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
    await sleep(500);

    // ---- 页面侧：装好 apply 探针（长期挂起，为了抓到异步里的 p）+ 网络拦截 ----
    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const CHAT = /webcast\/room\/chat/i;
      const store = { calls: [], blocked: [] };
      window.__proof = store;

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;

      XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__u && CHAT.test(this.__u)) { store.blocked.push({ via: "xhr", url: this.__u, at: Date.now() }); return; }
        return origSend.apply(this, arguments);
      };
      window.fetch = function (input) {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (CHAT.test(u)) {
          store.blocked.push({ via: "fetch", url: u, at: Date.now() });
          return Promise.resolve(new Response('{"status_code":0}', { status: 200, headers: { "content-type": "application/json" } }));
        }
        return origFetch.apply(this, arguments);
      };

      store.restore = () => {
        XMLHttpRequest.prototype.send = origSend;
        XMLHttpRequest.prototype.open = origOpen;
        window.fetch = origFetch;
      };

      // apply 探针：只记「有实参」的调用，控制规模
      const origApply = Function.prototype.apply;
      Function.prototype.apply = function (thisArg, argsArray) {
        try {
          if (typeof this === "function" && store.calls.length < 400 && argsArray && argsArray.length) {
            const a0 = argsArray[0];
            if (typeof a0 === "string" && a0.length > 0 && a0.length < 200) {
              store.calls.push({
                fn: this, name: this.name || "(匿名)", arity: this.length,
                args: Array.from(argsArray).slice(0, 5).map(x => {
                  if (typeof x === "string") return x.length > 120 ? x.slice(0, 120) + "…" : x;
                  if (x === undefined || x === null) return String(x);
                  try { return JSON.stringify(x).slice(0, 120); } catch (e) { return "?"; }
                })
              });
            }
          }
        } catch (e) {}
        return origApply.call(this, thisArg, argsArray);
      };
      store.restoreApply = () => { Function.prototype.apply = origApply; };

      return JSON.stringify({ ok: true, 提示: "探针已装" });
    })()`));

    // ---- Node 侧：真实点击 + 逐字符输入 A + Enter（唯一一次碰输入）----
    const rect = await cdp.evalIn(live.targetId, String.raw`JSON.stringify((() => {
      const ed = document.querySelector('[contenteditable="true"]');
      const r = ed.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })())`).then(JSON.parse);

    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, sessionId);
    }
    await sleep(300);
    // ⚠ 仅调试探针用：保证焦点落在编辑器上。最终实现是「直接调用 p」，不需要任何 DOM 操作。
    await cdp.evalIn(live.targetId, String.raw`(() => {
      const ed = document.querySelector('[contenteditable="true"]');
      const inner = document.elementFromPoint(
        Math.round(ed.getBoundingClientRect().x + ed.getBoundingClientRect().width / 2),
        Math.round(ed.getBoundingClientRect().y + ed.getBoundingClientRect().height / 2));
      (inner || ed).focus();
      return JSON.stringify({
        activeIsEditor: document.activeElement === ed || ed.contains(document.activeElement)
      });
    })()`).then(console.log);
    await sleep(300);
    console.log("焦点校准后：", await cdp.evalIn(live.targetId, String.raw`JSON.stringify({
      activeIsEditor: (() => { const ed = document.querySelector('[contenteditable="true"]'); return ed === document.activeElement || ed.contains(document.activeElement); })()
    })`));
    // Input.insertText 走 IME 提交路径，对中文比逐字符 dispatchKeyEvent 稳
    await cdp.send("Input.insertText", { text: textA }, sessionId);
    console.log(`已输入 A：「${textA}」`);
    await sleep(800);
    console.log("输入后编辑器文本：", await cdp.evalIn(live.targetId,
      String.raw`JSON.stringify((document.querySelector('[contenteditable="true"]')?.textContent || "").replace(/\u200b/g, ""))`));
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" }, sessionId);
    }
    await sleep(3000);

    // ---- 从探针记录里找出 p：特征 = 第一个实参等于文本 A，且实参个数 >= 3 ----
    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const s = window.__proof;
      const A = ${JSON.stringify(textA)};
      const hits = s.calls
        .map((c, i) => ({ i, name: c.name, arity: c.arity, n: c.args.length, args: c.args }))
        .filter(c => c.args[0] === A);
      return JSON.stringify({
        探针记录数: s.calls.length,
        首参等于A的调用: hits.slice(-6)
      }, null, 1);
    })()`));

    // ---- 关键一步：直接用钓出来的 p 发 B，完全不碰编辑器 ----
    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const s = window.__proof;
      const A = ${JSON.stringify(textA)};
      const B = ${JSON.stringify(textB)};

      // 按源码特征定位 p：被 e 用 (text, rtf, X, undefined, method) 五元组调用
      const cand = s.calls.filter(c => c.args[0] === A && c.args.length >= 3);
      if (!cand.length) return JSON.stringify({ 失败: "没钓到 p" });

      const entry = cand[cand.length - 1];
      const p = entry.fn;
      window.__probeSendFn = p;

      const shape = {
        name: p.name || "(匿名)",
        形参数: p.length,
        这次实参个数: entry.args.length,
        这次实参: entry.args,
        源码: String(p).replace(/\s+/g, " ").slice(0, 400)
      };

      // 照着源码里那五参数的形状，换掉第一个参数（文本），其余保持原来语义
      const args = entry.args.slice();
      args[0] = B;

      let err = null;
      const before = s.blocked.length;
      try {
        const r = p(...args);
        if (r && typeof r.then === "function") await r;
      } catch (e) { err = String(e && e.message || e); }
      await new Promise(r => setTimeout(r, 2000));

      return JSON.stringify({
        p的形状: shape,
        用p直接发B: { 文本: B, 是否抛错: err },
        新拦到的请求: s.blocked.slice(before).map(x => {
          let content = null;
          try { content = new URL(x.url, location.href).searchParams.get("content"); } catch (e) {}
          const ab = /[?&]a_bogus=([^&]*)/.exec(x.url);
          return { content, content等于B: content === B, a_bogus: ab ? "有(" + ab[1].length + "字符)" : "(无)" };
        }),
        输入框未被触碰的证据: "全程没有向编辑器写过任何内容"
      }, null, 1);
    })()`));

    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const s = window.__proof;
      const r = JSON.stringify({
        全部拦截: s.blocked.map(x => {
          let c = null;
          try { c = new URL(x.url, location.href).searchParams.get("content"); } catch (e) {}
          const ab = /[?&]a_bogus=([^&]*)/.exec(x.url);
          const ms = /[?&]msToken=([^&]*)/.exec(x.url);
          return { content: c, a_bogus: ab ? "有" : "(无)", msToken: ms ? "有" : "(无)", url长度: x.url.length };
        }),
        输入框残留: (document.querySelector('[contenteditable="true"]')?.textContent || "").replace(/\u200b/g, "").slice(0, 40)
      }, null, 1);
      s.restoreApply && s.restoreApply();
      s.restore && s.restore();
      return r;
    })()`));

    cdp.close();
  },

  /**
   * 最终方案验证：用 I.getTextInfo 做注入点，完全绕过编辑器发任意内容。
   *
   * 源码依据（e 的编译产物）：
   *   let{plainText:e, rtfElements:t} = I.getTextInfo()
   *   …
   *   e && await p(e, n, w, void 0, i)
   *
   * e 的文本来源**只有** I.getTextInfo() 这一处。所以只要临时替换这个方法，
   * 让它在被调用的那一次返回我们指定的文本，整条业务链路（含签名）都会照原样跑，
   * 而 content 从头到尾就是我们给的值 —— 输入框连碰都不用碰。
   *
   * 步骤：
   *   1. 先空跑一次 onSend()，借 apply 探针把 I 钓出来（这次文本为空，e 会直接 return）
   *   2. 临时替换 I.getTextInfo 返回目标文本
   *   3. 再调 onSend() —— 这次文本非空，e 走到 p(...)
   *   4. 在网络层拦下请求，检查 content；随后还原所有东西
   */
  async sendraw(text = "来了") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");

    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const TEXT = ${JSON.stringify(text)};
      const out = {};

      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return JSON.stringify({ error: "无输入框" });
      const fbKey = Object.keys(ed).find(k => k.startsWith("__reactFiber$"));
      if (!fbKey) return JSON.stringify({ error: "无 fiber" });

      let onSend = null, node = ed[fbKey], depth = 0;
      while (node && depth < 32) {
        const props = node.memoizedProps;
        if (props && typeof props.onSend === "function") { onSend = props.onSend; break; }
        node = node.return; depth++;
      }
      if (!onSend) return JSON.stringify({ error: "没找到 onSend" });

      /* ---- 网络拦截 ---- */
      const CHAT = /webcast\/room\/chat/i;
      const blocked = [];
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__u && CHAT.test(this.__u)) { blocked.push(this.__u); return; }
        return origSend.apply(this, arguments);
      };
      window.fetch = function (input) {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (CHAT.test(u)) {
          blocked.push(u);
          return Promise.resolve(new Response('{"status_code":0}', { status: 200, headers: { "content-type": "application/json" } }));
        }
        return origFetch.apply(this, arguments);
      };

      /* ---- 第一步：空跑一次 onSend，钓出 I ---- *
       * ⚠ 不能调用完就立刻卸载 —— onSend 是 async，e 和 I.getTextInfo 都发生在
       *   之后的微任务里。钩子必须挂到它们执行完再撤。
       */
      const origApply = Function.prototype.apply;
      const thisArgs = [];
      const seenFns = [];
      Function.prototype.apply = function (thisArg, argsArray) {
        try {
          if (thisArg && typeof thisArg === "object") thisArgs.push(thisArg);
          if (seenFns.length < 40) seenFns.push(String(this).replace(/\s+/g, " ").slice(0, 70));
        } catch (e) {}
        // ⚠ 必须走 .call 而不是 .apply —— Function.prototype.apply 此刻已经被我们
        //   替换掉了，再写 origApply.apply(...) 会命中自己的包装器，无限递归。
        //   （表现为：摘要里全是 "function apply() { [native code] }"）
        return origApply.call(this, thisArg, argsArray);
      };
      out.空跑用了参数 = "带 TAG";
      try { onSend(TEXT); } catch (e) { out.空跑异常 = String(e && e.message || e); }
      // 留够时间让 async 走完再卸载
      await new Promise(r => setTimeout(r, 1500));
      Function.prototype.apply = origApply;

      // 源码特征：同时具备 getTextInfo / getPasteEditMethod / resetPasteEditMethod / editor
      const isI = (o) => {
        if (!o || typeof o !== "object") return false;
        return typeof o.getTextInfo === "function"
            && typeof o.getPasteEditMethod === "function"
            && typeof o.resetPasteEditMethod === "function"
            && "editor" in o;
      };
      const I = thisArgs.find(isI);
      if (!I) {
        return JSON.stringify({
          失败: "没钓到 I",
          候选数: thisArgs.length,
          候选里带getTextInfo的: thisArgs.filter(o => o && typeof o.getTextInfo === "function").length,
          捕获到的函数摘要: seenFns.slice(0, 20)
        });
      }
      window.__probeInput = I;
      out.找到I = { 方法: Object.getOwnPropertyNames(I).slice(0, 12) };

      /* ---- 第二步：临时替换 getTextInfo ---- */
      const origGetTextInfo = I.getTextInfo;
      I.getTextInfo = function () {
        return { plainText: TEXT, rtfElements: [] };
      };

      /* ---- 第三步：正式调用 onSend ---- */
      const before = blocked.length;
      let err = null;
      try { onSend(); } catch (e) { err = String(e && e.message || e); }
      await new Promise(r => setTimeout(r, 2500));

      // 立刻还原，把副作用窗口压到最短
      I.getTextInfo = origGetTextInfo;
      XMLHttpRequest.prototype.send = origSend;
      XMLHttpRequest.prototype.open = origOpen;
      window.fetch = origFetch;

      out.目标文本 = TEXT;
      out.调用是否抛错 = err;
      out.新增请求 = blocked.slice(before).map(u => {
        let content = null;
        try { content = new URL(u, location.href).searchParams.get("content"); } catch (e) {}
        const ab = /[?&]a_bogus=([^&]*)/.exec(u);
        return {
          content,
          content等于目标: content === TEXT,
          a_bogus: ab ? "有(" + ab[1].length + "字符)" : "(无)",
          参数: [...new Set((u.split("?")[1] || "").split("&").map(s => s.split("=")[0]))]
        };
      });
      out.编辑器文本 = (ed.textContent || "").replace(/\u200b/g, "").slice(0, 40);
      out.是否碰过DOM = "否 —— 全程没操作 contenteditable，也没调用任何 DOM 方法";
      return JSON.stringify(out, null, 1);
    })()`));
    cdp.close();
  },

  async dryrun(text = "LIVRA终极测试") {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");
    const sessionId = await cdp.sessionOf(live.targetId);

    await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
    await sleep(500);

    console.log(await cdp.evalIn(live.targetId, String.raw`(async () => {
      const TAG = ${JSON.stringify(text)};
      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return JSON.stringify({ error: "无输入框，页面加载完了吗" });

      const KEY = ["getContent", "execCommand", "getContentState", "flushInput", "undoModule"];
      const isEd = (o) => { let h = 0; for (const k of KEY) { try { if (o && typeof o[k] === "function") h++; } catch (e) {} } return h >= 3; };
      let inst = window.__probeEditor && isEd(window.__probeEditor) ? window.__probeEditor : null;

      if (!inst) {
        const fbKey = Object.keys(ed).find(k => k.startsWith("__reactFiber$"));
        let node = fbKey ? ed[fbKey] : null, d = 0;
        while (node && d < 40 && !inst) {
          let hook = node.memoizedState, hi = 0;
          while (hook && hi < 50) {
            const v = hook.memoizedState;
            if (isEd(v)) { inst = v; break; }
            try { if (v && "current" in v && isEd(v.current)) { inst = v.current; break; } } catch (e) {}
            hook = hook.next; hi++;
          }
          node = node.return; d++;
        }
        if (inst) window.__probeEditor = inst;
      }
      if (!inst) return JSON.stringify({ error: "扫不到 editor 实例" });

      /* ---- 拦截：命中 /webcast/room/chat/ 的请求只记录、不放行，弹幕不会真飞出去 ---- */
      const CHAT = /webcast\/room\/chat/i;
      const caught = [];
      const origSend = XMLHttpRequest.prototype.send;
      const origFetch = window.fetch;
      const origOpen = XMLHttpRequest.prototype.open;

      XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); this.__m = m; return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (body) {
        if (this.__u && CHAT.test(this.__u)) { caught.push({ via: "xhr", url: this.__u }); return; }
        return origSend.apply(this, arguments);
      };
      window.fetch = function (input, init) {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        if (CHAT.test(u)) {
          caught.push({ via: "fetch", url: u });
          return Promise.resolve(new Response('{"status_code":0}', { status: 200, headers: { "content-type": "application/json" } }));
        }
        return origFetch.apply(this, arguments);
      };
      window.__dryrun = {
        caught,
        restore: () => {
          XMLHttpRequest.prototype.send = origSend;
          XMLHttpRequest.prototype.open = origOpen;
          window.fetch = origFetch;
        }
      };

      // 写内容这一步交给 Node 侧的 Input.insertText（会走完整的 onChange → React state
      // 链路）。这里只负责**清空**，免得和上一次留下的痕迹叠在一起。
      let writeErr = null;
      try { inst.setHTML(""); } catch (e) { writeErr = String(e && e.message || e); }
      await new Promise(r => setTimeout(r, 400));

      return JSON.stringify({
        清空后: (ed.textContent || "").replace(/\u200b/g, "").slice(0, 40),
        抛错: writeErr,
        提示: "接下来由 Node 侧：真实点击输入框 → Input.insertText → Enter"
      }, null, 1);
    })()`));

    // === Node 侧：真实鼠标点一下输入框（拿焦点），再 InsertText，最后 Enter ===
    const rect = await cdp.evalIn(live.targetId, String.raw`JSON.stringify((() => {
      const ed = document.querySelector('[contenteditable="true"]');
      const r = ed.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })())`).then(JSON.parse);

    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type, x: rect.x, y: rect.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
      }, sessionId);
    }
    console.log(`已点击输入框 (${rect.x},${rect.y})`);
    await sleep(400);

    console.log("点击后焦点：", await cdp.evalIn(live.targetId, String.raw`JSON.stringify({
      activeTag: document.activeElement ? document.activeElement.tagName : null,
      activeCls: String(document.activeElement ? document.activeElement.className : "").slice(0, 50),
      是否输入框: document.activeElement === document.querySelector('[contenteditable="true"]') ||
              !!(document.querySelector('[contenteditable="true"]') || {}).contains
                && document.querySelector('[contenteditable="true"]').contains(document.activeElement)
    })`));

    // 逐字符发 keyDown/keyUp —— 比 Input.insertText 更接近真人打字节奏，
    // 页面一定会把它当成真实输入来处理（onChange → React state 完整走一遍）
    for (const ch of text) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch }, sessionId);
    }
    console.log(`已逐字符输入 ${text.length} 个字`);
    await sleep(900);

    console.log("输入后：", await cdp.evalIn(live.targetId, String.raw`JSON.stringify({
      编辑器文本: (document.querySelector('[contenteditable="true"]')?.textContent || "").replace(/\u200b/g, ""),
      ...(() => {
        // 顺带看看 React 那边的 state 有没有同步到 —— 这才是真正决定能不能发的
        const ed = document.querySelector('[contenteditable="true"]');
        return { 有fiber: !!Object.keys(ed).find(k => k.startsWith("__reactFiber$")) };
      })()
    })`));

    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type, key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r",
      }, sessionId);
    }
    console.log("已发送真实 Enter 按键，等待页面处理…");
    await sleep(3000);

    console.log(await cdp.evalIn(live.targetId, String.raw`(() => {
      const d = window.__dryrun;
      if (!d) return JSON.stringify({ error: "拦截没装" });
      const out = d.caught.map(r => {
        let content = null;
        try { content = new URL(r.url, location.href).searchParams.get("content"); } catch (e) {}
        const ab = /[?&]a_bogus=([^&]*)/.exec(r.url);
        const ms = /[?&]msToken=([^&]*)/.exec(r.url);
        const q = r.url.split("?")[1] || "";
        return {
          via: r.via,
          content,
          content是否本次文本: content === ${JSON.stringify(text)},
          参数清单: [...new Set(q.split("&").map(s => s.split("=")[0]))],
          a_bogus: ab ? ab[1].slice(0, 24) + "…(共" + ab[1].length + "字符)" : "(无 —— 说明这一步还没轮到签名)",
          msToken: ms ? "有(" + ms[1].length + "字符)" : "(无)",
          url长度: r.url.length,
          完整URL: r.url
        };
      });
      d.restore();
      return JSON.stringify({
        拦到请求数: out.length,
        明细: out,
        输入框残留: (document.querySelector('[contenteditable="true"]')?.textContent || "").replace(/\u200b/g, "").slice(0, 60)
      }, null, 1);
    })()`));

    cdp.close();
  },

  async await_send(sec = "60") {
    const seconds = Number(sec) || 60;
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    if (!live) throw new Error("没找到直播间页面");
    console.log(`等 ${seconds}s —— 请在窗口里手动发一条弹幕…`);

    for (let i = 0; i < seconds * 2; i++) {
      await sleep(500);
      const n = await cdp.evalIn(live.targetId,
        `window.__probe ? window.__probe.reqs.filter(r => r.content).length : -1`);
      if (n > 0) {
        console.log(`\n✅ 抓到了（第 ${i * 0.5}s）`);
        break;
      }
    }
    cdp.close();
    await commands.catch();
  },

  async shot(out) {
    const cdp = await Cdp.connect();
    const live = await cdp.target();
    const sessionId = await cdp.sessionOf(live.targetId);
    const file = path.resolve(out || path.join(process.env.TEMP || ".", "livra-shot.png"));
    const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log(`截图：${file}`);
    cdp.close();
  },
};

const HELP = `
probe.js —— 直播间轻量探测器（不依赖 Livra 扩展）

  node test/probe.js targets         列出所有 target
  node test/probe.js login           看有没有登录抖音
  node test/probe.js page            直播间页面结构（输入框 / 发送按钮）
  node test/probe.js watch [秒数]     等直播间 UI 就绪
  node test/probe.js net [秒数]       抓 webcast/chat/im 网络请求
  node test/probe.js exec <JS>        在主世界执行 JS
  node test/probe.js focus           把直播间拉到前台
  node test/probe.js ui              只读摸清 ①界面→②JS→③网络（不发弹幕）
  node test/probe.js arm             注入探针：hook fetch/XHR/WebSocket
  node test/probe.js catch [clear]   读出探针记录（调用栈 + 请求参数）
  node test/probe.js await_send [秒数] 等你在窗口里发一条，抓到就自动打印

环境变量：CDP_PORT（默认 9351）
`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h") return console.log(HELP.trim());
  const fn = commands[cmd];
  if (!fn) {
    console.error(`未知命令：${cmd}`);
    return console.log(HELP.trim());
  }
  try {
    await fn(...args);
  } catch (e) {
    console.error(`失败：${e.message}`);
    process.exit(1);
  }
})();
