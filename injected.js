/**
 * Livra —— 直播间数据 hook（跑在 MAIN world）
 *
 * 为什么必须在 MAIN world：要 hook 页面自己的 WebSocket 和网络请求，就得和页面在同一个 JS 环境里。
 * 解析好的数据通过 window.postMessage 交给 content.js（隔离世界），再转给后台和侧边栏。
 *
 * 抖音直播的弹幕走 wss://webcast*-ws-web-*.douyin.com/webcast/im/push/v2/，
 * 帧是 PushFrame protobuf，里面 #8 是 gzip 压缩的 Response，Response.#1 是重复的 Message。
 * 各消息的字段布局见 .workbuddy-ai/memory/MEMORY.md。
 */
(() => {
  if (window.__livraLive) return;

  const WEBCAST_WS = /\/webcast\/im\/push\//;
  const MAX_RECENT = 200;

  /* ============================ protobuf ============================ */

  function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;

    while (pos < buf.length) {
      const byte = buf[pos++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (!(byte & 0x80)) return [result, pos];
    }

    throw new Error("varint 越界");
  }

  function decodeFields(buf) {
    const fields = [];
    let pos = 0;

    while (pos < buf.length) {
      const [tag, afterTag] = readVarint(buf, pos);
      pos = afterTag;

      const no = tag >> 3;
      const wire = tag & 7;

      if (wire === 0) {
        const [value, after] = readVarint(buf, pos);
        pos = after;
        fields.push({ no, wire, value });
      } else if (wire === 2) {
        const [len, afterLen] = readVarint(buf, pos);
        pos = afterLen;
        fields.push({ no, wire, bytes: buf.subarray(pos, pos + len) });
        pos += len;
      } else if (wire === 5) {
        fields.push({ no, wire, value: buf.readUInt32LE(pos) });
        pos += 4;
      } else if (wire === 1) {
        fields.push({ no, wire, value: Number(buf.readBigUInt64LE(pos)) });
        pos += 8;
      } else {
        throw new Error(`未知 wire type ${wire}`);
      }
    }

    return fields;
  }

  // 注意：浏览器里 Uint8Array 没有 toString("utf8")（那是 Node Buffer 才有），
  // 直接调会得到一串用逗号分隔的十进制数字，而且不报错。必须用 TextDecoder。
  const decoder = new TextDecoder("utf-8");
  const str = (field) => (field?.bytes ? decoder.decode(field.bytes) : "");

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ============================ gzip ============================ */

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ============================ 消息解析 ============================ */

  // PushFrame.#5 是重复的 header（#1=key, #2=value）
  function readHeaders(fields) {
    const headers = {};

    for (const field of fields.filter((f) => f.no === 5)) {
      const kv = decodeFields(field.bytes);
      const key = str(kv.find((f) => f.no === 1));
      const value = str(kv.find((f) => f.no === 2));
      if (key) headers[key] = value;
    }

    return headers;
  }

  function readUser(body) {
    const fields = decodeFields(body);
    const user = fields.find((f) => f.no === 2)?.bytes;
    if (!user) return null;

    const userFields = decodeFields(user);

    return {
      id: String(userFields.find((f) => f.no === 1)?.value ?? ""),
      nickname: str(userFields.find((f) => f.no === 3)) || "(未知用户)"
    };
  }

  // 把一条 Message 变成侧边栏能直接用的结构
  function extractMessage(method, body) {
    const fields = decodeFields(body);
    const base = { method };

    const common = fields.find((f) => f.no === 1)?.bytes;
    if (common) {
      base.msgId = String(decodeFields(common).find((f) => f.no === 2)?.value ?? "");
    }

    const user = readUser(body);
    if (user) {
      base.userId = user.id;
      base.nickname = user.nickname;
    }

    switch (method) {
      case "WebcastChatMessage":
        // #3 = 弹幕正文，#15 = 秒级时间戳
        base.kind = "danmaku";
        base.content = str(fields.find((f) => f.no === 3));
        base.ts = fields.find((f) => f.no === 15)?.value ?? null;
        break;

      case "WebcastMemberMessage":
        base.kind = "enter";
        base.content = "来了";
        break;

      case "WebcastLikeMessage":
        base.kind = "like";
        base.content = "点了赞";
        break;

      case "WebcastGiftMessage":
        base.kind = "gift";
        base.content = "送出礼物";
        break;

      case "WebcastSocialMessage":
        base.kind = "social";
        base.content = "关注了主播";
        break;

      case "WebcastRoomUserSeqMessage":
        // #7 = 在线人数
        base.kind = "online";
        base.online = fields.find((f) => f.no === 7)?.value ?? null;
        break;

      case "WebcastRoomStatsMessage":
        base.kind = "stats";
        base.content = str(fields.find((f) => f.no === 2));
        break;

      default:
        base.kind = "other";
        break;
    }

    return base;
  }

  async function decodePushFrame(bytes) {
    const fields = decodeFields(bytes);
    const seqId = fields.find((f) => f.no === 1)?.value;

    // seqId = 1 是心跳
    if (seqId === 1) return [];

    const payload = fields.find((f) => f.no === 8)?.bytes;
    if (!payload || payload.length < 2) return [];

    const headers = readHeaders(fields);

    let plain = payload;
    if (payload[0] === 0x1f && payload[1] === 0x8b) {
      plain = await gunzip(payload);
    } else if (headers.compress_type === "gzip") {
      plain = await gunzip(payload);
    }

    const response = decodeFields(plain);
    const out = [];

    for (const field of response.filter((f) => f.no === 1)) {
      try {
        const message = decodeFields(field.bytes);
        const method = str(message.find((f) => f.no === 1));
        const body = message.find((f) => f.no === 2)?.bytes;
        if (!method || !body) continue;
        out.push(extractMessage(method, body));
      } catch {
        // 单条消息解不开就跳过，不影响整帧
      }
    }

    return out;
  }

  /* ============================ 状态 & 上报 ============================ */

  const stats = { messages: 0, byMethod: {}, online: null, lastAt: 0 };
  const recent = [];
  let socketOpen = false;

  // content script 跑在 document_idle，比本脚本（document_start）晚很多，
  // 这期间产生的 socket / messages 事件会因为没有监听者而丢掉。
  // 所以这里留一个 outbox，让 content script 启动后可以要点补发。
  const outbox = [];
  const MAX_OUTBOX = 50;
  let seq = 0;

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

  // content script 启动后来要一份快照，把丢的事件补上
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data) return;

    // content script 转发来的「发弹幕」请求。隔离世界读不到这里的对象，
    // 所以只能走 postMessage，结果也用 postMessage 回传。
    if (event.data.__livraSend === true) {
      const { reqId, text } = event.data;

      sendLog.push({ phase: "收到发送请求", text: String(text).slice(0, 40), at: Date.now() });

      Promise.resolve()
        .then(() => window.__livraLive.sendDanmaku(text))
        .then((result) => {
          sendLog.push({
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
          sendLog.push({ phase: "发送异常", error: String(error.message || error), at: Date.now() });

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

      return;
    }

    if (event.data.__livraSync !== true) return;

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

  function snapshot() {
    return {
      messages: stats.messages,
      byMethod: stats.byMethod,
      online: stats.online,
      lastAt: stats.lastAt
    };
  }

  /* ============================ hook WebSocket ============================ */

  const NativeWebSocket = window.WebSocket;

  function watchSocket(socket, url) {
    if (!WEBCAST_WS.test(url)) return;

    socketOpen = true;
    emit("socket", { state: "open", url: url.split("?")[0] });

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
          handleMessages(await decodePushFrame(bytes));
        } catch (error) {
          stats.error = String(error.message || error);
        }
      };

      finish().catch(() => {});
    });

    socket.addEventListener("close", () => {
      socketOpen = false;
      emit("socket", { state: "closed", url: url.split("?")[0] });
    });

    // 也拦发送：弹幕有可能不走 HTTP 而是直接走这条 WS
    try {
      const nativeSend = socket.send.bind(socket);
      socket.send = function (...args) {
        const data = args[0];

        try {
          if (typeof data === "string") {
            wsSends.push({ text: data.slice(0, 200), at: Date.now() });
            emit("ws-send", { transport: "websocket", body: data.slice(0, 500) });
          } else if (data && (data.byteLength || data.size)) {
            let bytes;
            if (data instanceof Blob) bytes = null;
            else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
            else bytes = data;

            wsSends.push({
              len: data.byteLength || data.size,
              preview: bytes ? decoder.decode(bytes.subarray(0, 60)) : null,
              at: Date.now(),
            });

            emit("ws-send", {
              transport: "websocket",
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

  /* ============================ hook 网络请求（找发送弹幕的入口） ============================ */

  const CHAT_SEND = /\/webcast\/room\/chat\//i;
  const outbound = [];
  const wsSends = [];
  const sendLog = [];

  // 抓到的「页面自己发弹幕那个函数」。
  // 直接拿函数引用 + 当时的入参，之后我们就能复用它来发送，完全不需要模拟输入框和键盘，
  // 也就不依赖页面有没有焦点了。
  let capturedSendFn = null;
  let capturedSendInfo = null;
  let lastSentContent = "";

  /**
   * 抓调用栈里的业务函数。
   *
   * 用 Error.prepareStackTrace 拿到 CallSite 对象数组，这样除了 文件:行:列 还能拿到
   * `getFunction()`（函数本体）和 `getArguments()`（当时的入参）。
   *
   * 为什么要跳过那几层：请求是先经过 secsdk / bdms.js 的 XHR 封装（那才是算 a_bogus 的地方），
   * 再进 webcast SDK 的业务函数。我们要的是最靠近业务的那一层。
   */
  /**
   * 抓调用栈里的业务函数。
   *
   * 用 Error.prepareStackTrace 拿到 CallSite 对象，这样除了 文件:行:列 还能拿到
   * `getFunction()`（函数本体）和 `getArguments()`（当时的入参）。
   *
   * ⚠️ 两个关键点，踩过：
   * 1. V8 的 CallSite 对象**只在 prepareStackTrace 回调执行期间有效**，回调一返回就被释放，
   *    所以 getFunction()/getArguments() 必须在回调里同步调完，不能把 sites 存下来回头再用。
   * 2. 为什么要跳过那几层：请求是先经过 secsdk / bdms.js 的 XHR 封装（那才是算 a_bogus 的地方），
   *    再进 webcast SDK 的业务函数。我们要的是最靠近业务的那一层。
   */
  function captureSendSite() {
    let captured = null;
    let diagnostics = [];

    // ⚠️ 默认 stackTraceLimit 只有 10，而算 a_bogus 的安全 SDK 自己就占了 10 多帧，
    // 不调大根本看不到外面的业务函数。
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;

    const previous = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, sites) => {
      // 必须在回调里同步用完 —— V8 的 CallSite 离开这个回调就失效
      diagnostics = sites.map((site) => {
        try {
          return {
            file: String(site.getFileName() || "").slice(0, 100),
            line: site.getLineNumber(),
            fnType: typeof site.getFunction(),
            name: site.getFunctionName() || "",
          };
        } catch (error) {
          return { error: String(error.message || error) };
        }
      });

      for (const site of sites) {
        const file = site.getFileName() || "";

        if (captured) break;
        if (file.startsWith("chrome-extension://")) continue;
        if (/secsdk|security|runtime\.js|sdk-glue|bdms\.js/.test(file)) continue;
        if (typeof site.getFunction() !== "function") continue;

        captured = {
          file,
          line: site.getLineNumber(),
          column: site.getColumnNumber(),
          name: site.getFunctionName() || "(匿名)",
          fn: site.getFunction(),
          args: site.getArguments(),
        };
      }

      return sites;
    };

    try {
      void new Error().stack;
    } finally {
      Error.prepareStackTrace = previous;
      Error.stackTraceLimit = limit;
    }

    if (!captured) captured = { diagnostics, total: diagnostics.length };
    return captured;
  }

  // 抓调用栈：用来定位「页面自己那个发弹幕的函数」在哪。
  // 拿到栈里的 文件:行:列，就能知道是哪个模块在发，进而想办法直接调它，
  // 而不是靠模拟输入框 + 回车（那条路依赖页面有焦点）。
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

  function recordOutbound(method, url, body) {
    if (!CHAT_SEND.test(url)) return;

    const stack = captureStack();

    outbound.push({ method, url, body: String(body || "").slice(0, 2000), stack, at: Date.now() });
    if (outbound.length > 20) outbound.shift();

    // 顺便把页面自己的发送函数抓下来，后面直接复用它
    try {
      const site = captureSendSite();
      if (site && site.fn) {        capturedSendFn = site.fn;
        capturedSendFn.__livraArgs = site.args;
        capturedSendFn.__livraThis = undefined;
        capturedSendInfo = {
          file: site.file,
          line: site.line,
          column: site.column,
          name: site.name,
          argTypes: site.args.map((a) => (a === null ? "null" : typeof a)),
          argsPreview: site.args.map((a) => {
            const s = typeof a === "string" ? a : JSON.stringify(a) || "";
            return s.length > 60 ? `${s.slice(0, 60)}…` : s;
          }),
        };

        const content = decodeURIComponent((url.match(/content=([^&]*)/) || [])[1] || "");
        lastSentContent = content;
      } else if (site && site.diagnostics) {
        capturedSendInfo = { unmatched: true, diagnostics: site.diagnostics };
      }
    } catch (error) {
      // 抓不到不影响主流程，但把原因记下来方便排查
      capturedSendInfo = { captureError: String(error.message || error) };
    }

    emit("outbound", { method, url, body: String(body || "").slice(0, 2000) });
  }

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

  /**
   * 直接调页面自己的发送函数（抓到 fn 引用之后）。
   * 完全不碰输入框和键盘，所以**不依赖页面焦点**，也不需要等编辑器落状态。
   * 签名（a_bogus）照样由页面自己算，我们只把内容换掉。
   */
  function sendViaCapturedFn(text) {
    if (typeof capturedSendFn !== "function") return null;

    // 我们只拿到了当时的入参快照，把「上次真的发出去的那段文本」换成现在要发的
    const snapshot = capturedSendFn.__livraArgs;
    if (!Array.isArray(snapshot)) return null;

    let replaced = false;
    const args = snapshot.map((arg) => {
      if (!replaced && arg === lastSentContent) {
        replaced = true;
        return text;
      }
      return arg;
    });

    // 入参里找不到原文本（可能换了个参数顺序/格式），不能瞎调
    if (!replaced) return null;

    capturedSendFn.__livraArgs = args;

    try {
      const result = capturedSendFn.apply(capturedSendFn.__livraThis || null, args);
      return { ok: true, note: "已直接调用页面自己的发送函数", async: result && typeof result.then === "function" };
    } catch (error) {
      return { ok: false, error: `调用页面发送函数出错：${error.message || error}` };
    }
  }

  /* ============================ 找页面的输入框 ============================ */

function findChatEditor() {
  const editors = [...document.querySelectorAll('[contenteditable="true"]')];
  if (!editors.length) return null;

  const isVisible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const named = editors.find((el) =>
    /editor-kit|chat|comment|danmaku|input/i.test(String(el.className) + " " + String(el.getAttribute("data-e2e") || "")));

  return named || editors.find(isVisible) || editors[0];
}

/* ============================ 对外 API ============================ */

  // 给 content script 用（真正调用方在隔离世界，但两边共享 window）
  window.__livraLive = {
    stats: snapshot,
    recent: () => recent.slice(-50),
    outbound: () => outbound.slice(),
    wsSends: () => wsSends.slice(-20),

    /**
     * 发弹幕。优先直接调页面自己的发送函数（不依赖焦点），
     * 抓不到函数时才退回「填输入框 + 回车」。
     */
    async sendDanmaku(text) {
      const content = String(text || "").trim();
      if (!content) return { ok: false, error: "弹幕内容为空" };

      // 路线 1：直接调页面函数
      const direct = sendViaCapturedFn(content);
      if (direct && direct.ok) return direct;
      if (direct && direct.error) return direct;

      // 路线 2：模拟输入框 + 回车（依赖页面有焦点，是兜底方案）
      return sendViaEditor(content);
    },

    /** 调试用：看抓到的发送函数是哪个 */
    sendFn: () => capturedSendInfo,

    /** 调试用：发送链路的每一步 */
    sendLog: () => sendLog.slice(-20),
  };

  /**
   * 兜底路线：填页面的输入框 + 派发回车。
   * 这条路的依赖比较多（页面要有焦点、编辑器要来得及落状态），所以只做兜底。
   */
  async function sendViaEditor(content) {
    const editor = findChatEditor();
    if (!editor) {
      return { ok: false, error: "没找到直播间输入框（先进直播间，或手动发一条弹幕把它唤起）" };
    }

    editor.focus();

    // contenteditable 必须走 execCommand("insertText")，框架的输入状态才会真的更新；
    // 直接改 textContent 框架感知不到。
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, content);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      editor.textContent = content;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: content,
      }));
    }

    // 富文本编辑器要一两个 tick 才把输入落下来。同一时刻就发 Enter 会被直接忽略
    // （实测：插入和 Enter 放在同一个同步块里，输入框有字但根本没发出去）。
    await wait(180);

    editor.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));

    // 页面通常是「先清输入框再发请求」，等一小会儿看它清没清
    await wait(450);

    const leftover = (editor.textContent || "").replace(/[\u200b\s]/g, "");
    const debugInfo = {
      insertedVia: inserted ? "execCommand" : "textContent",
      docHasFocus: document.hasFocus(),
      activeIsEditor: document.activeElement === editor,
      textAfter: editor.textContent,
    };

    if (leftover) {
      // 发送没成功，就把我们塞进去的内容撤掉。
      // 不撤的话它会一直留在输入框里，下次发送会被一起发出去 —— 实测串过。
      try {
        editor.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");
        debugInfo.cleanedUp = true;
      } catch {
        debugInfo.cleanedUp = false;
      }

      return {
        ok: false,
        error: "页面没接受这次发送（常见原因：浏览器窗口不在前台）。已撤回输入框内容，把窗口点回来再试",
        debug: debugInfo,
      };
    }

    return { ok: true, note: "已通过页面输入框发出", debug: debugInfo };
  }

  window.__livraHook = true;

  emit("ready", { href: location.href });
})();
