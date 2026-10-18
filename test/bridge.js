#!/usr/bin/env node
/**
 * Livra 调试桥
 * ============
 *
 * 通过 CDP 控制测试浏览器里已加载的 Livra 扩展，把「重载扩展 / 发弹幕 / 看状态 /
 * 开侧边栏 / 切改写开关」这些操作收成一个命令行工具，不用再每次手写一坨脚本。
 *
 * 前置条件：测试浏览器已经用下面这套参数启动过
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --user-data-dir="$HOME/livra-test-profile" \
 *     --remote-debugging-port=9351 --remote-allow-origins='*' \
 *     --enable-unsafe-extension-debugging --silent-debugger-extension-api \
 *     --no-first-run --no-default-browser-check --no-sandbox \
 *     --disable-features=DisableLoadExtensionCommandLineSwitch \
 *     "https://live.douyin.com/"
 *
 * 用法：
 *   node test/bridge.js                列出所有命令
 *   node test/bridge.js status         总览
 *   node test/bridge.js reload both    重载扩展 + 直播间页面
 *   node test/bridge.js send "你好"     走完整链路发一条弹幕
 *   node test/bridge.js hook           页面里 hook 的状态
 *   node test/bridge.js ws             最近的 WebSocket 收发帧
 *   node test/bridge.js panel          打开侧边栏并回读 DOM
 *   node test/bridge.js rewrite on     对当前标签页开改写
 *   node test/bridge.js rules          看硬编码规则
 *   node test/bridge.js main <expr>    在直播间主世界执行 JS
 *   node test/bridge.js sw <expr>      在 service worker 执行 JS
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const EXT = path.resolve(__dirname, "..");
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const LIVE_URL_HINT = "live.douyin.com";
const PANEL_URL_HINT = "modules/assistant/assistant.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ CDP 客户端 ============================ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.onEvent = null;
  }

  static async connect() {
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);

    const client = new Cdp(ws);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("连不上调试端口，测试浏览器是不是没开？"));
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
        client.events.push(msg);
        if (client.onEvent) client.onEvent(msg);
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

  /** 在某个 target 的执行环境里跑 JS */
  async evalIn(targetId, expression) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const r = await this.send("Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true }, sessionId);

    if (r.exceptionDetails) {
      return { ok: false, error: r.exceptionDetails.exception?.description || "执行出错" };
    }
    return r.result.value;
  }

  targets() {
    return this.send("Target.getTargets").then((r) => r.targetInfos);
  }

  /** 按 manifest name 精确找出 Livra 的 service worker（profile 里可能有别的扩展） */
  async findServiceWorker() {
    const list = (await this.targets()).filter(
      (t) => t.type === "service_worker" && t.url.includes("background.js"));

    for (const t of list) {
      const name = await this.evalIn(t.targetId, "chrome.runtime.getManifest().name").catch(() => null);
      if (name === "Livra") return t;
    }

    return null;
  }

  async findPage(hint) {
    const list = await this.targets();
    return list.find((t) => t.type === "page" && t.url.includes(hint));
  }

  close() {
    this.ws.close();
  }
}

function line(ch = "─", n = 64) {
  return ch.repeat(n);
}

function show(label, value) {
  if (typeof value === "string") {
    console.log(`${label}: ${value}`);
  } else {
    console.log(`${label}:`);
    console.log(typeof value === "object" ? JSON.stringify(value, null, 1) : String(value));
  }
}

/* ============================ 打开侧边栏 ============================ */

async function openPanel(cdp) {
  const sw = await cdp.findServiceWorker();
  const live = await cdp.findPage(LIVE_URL_HINT);
  if (!sw || !live) throw new Error("没找到扩展 service worker 或直播间页面");

  // 关掉旧的面板标签，避免开出一堆
  for (const t of await cdp.targets()) {
    if (t.type === "page" && t.url.includes(PANEL_URL_HINT)) {
      await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  }
  await sleep(500);

  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: live.targetId });

  await cdp.evalIn(sw.targetId, `chrome.tabs.create({
    windowId: ${windowId},
    url: chrome.runtime.getURL("modules/assistant/assistant.html"),
    active: false
  }).then(t => t.id)`);

  await sleep(3000);

  // 面板内容跟随所在窗口的当前标签页，所以要把直播间拉回前台
  const { sessionId } = await cdp.send("Target.attachToTarget",
    { targetId: live.targetId, flatten: true });
  await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
  await sleep(1500);

  const panel = await cdp.findPage(PANEL_URL_HINT);
  if (!panel) throw new Error("侧边栏标签没建起来");
  return panel;
}

