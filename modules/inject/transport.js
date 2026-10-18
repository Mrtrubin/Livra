/**
 * 注入模块 · 传输层 hook（MAIN world）
 *
 * 职责：把页面的三个出入口换掉 ——
 *   1. WebSocket（弹幕推送就是这条，必须在页面自己建连接之前换掉，所以本文件要早跑）
 *   2. fetch / XMLHttpRequest（读：看页面发了什么；写：抓「发弹幕」的入口 + 判断发送成功没）
 *
 * 抓到的出站聊天请求会通过 NS.bus 广播出去（sender.js 订阅），
 * 同时用 NS.runtime.emit() 转发给扩展侧。
 *
 * 为什么必须在 MAIN world：要 hook 页面自己的 WebSocket 和网络请求，
 * 就得和页面在同一个 JS 环境里。解析好的数据通过 window.postMessage 交给 bridge.js（隔离世界）。
 */
(() => {
  const NS = (window.__livraNS = window.__livraNS || {});
  if (NS.installed) return;

  const WEBCAST_WS = /\/webcast\/im\/push\//;
  const CHAT_SEND = /\/webcast\/room\/chat\//i;

  const outbound = [];
  const wsSends = [];

  const decoder = new TextDecoder("utf-8");

  /* ============================ 工具 ============================ */

  // 抓调用栈的文本形式：只用于出站记录的展示（定位是哪个模块在发）
  function captureStack() {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 25;
    const error = new Error();
    Error.stackTraceLimit = limit;

    return String(error.stack || "")
      .split("\n")
      .slice(1, 40)
      .map((s) => s.trim())
      .join("\n");
  }

  // 从发弹幕的 URL 里取出 content 参数（已 decode）
  function decodeContent(url) {
    const matched = /[?&]content=([^&]*)/.exec(String(url || ""));
    if (!matched) return "";

    try {
      return decodeURIComponent(matched[1]);
    } catch {
      return matched[1];
    }
  }

  /* ============================ 出站请求 ============================ */

  function recordOutbound(method, url, body) {
    if (!CHAT_SEND.test(url)) return;

    const payload = {
      method,
      url,
      body: String(body || "").slice(0, 2000),
      stack: captureStack(),
      content: decodeContent(url),
      at: Date.now(),
    };

    outbound.push(payload);
    if (outbound.length > 20) outbound.shift();

    // 模块内部：sender.js 靠它抓发送函数、判断这次发送有没有真的发出去
    NS.bus.fire("outbound", payload);

    // 扩展侧：调试面板里能看到页面发了什么
    NS.runtime.emit("outbound", {
      method: payload.method,
      url: payload.url,
      body: payload.body,
    });
  }

  /* ============================ WebSocket ============================ */

  function watchSocket(socket, url) {
    if (!WEBCAST_WS.test(url)) return;

    NS.runtime.setSocketOpen(true);
    NS.runtime.emit("socket", { state: "open", url: url.split("?")[0] });

    socket.addEventListener("message", (event) => {
      // 只处理二进制帧（opcode 2）；"hi" 之类的心跳是文本
      const data = event.data;
      if (typeof data === "string") return;

      const finish = async () => {
        let bytes;
        if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else return;

        try {
          NS.runtime.handleMessages(await NS.protobuf.decodePushFrame(bytes));
        } catch (error) {
          NS.runtime.emit("error", { message: String(error.message || error) });
        }
      };

      finish().catch(() => {});
    });

    socket.addEventListener("close", () => {
      NS.runtime.setSocketOpen(false);
      NS.runtime.emit("socket", { state: "closed", url: url.split("?")[0] });
    });

    // 也拦发送：弹幕有可能不走 HTTP 而是直接走这条 WS
    try {
      const nativeSend = socket.send.bind(socket);

      socket.send = function (...args) {
        const data = args[0];

        try {
          if (typeof data === "string") {
            recordWsSend({ text: data.slice(0, 200) });
          } else if (data && (data.byteLength || data.size)) {
            let bytes = null;
            if (!(data instanceof Blob) && data instanceof ArrayBuffer) bytes = new Uint8Array(data);
            else if (!(data instanceof Blob)) bytes = data;

            recordWsSend({
              len: data.byteLength || data.size,
              preview: bytes ? decoder.decode(bytes.subarray(0, 60)) : null,
            });
          }
        } catch {
          // 拦发送失败不影响发送本身
        }

        return nativeSend(...args);
      };
    } catch {
      // 有些页面把 send 设成不可写，忽略
    }
  }

  function recordWsSend(info) {
    wsSends.push({ ...info, at: Date.now() });
    if (wsSends.length > 40) wsSends.shift();

    NS.runtime.emit("ws-send", { transport: "websocket", ...info });
  }

  const NativeWebSocket = window.WebSocket;

  function LivraWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);

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
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input?.url;
        if (url) recordOutbound(init?.method || "GET", String(url), init?.body);
      } catch {
        // 忽略
      }
      return nativeFetch.apply(this, arguments);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__livraUrl = String(url);
    this.__livraMethod = method;
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      recordOutbound(this.__livraMethod || "GET", this.__livraUrl || "", body);
    } catch {
      // 忽略
    }
    return nativeSend.apply(this, arguments);
  };

  NS.transport = {
    outbound: () => outbound.slice(),
    wsSends: () => wsSends.slice(-20),
    decodeContent,
  };
})();
