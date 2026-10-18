/**
 * 桥接层 · content script（隔离世界）
 *
 * 两个职责，都很薄：
 *   1. 数据管道：SDK（MAIN world）的事件 -> chrome.runtime -> 后台 -> 侧边栏
 *   2. 数据浮窗：页面右下角那个小仪表盘，只读显示实时在线人数和消息数
 *
 * ⚠️ 隔离世界**读不到** MAIN world 那份 window.Livra（两个世界各有一份，只共享 DOM）。
 * 所以所有跨世界调用都必须走 window.postMessage。
 * 本层自己的东西挂在 Livra.bridge 下 —— 插件往网页上挂的全局对象就 Livra 一个。
 *
 * 这一层是整个插件里唯一同时知道「SDK」和「扩展」的地方 —— SDK 那边不知道自己跑在
 * 扩展里，侧边栏不知道数据是从哪来的。
 */

(() => {
  const HOST_ID = "livra-hud";
  // sessionStorage 天然按标签页隔离（同一标签内刷新也还在），正好用来记浮窗位置
  const POS_KEY = "__livra_hud_pos__";

  // 插件重启后 Chrome 会往已打开的页面里重新注入 content script，DOM 里还留着旧实例的浮窗。
  // 旧浮窗上的点击监听属于已经失效的扩展上下文（点了没反应），所以直接拆掉重建一份。
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  /* ============================ 桥接层模块 ============================ */

  /**
   * 命名空间骨架由 sdk/namespace.js 建好（两个世界各加载一份），跨世界消息标记
   * 也在那里 —— 只有一份定义，不会改一边忘另一边。
   */
  const NS = window.Livra;

  /**
   * 同一个页面里可能同时存在多个 content script 实例（页面加载时注入的那个，加上
   * 插件重启后补注入的那个），所以实例状态不能挂在闭包里，得挂到命名空间上：
   * 新实例把 gen 加一，旧实例看到 gen 变了就自动退位。
   */
  const BRIDGE = (NS.bridge = NS.bridge || { gen: 0, listener: null });
  NS.installed.bridge = true;

  /* ============================ 幂等 ============================ */

  // 两个实例都会收到后台消息，一条消息被处理两遍 —— 表现为弹幕重复、发弹幕发两次。
  // 所以只让**最新的那个实例**响应。
  BRIDGE.gen += 1;
  const myGen = BRIDGE.gen;

  const isCurrentInstance = () => BRIDGE.gen === myGen;

  /* ============================ 数据浮窗 ============================ */

  const host = document.createElement("div");
  host.id = HOST_ID;
  // all:initial 先切断宿主页面的样式继承，后面几条再把它覆盖回来
  host.style.cssText = [
    "all:initial",
    "display:block",
    "position:fixed",
    "z-index:2147483647",
    "right:16px",
    "bottom:16px",
  ].join(";");

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .hud {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 14px;
        border-radius: 999px;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #f8fafc; background: rgba(30, 41, 59, .92);
        box-shadow: 0 4px 14px rgba(0, 0, 0, .28);
        cursor: move; white-space: nowrap;
        touch-action: none; user-select: none;
        transition: background .15s ease;
      }
      .hud:hover { background: rgba(15, 23, 42, .97); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; flex: none; }
      .hud.live .dot { background: #4ade80; animation: hud-pulse 1.6s ease-in-out infinite; }
      .hud.stale .dot { background: #fbbf24; }
      @keyframes hud-pulse { 50% { opacity: .35; } }
      .block { display: flex; align-items: baseline; gap: 4px; }
      .num { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
      .unit { font-size: 10px; opacity: .6; font-weight: 400; }
      .sep { width: 1px; height: 12px; background: rgba(248, 250, 252, .2); }
      .tip {
        position: absolute; right: 0; bottom: calc(100% + 8px);
        padding: 10px 12px; border-radius: 10px;
        background: rgba(15, 23, 42, .98); color: #e2e8f0;
        font: 400 11px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, .3);
        opacity: 0; pointer-events: none; transition: opacity .15s ease;
        max-width: 260px;
      }
      .hud:hover + .tip, .tip.show { opacity: 1; }
      .tip-row { display: flex; justify-content: space-between; gap: 16px; }
      .tip-row span:last-child { font-variant-numeric: tabular-nums; color: #fff; }
      .tip-title { opacity: .55; margin-bottom: 6px; font-size: 10px; }
    </style>
    <div class="hud" title="拖动可移动位置">
      <span class="dot"></span><span class="num" id="online">—</span><span class="unit">在线</span>
      <span class="sep"></span>
      <span class="num" id="total">0</span><span class="unit">条</span>
    </div>
    <div class="tip"><div class="tip-title">本场已收</div><div id="tipBody"></div></div>
  `;

  document.documentElement.appendChild(host);

  const hud = root.querySelector(".hud");
  const onlineEl = root.getElementById("online");
  const totalEl = root.getElementById("total");
  const tipBody = root.getElementById("tipBody");

  const formatNumber = (n) => {
    if (n == null) return "—";
    return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
  };

  let summary = { total: 0, counts: {}, metrics: {}, socket: { open: false } };

  function renderHud() {
    onlineEl.textContent = formatNumber(summary.metrics?.online);
    totalEl.textContent = formatNumber(summary.total);

    hud.classList.toggle("live", Boolean(summary.socket?.open));
    hud.classList.toggle("stale", !summary.socket?.open && summary.total > 0);

    // 悬停明细：把每种数据来了多少条列出来
    const rows = Object.entries(summary.counts || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, count]) => {
        const type = typeLabels[id] || id;
        return `<div class="tip-row"><span>${escapeHtml(type)}</span><span>${count}</span></div>`;
      })
      .join("");

    tipBody.innerHTML = rows || '<div class="tip-row"><span>还没收到数据</span></div>';
  }

  // SDK 的类型中文名拿过来，浮窗的 tooltip 就能说人话
  let typeLabels = {};

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  renderHud();

  /* ============================ 位置与拖动 ============================ */

  function restorePosition() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(POS_KEY) || "null");
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;

      host.style.left = `${saved.left}px`;
      host.style.top = `${saved.top}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    } catch {
      // 读不到就用默认位置（右下角）
    }
  }

  function savePosition() {
    try {
      const rect = host.getBoundingClientRect();
      sessionStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    } catch {
      // 存不了也无所谓
    }
  }

  restorePosition();

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  hud.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;

    const rect = host.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;

    hud.setPointerCapture(event.pointerId);
  });

  hud.addEventListener("pointermove", (event) => {
    if (!dragging) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    // 位移超过阈值才算拖动，否则当点击处理
    if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    moved = true;

    host.style.left = `${clamp(originLeft + dx, 0, innerWidth - host.offsetWidth)}px`;
    host.style.top = `${clamp(originTop + dy, 0, innerHeight - host.offsetHeight)}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  });

  hud.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    if (moved) savePosition();
  });

  hud.addEventListener("pointercancel", () => {
    dragging = false;
  });

  /* ============================ 出页面前的打包 ============================ */

  /**
   * 隔离世界这一份 window.Livra 里只有 wire（解码原语，纯函数，两个世界各加载一份）。
   * MAIN world 那个 Livra 在这里是读不到的 —— 两个世界只共享 DOM。
   */
  const { b64 } = window.Livra.wire;

  /**
   * 把消息里的字段字节转成 base64。
   *
   * 扩展的消息通道走 JSON 序列化，Uint8Array 过去就变成 {0:10,1:39,...} 这种普通
   * 对象：既没法再解，占的内存还是原来的十几倍。SDK 在页面里保留的是完整的
   * Uint8Array，这里只是**搬运前换一种装法**，字段本身一个不动 —— 怎么解释这些
   * 字段仍然归展示层。
   */
  function pack(message) {
    if (!message?.fields?.length) return message;

    return {
      ...message,
      fields: message.fields.map((f) => (f.bytes ? { no: f.no, wire: f.wire, b64: b64(f.bytes) } : f)),
    };
  }

  const packAll = (list) => (list || []).map(pack);

  /* ============================ 后台通信 ============================ */

  function toBackground(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // 扩展被重新加载后旧 content script 会失去连接
    }
  }

  /* ============================ 收 SDK 事件 ============================ */

  // 插件重启后 Chrome 会在不刷新页面的情况下重新注入 content script，
  // 这时旧的监听器（扩展上下文已失效）还挂着，必须摘掉，否则每条数据转发两次。
  if (BRIDGE.listener) {
    window.removeEventListener("message", BRIDGE.listener);
    BRIDGE.listener = null;
  }

  function onWindowMessage(event) {
    if (!isCurrentInstance()) return;
    if (event.source !== window) return;

    const data = event.data;
    if (!data || typeof data !== "object") return;

    // 发弹幕的应答
    if (data[NS.protocol.RESULT] === true) {
      const resolve = pendingCalls.get(data.reqId);
      if (resolve) {
        pendingCalls.delete(data.reqId);
        resolve(data.payload);
      }
      return;
    }

    if (data[NS.protocol.EVENT] !== true) return;

    const payload = data.payload || {};

    switch (data.type) {
      case "ready":
        typeLabels = Object.fromEntries((payload.types || []).map((t) => [t.id, t.label]));
        toBackground({ type: "LIVE_READY", href: payload.href, types: payload.types });
        renderHud();
        break;

      case "messages":
        summary = payload.summary || summary;
        renderHud();
        toBackground({
          type: "LIVE_MESSAGES",
          batch: packAll(payload.batch),
          summary: payload.summary,
        });
        break;

      case "metrics":
      case "socket":
      case "reset":
        summary = payload.summary || summary;
        renderHud();
        toBackground({ type: `LIVE_${data.type.toUpperCase()}`, ...payload });
        break;

      // 宿主来了：把漏掉的事件和当前快照整包送过去。
      // SDK 的 ready 事件比 content script 早得多，所以类型清单通常是从这里才拿到的
      case "sync":
        if (payload.types?.length) {
          typeLabels = Object.fromEntries(payload.types.map((t) => [t.id, t.label]));
        }
        summary = payload.summary || summary;
        renderHud();
        toBackground({
          type: "LIVE_SYNC",
          messages: packAll(payload.messages),
          types: payload.types || [],
          summary: payload.summary,
          replace: true,
        });
        break;

      default:
        break;
    }
  }

  BRIDGE.listener = onWindowMessage;
  window.addEventListener("message", onWindowMessage);

  // 立刻向 MAIN world 要一份快照，把启动期间丢的事件补回来
  try {
    window.postMessage({ [NS.protocol.SYNC]: true }, "*");
  } catch {
    // 忽略
  }

  /* ============================ 发弹幕 ============================ */

  // ⚠️ 隔离世界读不到 MAIN world 挂在 window 上的对象，所以发弹幕必须走 postMessage
  // 拜托 index.js，结果也用 postMessage 回传。
  let callSeq = 0;
  const pendingCalls = new Map();

  function callSdk(name, args, timeout = 25000) {
    const reqId = `c${++callSeq}`;

    const done = new Promise((resolve) => {
      pendingCalls.set(reqId, resolve);
      setTimeout(() => {
        if (pendingCalls.delete(reqId)) {
          resolve({ ok: false, error: "SDK 没有响应，刷新直播间再试" });
        }
      }, timeout);
    });

    try {
      window.postMessage({ [NS.protocol.CALL]: true, reqId, name, args: args || [] }, "*");
    } catch {
      // 忽略
    }

    return done;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!isCurrentInstance()) return;

    // 侧边栏要发弹幕
    if (message?.type === "SEND_DANMAKU") {
      callSdk("send", [message.text]).then((payload) => {
        const result = payload?.error
          ? { ok: false, error: payload.error }
          : payload?.value || { ok: false, error: "未知错误" };

        toBackground({ type: "SEND_DANMAKU_RESULT", result });
      });
      return;
    }

    // 侧边栏主动要一次全量快照（比如刚打开面板）
    if (message?.type === "PULL_SNAPSHOT") {
      Promise.all([
        callSdk("state", []),
        callSdk("messages", []),
        callSdk("types", []),
      ]).then(([state, messages, types]) => {
        // 类型清单可能从没推过（面板比浮窗晚到），这里补上
        const catalog = types?.value || [];
        if (catalog.length) {
          typeLabels = Object.fromEntries(catalog.map((t) => [t.id, t.label]));
        }

        toBackground({
          type: "LIVE_SYNC",
          messages: packAll(messages?.value),
          types: catalog,
          summary: state?.value,
          replace: true,
        });
      });
    }
  });
})();
