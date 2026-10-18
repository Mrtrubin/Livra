/**
 * SDK · 传输层 hook
 *
 * 把页面的三个出入口换掉：
 *   1. WebSocket —— 弹幕推送就是这条，必须在页面自己建连接之前换掉，所以本文件要早跑
 *   2. fetch / XMLHttpRequest —— 看页面发了什么，尤其是「发弹幕」那条请求
 *
 * 抓到的东西两处消费：
 *   NS.room.ingest()              解码后的直播数据，进房间状态
 *   NS.bus.fire("outbound", ...)   出站请求，sender.js 靠它定位页面的发送函数
 *
 * 为什么必须在 MAIN world：要 hook 页面自己的 WebSocket 和网络请求，就得和页面
 * 在同一个 JS 环境里。解析好的数据通过 postMessage 交出去（见 bus.js）。
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.transport) return;
  NS.installed.transport = true;

  // 被换掉的原生 API 原件存一份在命名空间里：调试时能比对，必要时能还原
  NS.native = NS.native || {};

  const WEBCAST_WS = /\/webcast\/im\/push\//;
  const CHAT_SEND = /\/webcast\/room\/chat\//i;

  /* ============================ 出站请求 ============================ */

  /** 从聊天发送请求的 URL 里取 content 参数 */
  function decodeContent(url) {
    const matched = /[?&]content=([^&]*)/.exec(String(url || ""));
    if (!matched) return "";

    try {
      return decodeURIComponent(matched[1]);
    } catch {
      return matched[1];
    }
  }

  function recordOutbound(url) {
    if (!CHAT_SEND.test(url)) return;

    // 内部事件：sender.js 靠它定位页面的发送函数，也靠它判断这次发送有没有真的发出去
    NS.bus.fire("outbound", { url, content: decodeContent(url), at: Date.now() });
  }

  /* ============================ WebSocket ============================ */

  function watchSocket(socket, url) {
    if (!WEBCAST_WS.test(url)) return;

    NS.room.setSocket(true, url.split("?")[0]);

    socket.addEventListener("message", (event) => {
      // 只处理二进制帧；"hi" 之类的心跳是文本
      const data = event.data;
      if (typeof data === "string") return;

      (async () => {
        let bytes;
        if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else return;

        try {
          NS.room.ingest(await NS.decoder.decodePushFrame(bytes));
        } catch (error) {
          NS.bus.emit("error", { message: String(error.message || error) });
        }
      })().catch(() => {});
    });

    socket.addEventListener("close", () => {
      NS.room.setSocket(false, url.split("?")[0]);
    });
  }

  const NativeWebSocket = window.WebSocket;
  NS.native.WebSocket = NativeWebSocket;

  function LivraWebSocket(url, protocols) {
    const socket =
      protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);

    try {
      watchSocket(socket, String(url));
    } catch {
      // hook 失败不能影响页面自己的连接
    }

    return socket;
  }

  // 保持原型一致，这样页面里的 instanceof / 静态常量都不受影响
  LivraWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(LivraWebSocket, NativeWebSocket);
  window.WebSocket = LivraWebSocket;

  /* ============================ fetch / XHR ============================ */

  const nativeFetch = window.fetch;
  NS.native.fetch = nativeFetch;

  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input?.url;
        if (url) recordOutbound(String(url));
      } catch {
        // 忽略
      }
      return nativeFetch.apply(this, arguments);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  NS.native.xhrOpen = nativeOpen;
  NS.native.xhrSend = nativeSend;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__livraUrl = String(url);
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      recordOutbound(this.__livraUrl || "");
    } catch {
      // 忽略
    }
    return nativeSend.apply(this, arguments);
  };
})();
