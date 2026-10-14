// Livra —— 按规则改写响应体
//
// 架构：**每个标签页一份独立会话**（tabId -> session）。A 标签开着不影响 B 标签，
// 可以同时开多个。规则内容仍然共享同一份（rewrite.js 里硬编码）。
//
// 开关有两个入口，走的是同一段代码（toggleRewrite）：
//   1. 侧边栏「智能直播助手」（sidepanel.html）—— 点扩展图标打开，主要入口
//   2. 页面内的悬浮按钮（content.js）—— 只在注入范围内的页面上出现
//
// rewrite.js 通过 importScripts() 加载，两者共用同一个全局作用域，
// 所以这里可以直接调 enableRewriteDomain / disableCacheForRewrite /
// handleRequestPaused / REWRITE_OPTIONS / rulesSummary。
// 这条 importScripts 必须是本文件的第一条语句。
importScripts("rewrite.js");

const DEFAULT_TITLE = "Livra · 智能直播助手";
const BADGE_COLOR = "#2f855a";
const BADGE_ERROR = "#c53030";

// 侧边栏是「窗口级」的：一个窗口一个面板，内容跟随该窗口的当前标签页。
// openPanelOnActionClick 让 Chrome 自己处理图标点击 —— 绕开 sidePanel.open() 的手势限制
// （手动 open() 时前面不能有任何 await，很容易踩坑），代价是 action.onClicked 不再触发。
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 一个页面加载时可能瞬间命中好几条响应。角标和页面按钮的更新合并成一次，
// 避免每条改写都走一次 action IPC + 一次 tabs.sendMessage + 一次 DOM 重绘。
const UI_DEBOUNCE_MS = 250;

/**
 * 每个标签页一份独立会话，不跨标签共享。
 * tabId -> { attached, count, error, uiTimer }
 */
const sessions = new Map();

function getSession(tabId) {
  let session = sessions.get(tabId);

  if (!session) {
    session = { attached: false, count: 0, error: "", uiTimer: null };
    sessions.set(tabId, session);
  }

  return session;
}

function publicState(tabId) {
  const session = getSession(tabId);

  return {
    enabled: session.attached,
    count: session.count,
    error: session.error,
  };
}

/* ============================ 基础工具 ============================ */

function sendCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

/* ============================ 界面同步 ============================ */

function flushUi(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;

  if (session.uiTimer) {
    clearTimeout(session.uiTimer);
    session.uiTimer = null;
  }

  let badgeText = "";
  let badgeColor = BADGE_COLOR;
  let title = DEFAULT_TITLE;

  if (session.error) {
    badgeText = "!";
    badgeColor = BADGE_ERROR;
    title = `Livra · ${session.error}`;
  } else if (session.attached) {
    badgeText = session.count > 0 ? String(session.count) : "ON";
    title =
      session.count > 0
        ? `Livra · 已改写 ${session.count} 个响应（点击关闭）`
        : "Livra · 改写已开启（点击关闭）";
  }

  chrome.action.setBadgeText({ tabId, text: badgeText }).catch(() => {});
  if (badgeText) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor }).catch(() => {});
  }
  chrome.action.setTitle({ tabId, title }).catch(() => {});

  // 页面里的悬浮按钮。页面没有 content script 时会 reject，忽略即可。
  chrome.tabs
    .sendMessage(tabId, { type: "TAB_STATE_CHANGED", state: publicState(tabId) })
    .catch(() => {});

  // 侧边栏。用 runtime.sendMessage 广播，面板按 tabId 过滤自己那一份，
  // 这样多窗口/多标签同时开着也不会串。
  chrome.runtime
    .sendMessage({ type: "PANEL_TAB_STATE", tabId, state: publicState(tabId) })
    .catch(() => {});
}

function scheduleUi(tabId) {
  const session = getSession(tabId);
  if (session.uiTimer) return;

  session.uiTimer = setTimeout(() => {
    session.uiTimer = null;
    flushUi(tabId);
  }, UI_DEBOUNCE_MS);
}

/* ============================ 开关 ============================ */

/**
 * 让 CDP 自动挂上子 target（跨站 iframe、Worker）。
 * 不这么做的话只有主 frame 进程内的响应会被改写。可以用
 * REWRITE_OPTIONS.includeChildFrames 关掉，省一次 setAutoAttach。
 */
