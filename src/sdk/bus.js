/**
 * SDK · 事件总线
 *
 * 两个用途：
 *   1. SDK 内部模块之间通信（transport 抓到东西 -> room 消费）
 *   2. 把事件发到 SDK 外面给宿主环境（content script / 调试面板）
 *
 * 为什么要有 outbox：本 SDK 在 document_start 就跑起来了，宿主环境的监听器可能
 * 几十毫秒后才接进来（content script 是 document_idle）。中间产生的事件先存着，
 * 宿主一来 ,就整包补给它。
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.bus) return;
  NS.installed.bus = true;

  const MAX_OUTBOX = 120;

  const listeners = new Map();
  const outbox = [];

  let seq = 0;

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);

    // 返回退订函数，方便用一次就走
    return () => listeners.get(type)?.delete(fn);
  }

  function off(type, fn) {
    listeners.get(type)?.delete(fn);
  }

  /**
   * 广播事件。同时做两件事：
   *   - 通知本地订阅者
   *   - 存一份进 outbox，并用 postMessage 发给宿主环境
   */
  function emit(type, payload) {
    const event = { seq: ++seq, type, payload, at: Date.now() };

    outbox.push(event);
    if (outbox.length > MAX_OUTBOX) outbox.shift();

    for (const fn of listeners.get(type) || []) {
      try {
        fn(payload, event);
      } catch {
        // 一个订阅者出错不能影响其他订阅者，更不能影响页面
      }
    }

    try {
      window.postMessage({ [NS.protocol.EVENT]: true, ...event }, "*");
    } catch {
      // 页面 CSP 极严时可能失败，忽略
    }

    return event;
  }

  /** 只通知本地订阅者，不外发。用于模块内部的细 cooperation。 */
  function fire(type, payload) {
    for (const fn of listeners.get(type) || []) {
      try {
        fn(payload);
      } catch {
        // 同上
      }
    }
  }

  /** 宿主环境接进来时调用：返回它漏掉的事件，并清掉 outbox */
  function drainOutbox() {
    const events = outbox.slice();
    outbox.length = 0;
    return events;
  }

  NS.bus = { on, off, emit, fire, drainOutbox };
})();