/* ============================ 命令 ============================ */

const commands = {
  /** 把直播间标签页拉到前台。页面失焦时「回车发送」会被页面忽略，发送前先跑这个 */
  async focus() {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    const { sessionId } = await cdp.send("Target.attachToTarget",
      { targetId: live.targetId, flatten: true });
    await cdp.send("Page.bringToFront", {}, sessionId);

    await sleep(800);

    show("焦点状态", await cdp.evalIn(live.targetId, `JSON.stringify({
      docHasFocus: document.hasFocus(),
      activeIsEditor: document.activeElement === document.querySelector('[contenteditable="true"]')
    })`));
    cdp.close();
  },

  /**
   * 用 CDP 发一个**真实的**按键事件（isTrusted=true）。
   * 扩展里做不到这件事 —— 只有调试桥能，用来验证「页面到底收不收合成的 Enter」。
   */
  async key(keyName = "Enter") {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    const { sessionId } = await cdp.send("Target.attachToTarget",
      { targetId: live.targetId, flatten: true });
    await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
    await sleep(500);

    show("按下前", await cdp.evalIn(live.targetId,
      "document.querySelector('[contenteditable=\"true\"]').textContent.length"));

    const code = keyName === "Enter" ? 13 : 32;
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyName,
      code: keyName,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    }, sessionId);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyName,
      code: keyName,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    }, sessionId);

    await sleep(900);

    show("按下后", await cdp.evalIn(live.targetId,
      "document.querySelector('[contenteditable=\"true\"]').textContent.length"));
    show("是否真发出请求", await cdp.evalIn(live.targetId,
      "window.__livraLive.outbound().length"));
    cdp.close();
  },

  /**
   * 在侧边栏里点真实的「发送」按钮 —— 完整复现用户操作路径。
   * 面板 -> 后台 -> content script -> MAIN world -> 页面输入框。
   */
  async "click-send"(text) {
    if (!text) throw new Error("用法：node test/bridge.js click-send <内容>");

    const cdp = await Cdp.connect();
    const panelTarget = await cdp.findPage(PANEL_URL_HINT) || await openPanel(cdp);

    // 先把直播间拉到前台：页面失焦时「回车发送」会被页面直接忽略
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (live) {
      const { sessionId } = await cdp.send("Target.attachToTarget",
        { targetId: live.targetId, flatten: true });
      await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
      await sleep(700);
    }

    const clicked = await cdp.evalIn(panelTarget.targetId, `(() => {
      const input = document.getElementById("danmakuInput");
      const btn = document.getElementById("danmakuSend");
      if (!input || !btn) return "面板没加载好";
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      btn.click();
      return "已点击";
    })()`);
    show("点击发送", clicked);

    // 轮询反馈文案
    for (let i = 0; i < 10; i++) {
      await sleep(800);

      const st = await cdp.evalIn(panelTarget.targetId, `JSON.stringify({
        status: document.getElementById("sendStatus").textContent,
        cls: document.getElementById("sendStatus").className,
        input: document.getElementById("danmakuInput").value
      })`);

      console.log(`${((i + 1) * 0.8).toFixed(1)}s  ${st}`);

      if (st.indexOf("send-status ok") !== -1 || st.indexOf("send-status err") !== -1) break;
    }

    // 页面侧确认真的发出去了
    if (live) {
      show("页面侧", await cdp.evalIn(live.targetId,
        "window.__livraLive ? JSON.stringify(window.__livraLive.outbound().slice(-2), null, 1) : 'hook 没装'"));
    }

    cdp.close();
  },

  async status() {
    const cdp = await Cdp.connect();

    const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      .then((r) => r.json()).catch(() => null);
    show("测试浏览器", version ? `${version.Browser}  CDP:${CDP_PORT}` : "连不上");

    const sw = await cdp.findServiceWorker();
    show("扩展 service worker", sw ? `${sw.url}` : "没有（重新 loadUnpacked 试试）");

    const live = await cdp.findPage(LIVE_URL_HINT);
    show("直播间页面", live ? live.url.slice(0, 100) : "没有");

    const panel = await cdp.findPage(PANEL_URL_HINT);
    show("侧边栏", panel ? "已打开" : "没打开（bridge.js panel 可以开）");

    if (live) {
      show("页面 hook", await cdp.evalIn(live.targetId, `JSON.stringify({
        installed: typeof window.__livraLive,
        wsPatched: String(window.WebSocket).includes("LivraWebSocket"),
        messages: window.__livraLive ? window.__livraLive.stats().messages : null,
        online: window.__livraLive ? window.__livraLive.stats().online : null,
        outbound: window.__livraLive ? window.__livraLive.outbound().length : null
      }, null, 1)`));
    }

    if (sw) {
      show("后台匹配的标签页", await cdp.evalIn(sw.targetId,
        `(async () => {
          const tabs = await chrome.tabs.query({});
          return JSON.stringify([...liveByTab].map(([id, l]) => ({
            tabId: id,
            session: l.socket ? l.socket.state : null,
            online: l.online,
            danmaku: l.danmaku.length,
            messages: l.stats ? l.stats.messages : 0
          })), null, 1);
        })()`));
    }

    cdp.close();
  },

  async tabs() {
    const cdp = await Cdp.connect();
    const sw = await cdp.findServiceWorker();
    show("tags", await cdp.evalIn(sw.targetId, `(async () => {
      const tabs = await chrome.tabs.query({});
      return JSON.stringify(tabs.map(t => ({ id: t.id, active: t.active, url: (t.url||"").slice(0,80) })), null, 1);
    })()`));
    cdp.close();
  },

  async loadExt() {
    const cdp = await Cdp.connect();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
    show("扩展已加载", id);
    await sleep(2500);
    console.log("注意：改过 injected.js / manifest.json 后必须重载扩展，只刷页面没用。");
    cdp.close();
  },

  /**
   * 重载。
   *
   * ⚠️ 重要经验：`Extensions.loadUnpacked` 对**已加载**的扩展不会重新读代码。
   * 页面里已经注入的 hook 实例还活着（这是我们特意做的持久化），所以改了
   * injected.js / content.js / sidepanel.js 之后，**必须刷页面**才生效 ——
   * 只 loadUnpacked 是没反应的（表现就是「明明改了代码但行为没变」）。
   *
   * 另外：不要在 SW 里用 chrome.runtime.reload() 重启扩展，chrome.debugger 会话会被动断开。
   */
  async reload(what = "ext", waitMs = 4000) {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面，先打开一个直播间再重载");

    if (what === "ext" || what === "both") {
      const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
      show("loadUnpacked", id);
    }

    // 只有刷页面才会让 content script / MAIN world 脚本重新注入（也就是让新代码生效）
    if (what === "page" || what === "both") {
      const { sessionId } = await cdp.send("Target.attachToTarget",
        { targetId: live.targetId, flatten: true });
      await cdp.send("Page.reload", { ignoreCache: false }, sessionId);
      show("直播间页面已重载", live.url.slice(0, 90));
    }

    console.log(`等 ${waitMs / 1000}s 让东西跑起来…`);
    await sleep(waitMs);

    show("页面 hook", await cdp.evalIn(live.targetId, `JSON.stringify({
      wsPatched: String(window.WebSocket).includes("LivraWebSocket"),
      // 这个标记随 main world 脚本演进而变，用来确认页面里跑的是不是最新代码
      hasSendFnApi: typeof window.__livraLive.sendFn === "function",
      hasEditorFallback: String(window.__livraNS.sender.sendDanmaku).includes("sendViaEditor"),
      messages: window.__livraLive ? window.__livraLive.stats().messages : null
    })`));

    console.log("提示：改了 content script / MAIN world 脚本后，只有 page/both 才会让新代码生效。");
    cdp.close();
  },

  async hook() {
    const cdp = await Cdp.connect();
    const sw = await cdp.findServiceWorker();
    const live = await cdp.findPage(LIVE_URL_HINT);

    show("页面 hook", await cdp.evalIn(live.targetId, `JSON.stringify({
      installed: typeof window.__livraLive,
      wsPatched: String(window.WebSocket).includes("LivraWebSocket"),
      stats: window.__livraLive ? window.__livraLive.stats() : null,
      wsSends: window.__livraLive && window.__livraLive.wsSends ? window.__livraLive.wsSends().slice(-10) : null,
      outbound: window.__livraLive ? window.__livraLive.outbound().slice(-5) : null
    }, null, 1)`));

    show("最近弹幕（后台视角）", await cdp.evalIn(sw.targetId,
      `JSON.stringify([...liveByTab].map(([k,l]) => l.danmaku.slice(-12).map(x => (x.nickname||"")+": "+x.content)), null, 1)`));

    cdp.close();
  },

  async ws() {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    show("最近的 WS 发送帧", await cdp.evalIn(live.targetId,
      "JSON.stringify(window.__livraLive ? window.__livraLive.wsSends().slice(-12) : null, null, 1)"));
    cdp.close();
  },

  /** 抓到的发弹幕请求 + 调用栈（用来定位页面自己的发送函数） */
  async chat() {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    const all = await cdp.evalIn(live.targetId,
      "JSON.stringify(window.__livraLive ? window.__livraLive.outbound() : null)");

    show("抓到的发弹幕请求", all);

    try {
      const list = JSON.parse(all);
      const last = list[list.length - 1];
      if (last && last.stack) {
        const content = decodeURIComponent((last.url.match(/content=([^&]*)/) || [])[1] || "");
        console.log(`\n${line()}\n最近一次发送内容: ${content}\n调用栈（找发送函数看这里）:\n${last.stack}\n${line()}`);
      }
    } catch {
      // 忽略
    }
    cdp.close();
  },

  /** 发弹幕：走面板同一套链路，并把 debug 信息打出来定位问题 */
  async send(text) {
    if (!text) throw new Error("用法：node test/bridge.js send <弹幕内容>");

    const cdp = await Cdp.connect();
    const sw = await cdp.findServiceWorker();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!sw || !live) throw new Error("没找到扩展或直播间页面");

    const tabId = await cdp.evalIn(sw.targetId, `(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(t => (t.url||"").includes("${LIVE_URL_HINT}"));
      return t ? t.id : null;
    })()`);

    const before = await cdp.evalIn(live.targetId, `JSON.stringify({
      outbound: window.__livraLive.outbound().length,
      ws: window.__livraLive.wsSends().length
    })`).then((s) => JSON.parse(s));

    show("直播间 tabId", tabId);

    // 页面失焦时「回车发送」会被页面直接忽略，所以先把直播间拉到前台
    const { sessionId: liveSession } = await cdp.send("Target.attachToTarget",
      { targetId: live.targetId, flatten: true });
    await cdp.send("Page.bringToFront", {}, liveSession).catch(() => {});
    await sleep(800);

    show("焦点状态", await cdp.evalIn(live.targetId, `JSON.stringify({
      docHasFocus: document.hasFocus(),
      activeIsEditor: document.activeElement === document.querySelector('[contenteditable="true"]'),
      editorText: document.querySelector('[contenteditable="true"]').textContent.slice(0, 30)
    })`));

    // 通过后台把消息派发给 content script —— 和侧边栏点发送走的是同一条链
    await cdp.evalIn(sw.targetId, `chrome.tabs.sendMessage(${tabId}, {
      type: "SEND_DANMAKU", text: ${JSON.stringify(text)}
    }).catch(() => {})`);

    // 轮询等结果
    let result = null;
    for (let i = 0; i < 12; i++) {
      await sleep(700);

      const outbound = await cdp.evalIn(live.targetId, `JSON.stringify({
        outbound: window.__livraLive.outbound().length,
        ws: window.__livraLive.wsSends().length
      })`).then((s) => JSON.parse(s)).catch(() => ({ outbound: 0, ws: 0 }));

      if (outbound.outbound > before.outbound || outbound.ws > before.ws) {
        result = { ok: true, via: "检测到新的发送请求" };
        break;
      }
    }

    show("发送结果", result || { ok: false, error: "没检测到发送请求发出（超时）" });
    show("页面侧当前状态", await cdp.evalIn(live.targetId, `JSON.stringify({
      outbound: window.__livraLive.outbound().slice(-3),
      wsSends: window.__livraLive.wsSends().slice(-3)
    }, null, 1)`));

    cdp.close();
  },

  async panel(shotPath) {
    const cdp = await Cdp.connect();
    const panelTarget = await openPanel(cdp);

    show("侧边栏渲染", await cdp.evalIn(panelTarget.targetId, `JSON.stringify({
      tabTitle: document.getElementById("tabTitle").textContent,
      socket: document.getElementById("liveSocket").textContent,
      state: document.getElementById("statState").textContent,
      rewritten: document.getElementById("statCount").textContent,
      online: document.getElementById("statOnline").textContent,
      danmakuCount: document.querySelectorAll(".danmaku").length,
      sendStatus: document.getElementById("sendStatus").textContent,
      recent: [...document.querySelectorAll(".danmaku")].slice(-8)
        .map(e => e.querySelector(".danmaku-user").textContent + ": " + e.querySelector(".danmaku-text").textContent)
    }, null, 1)`));

    if (shotPath) {
      const { sessionId } = await cdp.send("Target.attachToTarget",
        { targetId: panelTarget.targetId, flatten: true });
      await cdp.send("Emulation.setDeviceMetricsOverride",
        { width: 360, height: 820, deviceScaleFactor: 2, mobile: false }, sessionId);
      await sleep(600);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const out = path.resolve(shotPath);
      fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
      show("截图", out);
    }

    cdp.close();
  },

  async rewrite(action, tabIdArg) {
    const cdp = await Cdp.connect();
    const sw = await cdp.findServiceWorker();

    const tabId = tabIdArg
      ? Number(tabIdArg)
      : await cdp.evalIn(sw.targetId, `(async () => {
        const tabs = await chrome.tabs.query({ active: true });
        return tabs[0] ? tabs[0].id : null;
      })()`);

    const phrasing = action === "off" ? "STOP" : "START";
    show("开关目标", `${phrasing} tabId=${tabId}`);

    if (action === "on" || action === "off") {
      show("结果", await cdp.evalIn(sw.targetId,
        `chrome.tabs.sendMessage(${tabId}, {type:"TOGGLE_REWRITE"})
           .then(r => JSON.stringify(r)).catch(e => "分发失败: " + e.message)`));
    } else {
      show("当前状态", await cdp.evalIn(sw.targetId,
        `chrome.tabs.sendMessage(${tabId}, {type:"GET_TAB_STATE"})
           .then(r => JSON.stringify(r)).catch(e => "分发失败: " + e.message)`));
    }

    await sleep(600);
    show("后台角标/状态", await cdp.evalIn(sw.targetId,
      `JSON.stringify([...sessions].map(([id,s]) => ({id, attached:s.attached, count:s.count, error:s.error})), null, 1)`));

    cdp.close();
  },

  async rules() {
    const cdp = await Cdp.connect();
    const sw = await cdp.findServiceWorker();
    show("改写规则", await cdp.evalIn(sw.targetId, "JSON.stringify(rulesSummary(), null, 1)"));
    show("性能开关", await cdp.evalIn(sw.targetId, "JSON.stringify(REWRITE_OPTIONS, null, 1)"));
    cdp.close();
  },

  async main(expr) {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    show("主世界结果", await cdp.evalIn(live.targetId, expr));
    cdp.close();
  },

  async sw(expr) {
    const cdp = await Cdp.connect();
    const target = await cdp.findServiceWorker();
    show("SW 结果", await cdp.evalIn(target.targetId, expr));
    cdp.close();
  },
};

