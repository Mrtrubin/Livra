#!/usr/bin/env node
/**
 * Livra 调试桥
 * ============
 *
 * 通过 CDP 控制测试浏览器里已加载的 Livra 扩展，把「看状态 / 发弹幕 / 采样数据 /
 * 开面板」这些操作收成一个命令行工具，不用每次手写一坨脚本。
 *
 * 前置条件：测试浏览器已经用 test/open-browser.js 起好了（默认端口 9351）。
 *
 * 用法：
 *   node test/bridge.js status         总览：浏览器 / 扩展 / SDK / 浮窗 / 后台
 *   node test/bridge.js types          每种数据各来了多少条
 *   node test/bridge.js hud            页面右下角浮窗显示的内容
 *   node test/bridge.js send "你好"     直连 SDK 发一条弹幕
 *   node test/bridge.js click-send "你好" 在侧边栏点真实「发送」按钮
 *   node test/bridge.js panel [截图路径]  打开面板并回读 DOM
 *   node test/bridge.js sample [秒]     连续采样一段时间的数据类型分布
 *   node test/bridge.js probe          发弹幕控制器的定位状态
 *   node test/bridge.js reload        重载扩展 + 刷新直播间（改完代码必做）
 *   node test/bridge.js main <JS>      在直播间主世界执行
 *   node test/bridge.js sw <JS>        在 service worker 执行
 */

const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "..");
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const LIVE_URL_HINT = "live.douyin.com";
const PANEL_URL_HINT = "panel/panel.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ CDP 客户端 ============================ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
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

    // ⚠️ 不 enable 的话，service worker 那种「还没启动」的 target 上求值会一直不返回
    // （Runtime 域没开，请求被丢掉），表现出来就是 findServiceWorker 永远找不到。
    await this.send("Runtime.enable", {}, sessionId).catch(() => {});

    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );

    if (r.exceptionDetails) {
      return { error: r.exceptionDetails.exception?.description || "执行出错" };
    }
    return r.result.value;
  }

  targets() {
    return this.send("Target.getTargets").then((r) => r.targetInfos);
  }

  /**
   * 按 manifest name 精确找出 Livra 的 service worker（profile 里可能有别的扩展）。
   * MV3 的 SW 会被频繁回收，可能暂时查不到，所以要轮询等一会儿。
   */
  async findServiceWorker() {
    for (let i = 0; i < 20; i++) {
      const list = (await this.targets()).filter(
        (t) => t.type === "service_worker" && t.url.includes("background.js")
      );

      for (const t of list) {
        const name = await this.evalIn(t.targetId, "chrome.runtime.getManifest().name").catch(
          () => null
        );
        if (name === "Livra") return t;
      }

      await sleep(500);
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

function show(label, value) {
  if (typeof value === "string") {
    console.log(`${label}: ${value}`);
    return;
  }
  console.log(`${label}:`);
  console.log(typeof value === "object" ? JSON.stringify(value, null, 1) : String(value));
}

/* ============================ 通用 ============================ */

const SDK_STATE = `JSON.stringify({
  connected: window.Livra ? window.Livra.room.isConnected() : null,
  total: window.Livra ? window.Livra.room.total() : null,
  counts: window.Livra ? window.Livra.room.counts() : null,
  metrics: window.Livra ? window.Livra.room.metrics() : null
}, null, 1)`;

async function openPanel(cdp) {
  const sw = await cdp.findServiceWorker();
  const live = await cdp.findPage(LIVE_URL_HINT);
  if (!sw || !live) throw new Error("没找到扩展 service worker 或直播间页面");

  for (const t of await cdp.targets()) {
    if (t.type === "page" && t.url.includes(PANEL_URL_HINT)) {
      await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
  }
  await sleep(500);

  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: live.targetId });

  await cdp.evalIn(
    sw.targetId,
    `chrome.tabs.create({
      windowId: ${windowId},
      url: chrome.runtime.getURL("src/panel/panel.html"),
      active: false
    }).then(t => t.id)`
  );

  await sleep(2500);

  // 面板内容跟随所在窗口的当前标签页，所以要把直播间拉回前台
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: live.targetId,
    flatten: true,
  });
  await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
  await sleep(1200);

  const panel = await cdp.findPage(PANEL_URL_HINT);
  if (!panel) throw new Error("面板标签没建起来");
  return panel;
}