async function enableAutoAttach(target) {
  const base = {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  };

  try {
    await sendCommand(target, "Target.setAutoAttach", {
      ...base,
      filter: [
        { type: "iframe", exclude: false },
        { type: "worker", exclude: false },
        { type: "shared_worker", exclude: false },
        { type: "service_worker", exclude: false },
      ],
    });
  } catch {
    // 老版本 Chrome 不认 filter 参数，退回不带的写法
    await sendCommand(target, "Target.setAutoAttach", base).catch(() => {});
  }
}

async function startRewrite(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("无效的标签页 ID");
  }

  const session = getSession(tabId);
  if (session.attached) return;

  const tab = await chrome.tabs.get(tabId);

  if (!/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("该页面不支持改写");
  }

  const target = { tabId };
  await attachDebugger(target);

  try {
    // 拦截范围由规则决定，见 rewrite.js 的 buildFetchPatterns()
    await enableRewriteDomain(target);

    // Fetch 域拦不到「由 HTTP 缓存直接满足」的响应，默认要同时关缓存，
    // 否则带 immutable 的 CDN 资源第二次访问一条都改不到。
    await disableCacheForRewrite(target);

    if (REWRITE_OPTIONS.includeChildFrames) {
      await enableAutoAttach(target);
    }

    session.attached = true;
    session.count = 0;
    session.error = "";
  } catch (error) {
    await detachDebugger(target).catch(() => {});
    throw error;
  }

  // 注意：这里**不再**去停别的标签页 —— 每个标签独立，可以同时开。
  flushUi(tabId);
}

async function stopRewrite(tabId) {
  const session = getSession(tabId);
  if (!session.attached) return;

  await detachDebugger({ tabId }).catch(() => {});

  session.attached = false;
  session.count = 0;
  session.error = "";

  flushUi(tabId);
}

async function toggleRewrite(tabId) {
  const session = getSession(tabId);

  if (session.attached) await stopRewrite(tabId);
  else await startRewrite(tabId);

  return publicState(tabId);
}

function failRewrite(tabId, error) {
  const session = getSession(tabId);

  session.attached = false;
  session.count = 0;
  session.error = error.message || String(error);

  flushUi(tabId);
}

/* ============================ 直播数据 ============================ */

// 每个标签页一份，和改写会话一样按 tabId 隔离
const MAX_DANMAKU = 200;
const liveByTab = new Map();

function getLive(tabId) {
  let live = liveByTab.get(tabId);

  if (!live) {
    live = { socket: null, online: null, danmaku: [], stats: null, outbound: null, lastAt: 0 };
    liveByTab.set(tabId, live);
  }

  return live;
}

function liveSummary(tabId) {
  const live = getLive(tabId);

  return {
    socket: live.socket,
    online: live.online,
    danmaku: live.danmaku.slice(-80),
    stats: live.stats,
    outbound: live.outbound,
    lastAt: live.lastAt,
  };
}

function broadcastLive(tabId) {
  chrome.runtime
    .sendMessage({ type: "PANEL_LIVE_DATA", tabId, live: liveSummary(tabId) })
    .catch(() => {});
}

/* ============================ 侧边栏 ============================ */

/**
 * 把 manifest 里 content_scripts.matches 的匹配模式转成正则。
 * 这样「页面里会不会出现悬浮按钮」直接以 manifest 为准，不用再抄一份域名列表。
 */