/* ============================ 入口 ============================ */

const HELP = `
Livra 调试桥 —— 通过 CDP 控制测试浏览器里的扩展

  node test/bridge.js status                  总览：浏览器 / 扩展 / 页面 / hook / 后台
  node test/bridge.js load-ext                把扩展 loadUnpacked 进去
  node test/bridge.js reload <ext|page|both>  重载扩展和/或直播间页面
  node test/bridge.js tabs                    列出扩展看到的标签页
  node test/bridge.js hook                    页面 hook 状态 + 最近弹幕
  node test/bridge.js ws                      最近的 WebSocket 发送帧
  node test/bridge.js send <内容>              走完整链路发一条弹幕
  node test/bridge.js click-send <内容>        在侧边栏点真实「发送」按钮（复现用户路径）
  node test/bridge.js panel [截图路径]          打开侧边栏，回读 DOM 状态
  node test/bridge.js rules                   硬编码规则 + 性能开关
  node test/bridge.js rewrite <on|off|status> [tabId]
  node test/bridge.js focus                  把直播间标签页拉到前台（发弹幕前先跑）
  node test/bridge.js key [Enter]            用 CDP 发一个真实按键（isTrusted=true）
  node test/bridge.js main <JS>              在直播间主世界执行
  node test/bridge.js sw <JS>                在 service worker 执行

环境变量：CDP_PORT（默认 9351）
`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "-h") {
    console.log(HELP.trim());
    return;
  }

  const fn = commands[cmd];
  if (!fn) {
    console.error(`未知命令：${cmd}\n`);
    console.log(HELP.trim());
    process.exit(1);
  }

  try {
    await fn(...args);
  } catch (error) {
    console.error(`\n失败：${error.message}`);
    process.exit(1);
  }
})();