const commands = {
  async status() {
    const cdp = await Cdp.connect();

    const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      .then((r) => r.json())
      .catch(() => null);
    show("测试浏览器", version ? `${version.Browser}  CDP:${CDP_PORT}` : "连不上");

    const sw = await cdp.findServiceWorker();
    show("扩展 service worker", sw ? sw.url : "没有（重新打开浏览器试试）");

    const live = await cdp.findPage(LIVE_URL_HINT);
    show("直播间页面", live ? live.url.slice(0, 90) : "没有");

    if (live) {
      show("SDK", await cdp.evalIn(live.targetId, SDK_STATE));
      show(
        "页面浮窗",
        await cdp.evalIn(
          live.targetId,
          `(() => {
            const host = document.getElementById("livra-hud");
            // 连上之前浮窗按设计不进 DOM
            if (!host || !host.shadowRoot) return "未显示（还没连上）";
            const root = host.shadowRoot;
            return JSON.stringify({
              online: root.getElementById("online").textContent,
              total: root.getElementById("total").textContent,
              live: root.querySelector(".hud").classList.contains("live")
            });
          })()`
        )
      );
    }

    if (sw) {
      const tabId = await cdp.evalIn(
        sw.targetId,
        `(async () => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find(x => (x.url || "").includes("${LIVE_URL_HINT}"));
          return t ? t.id : null;
        })()`
      );
      if (tabId && !String(tabId).startsWith("{")) {
        show("后台数据仓", await cdp.evalIn(sw.targetId, `JSON.stringify(snapshot(${tabId}), null, 1)`));
      }
    }

    const panel = await cdp.findPage(PANEL_URL_HINT);
    show("侧边栏", panel ? "已打开" : "没打开（bridge.js panel 可以开）");

    cdp.close();
  },

  async types() {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    const counts = JSON.parse(await cdp.evalIn(live.targetId, "JSON.stringify(window.Livra.room.counts())"));
    const labels = JSON.parse(
      await cdp.evalIn(live.targetId, "JSON.stringify(Object.fromEntries(window.Livra.types.list.map(t => [t.id, t.label])))")
    );

    console.log("每种数据的条数：");
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [id, count] of rows) {
      console.log(`  ${String(count).padStart(6)}  ${labels[id] || id}`);
    }

    cdp.close();
  },

  async hud() {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    show(
      "浮窗",
      await cdp.evalIn(
        live.targetId,
        `(() => {
          const host = document.getElementById("livra-hud");
          if (!host || !host.shadowRoot) {
            // 连上之前浮窗按设计不进 DOM，这是正常状态，不是没注入
            const connected = window.Livra ? window.Livra.room.isConnected() : null;
            return connected ? "该显示了却不在 DOM 里（异常）" : "未显示（还没连上）";
          }
          const root = host.shadowRoot;
          return JSON.stringify({
            text: root.querySelector(".hud").textContent.trim().replace(/\\s+/g, " "),
            kind: root.querySelector(".hud").className
          });
        })()`
      )
    );
    cdp.close();
  },

  async probe() {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    show("发送控制器", await cdp.evalIn(live.targetId, "JSON.stringify(window.Livra.sender.probe(), null, 1)"));
    cdp.close();
  },

  /** 直连 SDK 发弹幕，跳过面板 */
  async send(text) {
    if (!text) throw new Error("用法：node test/bridge.js send <弹幕内容>");

    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    // 页面失焦时「回车发送」会被页面忽略，先把直播间拉到前台
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: live.targetId,
      flatten: true,
    });
    await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
    await sleep(700);

    show(
      "发送结果",
      await cdp.evalIn(live.targetId, `JSON.stringify(window.Livra.send(${JSON.stringify(text)}))`)
    );
    cdp.close();
  },

  /** 在面板里点真实的「发送」按钮 —— 完整复现用户操作路径 */
  async "click-send"(text) {
    if (!text) throw new Error("用法：node test/bridge.js click-send <内容>");

    const cdp = await Cdp.connect();
    const panelTarget = (await cdp.findPage(PANEL_URL_HINT)) || (await openPanel(cdp));

    const live = await cdp.findPage(LIVE_URL_HINT);
    if (live) {
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId: live.targetId,
        flatten: true,
      });
      await cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
      await sleep(700);
    }

    const clicked = await cdp.evalIn(
      panelTarget.targetId,
      `(() => {
        const input = document.getElementById("danmakuInput");
        const btn = document.getElementById("danmakuSend");
        if (!input || !btn) return "面板没加载好";
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        btn.click();
        return "已点击";
      })()`
    );
    show("点击发送", clicked);

    for (let i = 0; i < 10; i++) {
      await sleep(800);

      const st = await cdp.evalIn(
        panelTarget.targetId,
        `JSON.stringify({
          status: document.getElementById("sendStatus").textContent,
          cls: document.getElementById("sendStatus").className,
          input: document.getElementById("danmakuInput").value
        })`
      );

      console.log(`${((i + 1) * 0.8).toFixed(1)}s  ${st}`);

      if (st.includes("send-status ok") || st.includes("send-status err")) break;
    }

    cdp.close();
  },

  async panel(shotPath) {
    const cdp = await Cdp.connect();
    const panelTarget = await openPanel(cdp);

    show(
      "面板渲染",
      await cdp.evalIn(
        panelTarget.targetId,
        `JSON.stringify({
          badge: document.getElementById("badge").textContent,
          streamCount: document.getElementById("streamCount").textContent,
          typeCount: document.getElementById("typeCount").textContent,
          typeRows: document.querySelectorAll(".type-item").length,
          messageCount: document.querySelectorAll("#messageList .msg").length,
          recent: [...document.querySelectorAll("#messageList .msg")].slice(-6)
            .map(e => e.textContent.trim().replace(/\\s+/g, " "))
        }, null, 1)`
      )
    );

    if (shotPath) {
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId: panelTarget.targetId,
        flatten: true,
      });
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 380, height: 860, deviceScaleFactor: 2, mobile: false },
        sessionId
      );
      await sleep(600);

      const out = path.resolve(shotPath);
      const dir = path.dirname(out);
      const base = path.basename(out, path.extname(out));
      const ext = path.extname(out);

      // 两个 tab 各截一张
      for (const name of ["stream", "types"]) {
        await cdp.evalIn(panelTarget.targetId, `(() => {
          const tab = document.querySelector('.tab[data-tab="${name}"]');
          if (tab) tab.click();
          return true;
        })()`);
        await sleep(400);

        const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        fs.writeFileSync(path.join(dir, `${base}-${name}${ext}`), Buffer.from(shot.data, "base64"));
      }

      // 截完回到消息流
      await cdp.evalIn(panelTarget.targetId, `(() => {
        const tab = document.querySelector('.tab[data-tab="stream"]');
        if (tab) tab.click();
        return true;
      })()`);

      show("截图", `${path.join(dir, `${base}-stream${ext}`)} 与 ${path.join(dir, `${base}-types${ext}`)}`);
    }

    cdp.close();
  },

  /** 连续采样一段时间，看直播间实际会推哪些类型的数据 */
  async sample(seconds = 20) {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) throw new Error("没找到直播间页面");

    console.log(`清空计数，采样 ${seconds} 秒…`);

    await cdp.evalIn(live.targetId, "window.Livra.room.clear()");
    await sleep(Number(seconds) * 1000);

    const counts = JSON.parse(
      await cdp.evalIn(live.targetId, "JSON.stringify(window.Livra.room.counts())")
    );
    const labels = JSON.parse(
      await cdp.evalIn(
        live.targetId,
        "JSON.stringify(Object.fromEntries(window.Livra.types.list.map(t => [t.id, t.label])))"
      )
    );
    const total = await cdp.evalIn(live.targetId, "window.Livra.room.total()");

    console.log(`\n${seconds} 秒内共 ${total} 条，分布如下：`);
    for (const [id, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      if (count > 0) console.log(`  ${String(count).padStart(6)}  ${labels[id] || id}`);
    }

    cdp.close();
  },

  async main(expr) {
    const cdp = await Cdp.connect();
    const live = await cdp.findPage(LIVE_URL_HINT);
    show("主世界结果", await cdp.evalIn(live.targetId, expr));
    cdp.close();
  },

  /**
   * 改完代码必做的一步。
   *
   * 扩展重载只是换了后台/content script 的代码，已经打开的页面里跑的还是旧 content
   * script，所以还要把直播间页面刷一遍。面板标签同理（旧的属于失效的扩展上下文），
   * 刷完再跑 `panel` 命令重开。
   */
  async reload() {
    const cdp = await Cdp.connect();

    const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
    show("扩展已重载", extId);

    const live = await cdp.findPage(LIVE_URL_HINT);
    if (!live) {
      show("直播间页面", "没找到，跳过刷新");
      cdp.close();
      return;
    }

    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: live.targetId,
      flatten: true,
    });
    await cdp.send("Page.reload", {}, sessionId);
    await sleep(4000);

    show("直播间页面", "已刷新（面板标签要重开：node test/bridge.js panel）");
    cdp.close();
  },

  async sw(expr) {
    const cdp = await Cdp.connect();
    const target = await cdp.findServiceWorker();
    show("SW 结果", await cdp.evalIn(target.targetId, expr));
    cdp.close();
  },
};

const HELP = `
Livra 调试桥 —— 通过 CDP 控制测试浏览器里的扩展

  node test/bridge.js status              总览：浏览器 / SDK / 浮窗 / 后台
  node test/bridge.js types               每种数据各来了多少条
  node test/bridge.js hud                 页面浮窗显示的内容
  node test/bridge.js probe               发弹幕控制器定位状态
  node test/bridge.js send <内容>          直连 SDK 发一条弹幕
  node test/bridge.js click-send <内容>    在侧边栏点真实「发送」按钮
  node test/bridge.js panel [截图路径]      打开面板，回读 DOM
  node test/bridge.js sample [秒]          清空后连续采样数据类型分布
  node test/bridge.js reload              重载扩展并刷新直播间页面（改完代码必做）
  node test/bridge.js main <JS>           在直播间主世界执行
  node test/bridge.js sw <JS>             在 service worker 执行

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