function matchPatternToRegExp(pattern) {
  const parts = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parts) return null;

  const [, scheme, host, path] = parts;

  const schemeRe = scheme === "*" ? "https?" : scheme;

  let hostRe;
  if (host === "*") {
    hostRe = "[^/]+";
  } else if (host.startsWith("*.")) {
    // *.douyin.com 要同时匹配 douyin.com 和任意子域
    hostRe = `(?:[^/]+\\.)?${escapeRegExp(host.slice(2))}`;
  } else {
    hostRe = escapeRegExp(host);
  }

  const pathRe = escapeRegExp(path).replace(/\\\*/g, ".*");

  // 注意：Chrome 的匹配模式里**不写端口**，端口在匹配时是被忽略的。
  // 所以这里必须补一个可选的 :port，否则 http://127.0.0.1:8820/ 永远匹配不上。
  return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`, "i");
}

const INJECTABLE_PATTERNS = (chrome.runtime.getManifest().content_scripts || [])
  .flatMap((entry) => entry.matches || [])
  .map(matchPatternToRegExp)
  .filter(Boolean);

function isInjectableUrl(url) {
  return INJECTABLE_PATTERNS.some((re) => re.test(url));
}

/**
 * 插件重启后，已经开着的直播页**不会**自动重新注入 content script
 * （Chrome 只在页面加载时注一次）。页面里的 hook 本身还活着（挂在 window 上），
 * 但没人把数据转给后台了。所以这里主动补注入一次。
 */
async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (tab.id == null || !tab.url) continue;
    if (!isInjectableUrl(tab.url)) continue;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
    } catch {
      // chrome:// 之类注入不了的页面直接跳过
    }
  }
}

// SW 每次启动都补一次。content.js 内部有幂等保护，重复注入不会叠加副作用。
reinjectContentScripts().catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  reinjectContentScripts().catch(() => {});
});

/* ============================ 消息 ============================ */

// 入口 1：侧边栏。图标点击由 Chrome 直接打开面板（openPanelOnActionClick），
// 所以这里没有 action.onClicked —— 开关全部走消息。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // content script 发来的消息带 sender.tab，用它锁定「当前标签页」；
  // 侧边栏发来的消息没有 sender.tab，由它自己传 windowId。
  const senderTabId = sender?.tab?.id;

  (async () => {
    switch (message?.type) {
      case "GET_TAB_STATE": {
        if (senderTabId == null) return { state: { enabled: false, count: 0, error: "" } };
        return { state: publicState(senderTabId) };
      }

      case "TOGGLE_REWRITE": {
        if (senderTabId == null) throw new Error("无法确定标签页");
        return { state: await toggleRewrite(senderTabId) };
      }

      // 侧边栏：一次性拿全「当前标签页 + 它的会话状态 + 规则列表」
      case "GET_PANEL_STATE": {
        const query = { active: true };

        if (Number.isInteger(message.windowId)) {
          query.windowId = message.windowId;
        } else {
          // service worker 里没有「当前窗口」，没有 windowId 只能退到聚焦窗口
          query.lastFocusedWindow = true;
        }

        const [tab] = await chrome.tabs.query(query);

        if (!tab) {
          return {
            tab: null,
            state: { enabled: false, count: 0, error: "" },
            rules: rulesSummary(),
            injectable: false,
          };
        }

        return {
          tab: { id: tab.id, title: tab.title || "", url: tab.url || "" },
          state: publicState(tab.id),
          rules: rulesSummary(),
          injectable: isInjectableUrl(tab.url || ""),
          live: liveSummary(tab.id),
        };
      }

      // 侧边栏：切换指定标签页
      case "TOGGLE_TAB_REWRITE": {
        if (!Number.isInteger(message.tabId)) {
          return { state: null, error: "无效的标签页" };
        }

        try {
          return { state: await toggleRewrite(message.tabId) };
        } catch (error) {
          failRewrite(message.tabId, error);
          return { state: publicState(message.tabId) };
        }
      }

      /* ---------------- 直播数据（都来自 content script） ---------------- */

      // 页面（重新）加载：清掉这个标签页的旧数据
      case "LIVE_READY": {
        if (senderTabId == null) return { ok: false };

        liveByTab.set(senderTabId, {
          socket: null,
          online: null,
          danmaku: [],
          stats: null,
          outbound: null,
          lastAt: 0,
        });

        broadcastLive(senderTabId);
        return { ok: true };
      }

      case "LIVE_SOCKET": {
        if (senderTabId == null) return { ok: false };

        getLive(senderTabId).socket = {
          state: message.state,
          url: message.url,
          at: Date.now(),
        };

        broadcastLive(senderTabId);
        return { ok: true };
      }

      case "LIVE_DATA": {
        if (senderTabId == null) return { ok: false };

        const live = getLive(senderTabId);

        // replace = content script 刚启动时的补发快照，直接覆盖而不是追加，避免重复
        if (message.replace) live.danmaku = [];

        if (Array.isArray(message.batch)) {
          live.danmaku.push(...message.batch);
          while (live.danmaku.length > MAX_DANMAKU) live.danmaku.shift();
        }

        if (message.stats) {
          live.stats = message.stats;
          if (message.stats.online != null) live.online = message.stats.online;
        }

        live.lastAt = Date.now();
        broadcastLive(senderTabId);

        return { ok: true };
      }

      // 页面自己发请求时抓到的（用来定位「发弹幕」的入口）
      case "LIVE_OUTBOUND": {
        if (senderTabId == null) return { ok: false };

        getLive(senderTabId).outbound = {
          method: message.method,
          url: message.url,
          body: message.body,
          at: Date.now(),
        };

        broadcastLive(senderTabId);
        return { ok: true };
      }

      // 侧边栏 -> 让页面发弹幕
      case "SEND_DANMAKU": {
        if (!Number.isInteger(message.tabId)) return { error: "无效的标签页" };
        if (!message.text) return { error: "弹幕内容为空" };

        try {
          // ⚠️ 页面的「回车发送」只在直播页自己有焦点时才响应。
          // 用户点的是侧边栏，焦点在面板上，直播页的 document.hasFocus() 是 false，
          // 这时候派发 Enter 页面根本不理会（实测：字塞进去了、什么都没发生）。
          // 所以发送前先把直播页激活，让焦点回到它身上。
          await chrome.tabs.update(message.tabId, { active: true });
          await new Promise((r) => setTimeout(r, 150));
        } catch {
          // 激活失败也照常发，靠页面那侧的兜底文案提示用户
        }

        try {
          await chrome.tabs.sendMessage(message.tabId, {
            type: "SEND_DANMAKU",
            text: message.text,
          });
          return { ok: true };
        } catch (error) {
          return { error: `页面没有响应：${error.message}` };
        }
      }

      // content script 回报发送结果 -> 转给侧边栏
      case "SEND_DANMAKU_RESULT": {
        chrome.runtime
          .sendMessage({ type: "PANEL_DANMAKU_RESULT", result: message.result })
          .catch(() => {});
        return { ok: true };
      }

      default:
        return null;
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ state: null, error: error.message }));

  return true;
});

/* ============================ CDP 事件 ============================ */

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (tabId == null) return;

  // 只有该标签页自己的会话在跑时才处理，天然按标签隔离
  const session = sessions.get(tabId);
  if (!session?.attached) return;

  // 子会话事件会带上 sessionId；主会话没有
  const sessionId = source.sessionId || null;

  // 跨站 iframe / Worker 作为子 target 挂上来时，必须给这个会话单独开一次
  // Fetch 域，否则它的响应不会被改写。
  if (method === "Target.attachedToTarget") {
    if (!REWRITE_OPTIONS.includeChildFrames) return;

    const child = { tabId, sessionId: params.sessionId };

    enableRewriteDomain(child).catch(() => {});
    disableCacheForRewrite(child).catch(() => {});

    return;
  }

  if (method === "Fetch.requestPaused") {
    const target = sessionId ? { tabId, sessionId } : { tabId };

    handleRequestPaused(target, params)
      .then((result) => {
        if (!result?.rewritten) return;

        const current = sessions.get(tabId);
        if (!current?.attached) return;

        current.count += 1;
        scheduleUi(tabId);
      })
      .catch(() => {});
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;

  const session = sessions.get(source.tabId);
  if (!session) return;

  session.attached = false;
  session.count = 0;
  session.error = "";

  flushUi(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId);
  if (session?.uiTimer) clearTimeout(session.uiTimer);

  sessions.delete(tabId);
  liveByTab.delete(tabId);
});

/* ============================ 冷启动兜底 ============================ */

// 正常情况下 debugger 会话会保持 service worker 存活，sessions 不会丢。
// 万一 SW 还是被回收过，这里用 CDP 的真实状态把状态补回来，避免角标和实际不一致。
chrome.debugger
  .getTargets()
  .then((targets) => {
    for (const target of targets) {
      if (!target.attached || target.tabId == null) continue;

      const session = getSession(target.tabId);
      session.attached = true;
      flushUi(target.tabId);
    }
  })
  .catch(() => {});
