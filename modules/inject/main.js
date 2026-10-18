/**
 * 注入模块 · 入口（MAIN world，最后加载）
 *
 * 职责：把前面几个模块组装成对外的 window.__livraLive，并处理扩展发来的「发弹幕」请求。
 * 前面几个文件各装各的 hook，这里只做接线。
 *
 * 加载顺序（manifest.json 里写死的）：
 *   runtime.js -> protobuf.js -> transport.js -> sender.js -> main.js
 */
(() => {
  const NS = (window.__livraNS = window.__livraNS || {});

  // 整套 hook 只装一次
  if (NS.installed) return;

  /**
   * 扩展侧（bridge.js）要发弹幕 -> 走这里。
   * 隔离世界读不到 MAIN world 挂在 window 上的对象，只能 postMessage 进来，
   * 结果也用 postMessage 回传。
   */
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.__livraSend !== true) return;

    const { reqId, text } = event.data;

    NS.sender.log({ phase: "收到发送请求", text: String(text).slice(0, 40), at: Date.now() });

    Promise.resolve()
      .then(() => NS.sender.sendDanmaku(text))
      .then((result) => {
        NS.sender.log({
          phase: "发送结果",
          ok: Boolean(result && result.ok),
          note: result && result.note,
          error: result && result.error,
          debug: result && result.debug,
          at: Date.now(),
        });

        try {
          window.postMessage({ __livraLive: true, type: "send-result", reqId, payload: result }, "*");
        } catch {
          // 忽略
        }
      })
      .catch((error) => {
        NS.sender.log({ phase: "发送异常", error: String(error.message || error), at: Date.now() });

        try {
          window.postMessage({
            __livraLive: true,
            type: "send-result",
            reqId,
            payload: { ok: false, error: String(error.message || error) },
          }, "*");
        } catch {
          // 忽略
        }
      });
  });

  // 对外 API：bridge.js 和调试脚本都用这一份
  window.__livraLive = {
    stats: NS.runtime.snapshot,
    recent: NS.runtime.recent,
    outbound: NS.transport.outbound,
    wsSends: NS.transport.wsSends,

    sendDanmaku: NS.sender.sendDanmaku,
    sendFn: NS.sender.sendFn,
    discover: NS.sender.discover,
    sendLog: NS.sender.sendLog,
  };

  NS.installed = true;
  window.__livraHook = true;

  NS.runtime.emit("ready", { href: location.href });
})();
