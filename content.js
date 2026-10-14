/**
 * Livra —— 页面内悬浮开关
 *
 * content script 天然是「每个标签页一份」，所以这个开关本身就按标签独立：
 * 在 A 标签开启不会影响 B 标签。
 *
 * 点按钮 -> 通知 service worker 对「当前标签页」开/关改写。
 * 界面放在 shadow DOM 里，避免和宿主页面的样式互相污染。
 */
(() => {
  const HOST_ID = "livra-floating-button";
  // sessionStorage 天然按标签页隔离（同一标签内刷新也还在），正好用来记按钮位置
  const POS_KEY = "__livra_pos__";

  // 插件重启后 Chrome 会往已打开的页面里重新注入 content script，DOM 里还留着旧实例的按钮。
  // 旧按钮上的点击监听属于已经失效的扩展上下文（点了没反应），所以直接拆掉重建一份。
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  if (document.getElementById(HOST_ID)) return;

  /* ============================ 界面 ============================ */

  const host = document.createElement("div");
  host.id = HOST_ID;
  // all:initial 先切断宿主页面的样式继承，后面几条再把它覆盖回来
  host.style.cssText = [
    "all:initial",
    "display:block",
    "position:fixed",
    "z-index:2147483647",
    "right:16px",
    "bottom:16px"
  ].join(";");

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      .btn {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 13px;
        border: 0; border-radius: 999px;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
        letter-spacing: 0;
        color: #f8fafc; background: rgba(30, 41, 59, .92);
        box-shadow: 0 4px 14px rgba(0, 0, 0, .28);
        cursor: pointer; white-space: nowrap;
        touch-action: none;
        transition: background .15s ease;
      }
      .btn:hover { background: rgba(15, 23, 42, .97); }
      .btn.on { background: rgba(21, 94, 51, .95); }
      .btn.on:hover { background: rgba(20, 83, 45, .98); }
      .btn.err { background: rgba(153, 27, 27, .95); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; flex: none; }
      .btn.on .dot { background: #4ade80; }
      .btn.pending .dot { animation: livra-pulse .9s ease-in-out infinite; }
      @keyframes livra-pulse { 50% { opacity: .2; } }
    </style>
    <button class="btn" type="button">
      <span class="dot"></span><span class="label">Livra</span>
    </button>
  `;

  document.documentElement.appendChild(host);

  const btn = root.querySelector(".btn");
  const label = root.querySelector(".label");

  /* ============================ 状态 ============================ */

  let state = { enabled: false, count: 0, error: "" };
  let pending = false;
  let errorTimer = null;

  function render() {
    btn.classList.toggle("on", state.enabled && !state.error);
    btn.classList.toggle("err", Boolean(state.error));
    btn.classList.toggle("pending", pending);

    if (state.error) {
      label.textContent = state.error;
      return;
    }

    if (!state.enabled) {
      label.textContent = "Livra · 改写";
      return;
    }

    label.textContent = state.count > 0 ? `改写中 · ${state.count}` : "改写中";
  }

  function setError(message) {
    state = { enabled: false, count: 0, error: message };
    render();

    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorTimer = null;
      state = { ...state, error: "" };
      render();
    }, 4000);
  }

  render();

  /* ============================ 位置 ============================ */

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

  /* ============================ 拖动 ============================ */

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  btn.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;

    const rect = host.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;

    btn.setPointerCapture(event.pointerId);
  });

  btn.addEventListener("pointermove", (event) => {
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

  btn.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    if (moved) savePosition();
  });

  btn.addEventListener("pointercancel", () => {
    dragging = false;
  });

  /* ============================ 和后台通信 ============================ */

  function send(type) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage({ type })).catch(() => null);
    } catch {
      // 扩展被重新加载后旧 content script 会失去连接
      return Promise.resolve(null);
    }
  }

  btn.addEventListener("click", () => {
    // 拖动结束的那一下不算点击
    if (moved) {
      moved = false;
      return;
    }

    pending = true;
    render();

    send("TOGGLE_REWRITE").then((response) => {
      pending = false;

      if (!response) {
        setError("扩展已重新加载，刷新页面");
        return;
      }

      if (response.error) {
        setError(response.error);
        return;
      }

      if (response.state) state = response.state;
      render();
    });
  });

  /* ============================ 幂等 ============================ */

  // 同一个页面里可能同时存在多个 content script 实例：
  //   - manifest 里声明的（页面加载时注入）
  //   - 插件重启后由 service worker 主动补注入的（executeScript）
  // 两个实例都会收到后台消息，一条消息被处理两遍 —— 表现为弹幕内容被塞进输入框两次、
  // 弹幕列表重复。所以只让**最新的那个实例**响应。
  //
  // 用挂在 window 上的计数判断（隔离世界之间共享 window 对象上的属性）。
  window.__livraCsGen = (Number(window.__livraCsGen) || 0) + 1;
  const myGen = window.__livraCsGen;

  function isCurrentInstance() {
    return window.__livraCsGen === myGen;
  }

  chrome.runtime.onMessage.addListener((message) => {
    // 调试日志：转发给后台，方便用 bridge.js sw 读
    chrome.runtime.sendMessage({
      type: "CS_LOG",
      entry: {
        type: message?.type,
        current: isCurrentInstance(),
        gen: window.__livraCsGen,
        myGen,
        at: Date.now(),
      },
    }).catch(() => {});

    if (!isCurrentInstance()) return;

    if (message?.type === "TAB_STATE_CHANGED") {
      state = message.state;
      render();
      return;
    }

    // 侧边栏要发弹幕 -> 转发给 MAIN world 的 hook，让它去操作页面的输入框
    if (message?.type === "SEND_DANMAKU") {
      requestDanmakuSend(message.text).then((result) => {
        chrome.runtime.sendMessage({ type: "SEND_DANMAKU_RESULT", result }).catch(() => {});
      });
    }
  });

  // 页面加载/刷新后同步一次当前标签页的真实状态
  send("GET_TAB_STATE").then((response) => {
    if (response?.state) {
      state = response.state;
      render();
    }
  });

  /* ============================ 发弹幕 ============================ */

  // ⚠️ 关键：隔离世界**读不到** MAIN world 挂在 window 上的对象
  // （`window.__livraLive` 在 content script 里是 undefined，两边只共享 DOM）。
  // 所以发弹幕必须走 postMessage 拜托 injected.js，结果也用 postMessage 回传。
  let sendSeq = 0;
  const pendingSends = new Map();

  function requestDanmakuSend(text) {
    const reqId = `s${++sendSeq}`;

    const done = new Promise((resolve) => {
      pendingSends.set(reqId, resolve);

      // 没人应答就给个明确反馈，不然用户看着像卡死
      setTimeout(() => {
        if (pendingSends.delete(reqId)) {
          resolve({ ok: false, error: "页面没有响应，刷新直播间再试" });
        }
      }, 4000);
    });

    try {
      window.postMessage({ __livraSend: true, reqId, text: String(text || "") }, "*");
    } catch {
      // 忽略
    }

    return done;
  }

  /* ============================ 直播数据中转 ============================ */

  // MAIN world 的 injected.js 用 postMessage 把解析好的直播数据发过来，
  // 这里攒一小批再转给后台，避免每条弹幕都走一次消息。
  const FLUSH_MS = 400;

  let liveQueue = [];
  let pendingStats = null;
  let flushTimer = null;

  function flushLive(replace = false) {
    flushTimer = null;

    if (!liveQueue.length && !pendingStats) return;

    const batch = liveQueue;
    const stats = pendingStats;
    liveQueue = [];
    pendingStats = null;

    chrome.runtime
      .sendMessage({ type: "LIVE_DATA", batch, stats, replace })
      .catch(() => {});
  }

  function scheduleFlush(replace = false) {
    if (!flushTimer) {
      flushTimer = setTimeout(flushLive, FLUSH_MS);
    }
    // replace 走完后要真的发一次，不能只挂个定时器
    if (replace) flushLive(true);
  }

  // 保存监听器引用。插件重启后 Chrome 会在不刷新页面的情况下重新注入 content script，
  // 这时旧的监听器（扩展上下文已失效）还在 window 上，必须摘掉，否则每条弹幕会被转发两次。
  const LIVRA_LISTENER_KEY = "__livraWinListener";
  if (window[LIVRA_LISTENER_KEY]) {
    window.removeEventListener("message", window[LIVRA_LISTENER_KEY]);
    window[LIVRA_LISTENER_KEY] = null;
  }

  function onWindowMessage(event) {
    // 只让最新实例转发，避免多个实例把同一批弹幕发两遍
    if (!isCurrentInstance()) return;

    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.__livraLive !== true) return;

    switch (data.type) {
      case "ready":
        chrome.runtime.sendMessage({ type: "LIVE_READY", href: data.payload?.href }).catch(() => {});
        break;

      case "socket":
        chrome.runtime.sendMessage({ type: "LIVE_SOCKET", ...data.payload }).catch(() => {});
        break;

      case "messages":
        if (data.payload?.batch?.length) liveQueue.push(...data.payload.batch);
        if (data.payload?.stats) pendingStats = data.payload.stats;
        scheduleFlush();
        break;

      case "snapshot": {
        const snap = data.payload || {};

        // replace 语义：直接覆盖后台的列表，避免和已收到的重复
        if (Array.isArray(snap.recent) && snap.recent.length) {
          liveQueue = snap.recent.slice();
          pendingStats = snap.stats || pendingStats;
          scheduleFlush({ replace: true });
        }

        chrome.runtime.sendMessage({
          type: "LIVE_SOCKET",
          state: snap.socketOpen ? "open" : "closed",
          url: "",
        }).catch(() => {});
        break;
      }

      // MAIN world 回报发弹幕的结果
      case "send-result": {
        const resolve = pendingSends.get(data.reqId);
        if (resolve) {
          pendingSends.delete(data.reqId);
          resolve(data.payload);
        }
        break;
      }

      case "outbound":
        chrome.runtime.sendMessage({ type: "LIVE_OUTBOUND", ...data.payload }).catch(() => {});
        break;

      case "ws-send":
        chrome.runtime.sendMessage({
          type: "LIVE_OUTBOUND",
          transport: data.payload?.transport || "websocket",
          method: "WS-SEND",
          url: "",
          body: JSON.stringify(data.payload),
        }).catch(() => {});
        break;

      default:
        break;
    }
  }

  window[LIVRA_LISTENER_KEY] = onWindowMessage;
  window.addEventListener("message", onWindowMessage);

  // 立刻向 MAIN world 要一份快照，把启动期间丢的事件补回来
  try {
    window.postMessage({ __livraSync: true }, "*");
  } catch {
    // 忽略
  }
})();
