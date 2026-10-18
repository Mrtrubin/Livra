/**
 * SDK · 发弹幕
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 核心方案（2026-10 实测跑通）：替换「输入框控制器」的 I.getTextInfo()       │
 * │                                                                          │
 * │   const orig = I.getTextInfo;                                            │
 * │   I.getTextInfo = () => ({ plainText: TEXT, rtfElements: [] });          │
 * │   onSend();              // 完整业务链路 + 签名都由页面自己跑              │
 * │   I.getTextInfo = orig;  // 文本在 onSend 第一行被同步读走，立刻还原       │
 * │                                                                          │
 * │ 全程**不修改任何 DOM、不调用任何 DOM 函数**——输入框可以一个字都没有，      │
 * │ 但页面依旧产出 content=<目标> 的完整请求。签名（a_bogus 等）由页面自己算， │
 * │ 我们只是「借」它的发送函数。                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 来源依据（e 的编译产物，即 onSend 内部真正干活的那层）：
 *   async () => {
 *     let { plainText: e, rtfElements: t } = I.getTextInfo();      // ← 文本唯一来源
 *     let n = t.length ? JSON.stringify(t) : "";
 *     if (!e || w && !await ef.o(w, {...})) return;
 *     let i = I.getPasteEditMethod();
 *     try { e && await p(e, n, w, void 0, i) }                     // ← p 是真正的发送函数
 *     finally { I.resetPasteEditMethod() }
 *   }
 * p(text, rtfContent, X, undefined, pasteEditMethod) 正好对应请求里的
 * content / rtf_content / type / paste_edit_method。
 *
 * I（输入框控制器）按**源码特征**识别，不依赖 className：
 *   同时具备 getTextInfo / getPasteEditMethod / resetPasteEditMethod 且含 editor 属性。
 *
 * 发现（discovery）的两条路径，都尽量 DOM-free：
 *   1. 被动：页面任何一次真发弹幕，出站请求的调用栈里能捞出 onSend/e（源码带
 *      getTextInfo 特征），→ 用 apply 探针空跑一次把它内部的 I 钓出来。
 *   2. 兜底：从来没发过弹幕时，只读地扫一次 React fiber 拿 onSend（不修改 DOM），
 *      再 apply 探针钓 I。这一步才会读 DOM，但只读不写。
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.sender) return;
  NS.installed.sender = true;

  /**
   * 发送过程日志。发不出去时这是唯一的线索，所以留着 —— 通过 probe().log 读，
   * 不单独开一个导出。
   */
  const sendLog = [];
  function log(entry) {
    sendLog.push(entry);
    if (sendLog.length > 40) sendLog.shift();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ====================== 关键对象识别 ====================== */

  /**
   * 输入框控制器 I。源码特征识别（不靠 className，抗改名）。
   * 恰好具备这几个成员：insertEmoji / getTextInfo / isEmpty / editor /
   * getPasteEditMethod / resetPasteEditMethod。这里只验判别度最高的四个。
   */
  function isI(o) {
    if (!o || typeof o !== "object") return false;
    return (
      typeof o.getTextInfo === "function" &&
      typeof o.getPasteEditMethod === "function" &&
      typeof o.resetPasteEditMethod === "function" &&
      "editor" in o
    );
  }

  /**
   * 发送实现层 e 的源码特征：里面会引用 I.getTextInfo / getPasteEditMethod /
   * resetPasteEditMethod。拿这个做签名，比「猜 onSend 这个名字」稳得多。
   */
  const SEND_IMPL = /getTextInfo|getPasteEditMethod|resetPasteEditMethod/i;

  // 安全 SDK（算 a_bogus 的）、监控、扩展自己的帧都不是业务函数
  const VENDOR_FILE =
    /chrome-extension:|secsdk|security|sdk-glue|bdms\.js|slardar|tea-|monitor|runtime\.js/i;

  let gOnSend = null; // 发送函数（来自调用栈或 fiber）
  let gI = null;      // 输入框控制器 I
  let lastSentContent = "";
  let outboundWatch = null;

  /* ====================== 调用栈捞候选（DOM-free） ====================== */

  /**
   * 用 Error.prepareStackTrace 拿 CallSite：getFunction() / getArguments() / getThis()。
   * ⚠ CallSite 只在回调里有效，必须同步取完。
   * ⚠ 默认 stackTraceLimit=10，安全 SDK 自己占十几帧，不调到 120 看不到外面业务函数。
   */
  function captureStackCandidates() {
    const found = [];
    const previous = Error.prepareStackTrace;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 120;

    Error.prepareStackTrace = (_, sites) => {
      for (const site of sites) {
        const file = String(site.getFileName() || "");
        if (VENDOR_FILE.test(file)) continue;

        let fn;
        try {
          fn = site.getFunction();
        } catch {
          continue;
        }
        if (typeof fn !== "function") continue;

        let args = null;
        let thisArg;
        try {
          const raw = site.getArguments();
          args = raw ? Array.from(raw) : null;
        } catch {
          args = null;
        }
        try {
          thisArg = site.getThis();
        } catch {
          thisArg = undefined;
        }

        const name = site.getFunctionName() || fn.name || "(匿名)";
        found.push({
          label: `stack:${name}`,
          name,
          fn,
          args,
          thisArg,
          file,
          line: site.getLineNumber(),
        });
      }
      return sites;
    };

    try {
      void new Error().stack;
    } finally {
      Error.prepareStackTrace = previous;
      Error.stackTraceLimit = limit;
    }

    return found.reverse().slice(0, 16);
  }

  /**
   * 从一次出站调用栈里顺手学 onSend/e（DOM-free）。
   * 注意：此刻 XHR.send 已触发，getTextInfo 早已返回，I 不在栈上，
   * 所以这里只能拿到 onSend/e，I 要靠 apply 探针另钓（见 fishI）。
   */
  function learnOnSendFromStack() {
    if (gOnSend) return true;
    for (const c of captureStackCandidates()) {
      if (typeof c.fn === "function" && SEND_IMPL.test(String(c.fn).slice(0, 4000))) {
        gOnSend = c.fn;
        log({ phase: "栈内学到 onSend", at: Date.now() });
        return true;
      }
    }
    return false;
  }

  /* ====================== 兜底：只读扫 fiber 拿 onSend ====================== */

  function findChatEditor() {
    const editors = [...document.querySelectorAll('[contenteditable="true"]')];
    if (!editors.length) return null;
    const isVisible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const named = editors.find((el) =>
      /editor-kit|chat|comment|danmaku|input/i.test(
        String(el.className) + " " + String(el.getAttribute("data-e2e") || "")
      )
    );
    return named || editors.find(isVisible) || editors[0];
  }

  function fiberOf(el) {
    if (!el) return null;
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return el[key];
    }
    return null;
  }

  /** 从输入框的 fiber 往上翻，返回第一个 onSend（DOM-free 只读） */
  function findOnSendFromFiber(editor) {
    let fiber = fiberOf(editor);
    if (!fiber) return null;
    let depth = 0;
    while (fiber && depth < 32) {
      depth++;
      const props = fiber.memoizedProps;
      if (props && typeof props.onSend === "function") return props.onSend;
      fiber = fiber.return;
    }
    return null;
  }

  /* ====================== apply 探针：空跑一次钓出 I ====================== */

  /**
   * 临时挂一层 Function.prototype.apply（必须走 .call 还原，否则命中自己无限递归），
   * 空跑一次 onSend()——getTextInfo 此刻返回的是真实（空）文本，e 会 early return，
   * 不会真发弹幕；但 I.getTextInfo() 已经被调用过，I 作为这次 .apply 的 thisArg 被记下。
   * 留 1.5s 等 async 走完再撤钩子。
   */
  async function fishI(onSend) {
    if (typeof onSend !== "function") return null;
    const origApply = Function.prototype.apply;
    const thisArgs = [];

    Function.prototype.apply = function (thisArg, argsArray) {
      try {
        if (thisArg && typeof thisArg === "object") thisArgs.push(thisArg);
      } catch {
        // ignore
      }
      // ⚠ 必须用 .call 而非 .apply：此刻 Function.prototype.apply 已被我们替换，
      // 再写 origApply.apply(...) 会命中自己的包装器 → 无限递归。
      return origApply.call(this, thisArg, argsArray);
    };

    try {
      onSend(); // 空跑，文本为空 → early return，不会真发
    } catch {
      // 空跑抛错忽略
    }

    await sleep(1500);
    Function.prototype.apply = origApply;

    const I = thisArgs.find(isI);
    return I || null;
  }

  /* ====================== 发现控制器（整合两条路径） ====================== */

  async function discoverController() {
    if (gOnSend && gI) return true;

    learnOnSendFromStack();

    // 唯一会碰 DOM 的地方，且只读不写
    if (!gOnSend) {
      const editor = findChatEditor();
      if (editor) {
        const onSend = findOnSendFromFiber(editor);
        if (onSend) {
          gOnSend = onSend;
          log({ phase: "fiber 学到 onSend", at: Date.now() });
        }
      }
    }

    if (gOnSend && !gI) {
      gI = await fishI(gOnSend);
      if (gI) {
        log({
          phase: "apply 探针学到 I",
          methods: Object.getOwnPropertyNames(gI).slice(0, 12),
          at: Date.now(),
        });
      }
    }

    return Boolean(gOnSend && gI);
  }

  /* ====================== 判据：是否真的发出来了 ====================== */

  function watchOutbound(content, timeout) {
    return new Promise((resolve) => {
      if (outboundWatch) {
        clearTimeout(outboundWatch.timer);
        outboundWatch.resolve(false);
      }
      const watch = {
        content,
        resolve,
        timer: setTimeout(() => {
          if (outboundWatch === watch) outboundWatch = null;
          resolve(false);
        }, timeout),
      };
      outboundWatch = watch;
    });
  }

  // 页面（或我们）发出一条聊天请求时都会经过这里
  NS.bus.on("outbound", (payload) => {
    if (payload.content) lastSentContent = payload.content;

    try {
      learnOnSendFromStack();
    } catch (error) {
      log({ phase: "栈内学 onSend 失败", error: String(error.message || error), at: Date.now() });
    }

    if (outboundWatch && payload.content && payload.content === outboundWatch.content) {
      const watch = outboundWatch;
      outboundWatch = null;
      clearTimeout(watch.timer);
      watch.resolve(true);
    }
  });

  /* ====================== 真正的发弹幕（DOM-free） ====================== */

  async function sendDanmaku(text) {
    const content = String(text || "").trim();
    if (!content) return { ok: false, error: "弹幕内容为空" };

    if (!gOnSend || !gI) {
      const ok = await discoverController();
      if (!ok) {
        return {
          ok: false,
          error:
            "还没定位到发送控制器。请先在直播间手动发一条弹幕以触发自动捕获，或稍等页面自动发现完成。",
        };
      }
    }

    const I = gI;
    const onSend = gOnSend;
    const orig = I.getTextInfo;

    // 临时替换：getTextInfo 在被调用的那一次返回我们指定的文本
    I.getTextInfo = function () {
      return { plainText: content, rtfElements: [] };
    };

    const seen = watchOutbound(content, 5000);
    let callError = "";
    let sendResult = null;

    try {
      sendResult = onSend();
      if (sendResult && typeof sendResult.then === "function") {
        sendResult.catch((error) => {
          log({ phase: "发送函数 reject", error: String(error?.message || error), at: Date.now() });
        });
      }
    } catch (error) {
      callError = String(error.message || error);
    }

    // 文本在 onSend 启动的第一行就被同步读走了，可以立刻还原，把副作用窗口压到最短
    I.getTextInfo = orig;

    const sent = await seen;

    if (!sent) {
      // 常见原因：发送防重入锁卡住（上一次发送没走完），或直播间风控。解法都是 reload。
      log({ phase: "发送未产生请求", callError, at: Date.now() });
      return {
        ok: false,
        error:
          callError ||
          "页面没有产生发送请求（常见原因：发送防重入锁卡住，请刷新页面；或直播间已进入风控态）",
      };
    }

    log({ phase: "发送成功", content, at: Date.now() });
    NS.bus.emit("sent", { content });

    return {
      ok: true,
      note: "通过替换 I.getTextInfo 注入文本，全程未触碰输入框 DOM",
      content,
    };
  }

  NS.sender = {
    sendDanmaku,

    /** 调试用：定位状态 + 最近几次发送的过程日志 */
    probe: () => ({
      onSendFound: Boolean(gOnSend),
      onSendName: gOnSend ? gOnSend.name || "(匿名)" : null,
      IFound: Boolean(gI),
      IMethods: gI ? Object.getOwnPropertyNames(gI).slice(0, 12) : null,
      isI: gI ? isI(gI) : false,
      lastSentContent,
      editorFound: Boolean(findChatEditor()),
      log: sendLog.slice(-20),
    }),
  };

  // 直播间 UI 异步渲染，输入框可能很晚才出现；兜底：8s 后若还没发现，只读扫一次 fiber
  setTimeout(() => {
    if (gOnSend && gI) return;
    discoverController().catch(() => {});
  }, 8000);
})();
