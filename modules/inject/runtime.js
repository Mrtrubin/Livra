/**
 * 注入模块 · 运行时（MAIN world，第一个加载）
 *
 * 职责：攒状态（统计 / 最近弹幕 / 在线人数）+ 把事件发回扩展 + 模块之间的小事件总线。
 * 其他几个文件都挂在同一个命名空间 window.__livraNS 上，靠它串起来。
 *
 * 为什么要有 outbox：本文件在 document_start 跑，content script 在 document_idle 才跑，
 * 中间这几十秒产生的事件没有监听者会全丢，所以先存着，等对方来要（__livraSync）。
 */
(() => {
  const NS = (window.__livraNS = window.__livraNS || {});

  // 整套 hook 只装一次（重复注入时直接跳过，避免叠加副作用）
  if (NS.installed) return;

  const MAX_RECENT = 200;
  const MAX_OUTBOX = 50;

  const stats = { messages: 0, byMethod: {}, online: null, lastAt: 0 };
  const recent = [];
  const outbox = [];

  let seq = 0;
  let socketOpen = false;

  /* ============================ 模块间小事件总线 ============================ */

  // 内部用：transport 抓到东西 -> sender 消费（例如「页面发了一条弹幕」）
  const subs = new Map();

  const bus = {
    on(type, fn) {
      if (!subs.has(type)) subs.set(type, []);
      subs.get(type).push(fn);
    },

    fire(type, payload) {
      for (const fn of subs.get(type) || []) {
        try {
          fn(payload);
        } catch {
          // 一个订阅者出错不能影响其他订阅者和页面
        }
      }
    },
  };

  /* ============================ 上报给扩展 ============================ */

  function emit(type, payload) {
    const event = { seq: ++seq, type, payload };

    outbox.push(event);
    if (outbox.length > MAX_OUTBOX) outbox.shift();

    try {
      window.postMessage({ __livraLive: true, ...event }, "*");
    } catch {
      // 页面 CSP 极严时可能失败，忽略
    }
  }

  // content script 启动后来要一份快照，把启动期间丢的事件补上
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.__livraSync !== true) return;

    try {
      window.postMessage({
        __livraLive: true,
        seq: ++seq,
        type: "snapshot",
        payload: {
          stats: snapshot(),
          socketOpen,
          recent: recent.slice(-80),
        },
      }, "*");
    } catch {
      // 忽略
    }
  });

  /* ============================ 状态 ============================ */

  function snapshot() {
    return {
      messages: stats.messages,
      byMethod: stats.byMethod,
      online: stats.online,
      lastAt: stats.lastAt,
    };
  }

  function handleMessages(messages) {
    if (!messages.length) return;

    const batch = [];

    for (const message of messages) {
      stats.messages++;
      stats.byMethod[message.method] = (stats.byMethod[message.method] || 0) + 1;
      stats.lastAt = Date.now();

      if (message.kind === "online" && message.online != null) {
        stats.online = message.online;
      }

      // 弹幕和进场才进列表，其余只计数
      if (message.kind === "danmaku" || message.kind === "gift" || message.kind === "enter") {
        recent.push(message);
        if (recent.length > MAX_RECENT) recent.shift();
        batch.push(message);
      }
    }

    emit("messages", { batch, stats: snapshot() });
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  NS.bus = bus;
  NS.runtime = {
    emit,
    snapshot,
    handleMessages,
    wait,
    recent: () => recent.slice(-50),
    isSocketOpen: () => socketOpen,
    setSocketOpen: (open) => {
      socketOpen = Boolean(open);
    },
  };
})();
