/**
 * SDK · 对外入口（MAIN world，最后加载）
 *
 * 前面几个文件各装各的 hook，这里只做三件事：
 *   1. 把内部模块收拢成一个干净的对外 API
 *   2. 向宿主环境（content script / 调试面板）发 ready 事件
 *   3. 接 SDK 外面的「发弹幕」请求并执行
 *
 * 加载顺序（manifest.json 里写死的）：
 *   namespace.js -> types.js -> bus.js -> protocol/wire.js -> protocol/decoder.js
 *                -> room.js -> transport.js -> sender.js -> index.js
 *
 * 对外 API（宿主环境用 postMessage 调用不了函数，所以调用走请求-应答：
 * 宿主发 { [protocol.CALL]: true, reqId, name, args }，SDK 回 { [protocol.RESULT]: ... }。
 * 标记名统一定义在 namespace.js 的 NS.protocol 里）
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.index) return;
  NS.installed.index = true;

  const bus = NS.bus;

  /* ============================ 调用入口 ============================ */

  // 宿主能调的方法就这几个 —— 桥接层只用得到 send / state / messages / types，
  // 其余的（counts、metrics、clear 等）在主世界里直接访问 NS.room 即可，不必再转一层。
  const api = {
    send: (text) => NS.sender.sendDanmaku(text),
    state: () => NS.room.state(),
    messages: (limit) => NS.room.messages(limit),
    types: () => NS.types.catalog(),
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data[NS.protocol.CALL] !== true) return;

    const { reqId, name, args } = data;
    const fn = api[name];

    const reply = (payload) => {
      try {
        window.postMessage({ [NS.protocol.RESULT]: true, reqId, payload }, "*");
      } catch {
        // 忽略
      }
    };

    if (typeof fn !== "function") {
      reply({ error: `SDK 没有这个方法: ${name}` });
      return;
    }

    Promise.resolve()
      .then(() => fn(...(Array.isArray(args) ? args : [])))
      .then((value) => reply({ ok: true, value: value ?? null }))
      .catch((error) => reply({ ok: false, error: String(error?.message || error) }));
  });

  /* ============================ 宿主来了：补欠的事件 ============================ */

  // SDK 在 document_start 就装好了，宿主（content script）要 document_idle 才接进来。
  // 中间产生的事件在 bus 的 outbox 里，宿主一来就整包给它。
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.[NS.protocol.SYNC] !== true) return;

    const missed = bus.drainOutbox();

    try {
      window.postMessage({
        [NS.protocol.EVENT]: true,
        type: "sync",
        payload: {
          missed,
          summary: NS.room.state(),
          messages: NS.room.messages(),
          types: NS.types.catalog(),
        },
      }, "*");
    } catch {
      // 忽略
    }
  });

  /* ============================ 暴露 ============================ */

  NS.send = api.send;

  bus.emit("ready", {
    href: location.href,
    summary: NS.room.state(),
    types: NS.types.catalog(),
  });
})();
