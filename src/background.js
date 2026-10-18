/**
 * Livra · service worker（组合根）
 *
 * 重构之后这里很薄，只做三件事：
 *   1. 每个标签页一份会话的数据仓（store.js）
 *   2. 把 content script 推来的直播数据存下来，再广播给面板
 *   3. 响应面板的请求：取全量状态、发弹幕
 *
 * 抖音协议相关的一切都在 sdk/ 里，这里一行都不碰。
 * CDP / 响应改写整套已经删掉了 —— 见 README 的变更记录。
 *
 * 数据流向：
 *   抖音页面 --MAIN world sdk--> bridge.js(content script) --> 这里 --> 侧边栏面板
 */

importScripts("store.js");

/* ============================ 注入范围 ============================ */

/**
 * 把 manifest 里 content_scripts.matches 的匹配模式转成正则。
 * 这样「页面里会不会出现浮窗」直接以 manifest 为准，不用再抄一份域名列表。
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * （Chrome 只在页面加载时注一次）。所以这里主动补注入一次。
 * bridge.js 内部有幂等保护，重复注入不会叠加副作用。
 */
async function reinjectBridge() {
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (tab.id == null || !tab.url) continue;
    if (!isInjectableUrl(tab.url)) continue;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // 路径要和 manifest 里 content_scripts 的一致，写错会静默失败
        files: ["src/sdk/namespace.js", "src/sdk/protocol/wire.js", "src/bridge.js"],
      });
    } catch {
      // chrome:// 之类注入不了的页面直接跳过
    }
  }
}

reinjectBridge().catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  reinjectBridge().catch(() => {});
});

// 点扩展图标由 Chrome 自己打开侧边栏 —— 绕开 sidePanel.open() 的手势限制
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/* ============================ 消息路由 ============================ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender?.tab?.id;

  (async () => {
    switch (message?.type) {
      /* ---------------- content script 推来的直播数据 ---------------- */

      case "LIVE_READY": {
        if (senderTabId == null) return { ok: false };

        resetTab(senderTabId);
        broadcast(senderTabId);
        return { ok: true };
      }

      case "LIVE_MESSAGES": {
        if (senderTabId == null) return { ok: false };

        setSummary(senderTabId, message.summary);
        // 只把这一次真正新增的发给面板，别再整包重传
        const added = ingestMessages(senderTabId, message.batch);
        broadcast(senderTabId, { appended: added });
        return { ok: true };
      }

      case "LIVE_METRICS": {
        if (senderTabId == null) return { ok: false };

        setSummary(senderTabId, message.summary);
        broadcast(senderTabId);
        return { ok: true };
      }

      case "LIVE_SOCKET": {
        if (senderTabId == null) return { ok: false };

        setSocket(senderTabId, message.socket);
        broadcast(senderTabId);
        return { ok: true };
      }

      case "LIVE_RESET": {
        if (senderTabId == null) return { ok: false };

        resetTab(senderTabId);
        return { ok: true };
      }

      // content script 补发的全量快照（浮窗刚接进 SDK、或面板刚打开时）
      case "LIVE_SYNC": {
        if (senderTabId == null) return { ok: false };

        setSummary(senderTabId, message.summary);
        const added = ingestMessages(senderTabId, message.messages, { replace: Boolean(message.replace) });

        // 整包：面板要清空重建；否则走增量
        broadcast(
          senderTabId,
          message.replace
            ? { replace: true, messages: snapshot(senderTabId).messages }
            : { appended: added }
        );
        return { ok: true };
      }

      /* ---------------- 面板的请求 ---------------- */

      // 面板：一次性拿全「当前标签页 + 直播数据 + 类型清单」
      case "GET_PANEL_STATE": {
        const query = Number.isInteger(message.windowId)
          ? { active: true, windowId: message.windowId }
          : { active: true, lastFocusedWindow: true };

        const [tab] = await chrome.tabs.query(query);

        if (!tab) {
          return { tab: null, live: emptyLive(), visible: await loadVisibility() };
        }

        return {
          tab: { id: tab.id, title: tab.title || "", url: tab.url || "" },
          live: snapshot(tab.id),
          injectable: isInjectableUrl(tab.url || ""),
          visible: await loadVisibility(),
        };
      }

      // 面板：请求当前的 OK并发一份全量快照（例如刚打开、或者数据疑似不全）
      case "PULL_SNAPSHOT": {
        if (!Number.isInteger(message.tabId)) return { ok: false };

        try {
          await chrome.tabs.sendMessage(message.tabId, { type: "PULL_SNAPSHOT" });
          return { ok: true };
        } catch {
          return { ok: false, error: "页面还没准备好，刷新直播间试试" };
        }
      }

      // 面板 -> 让页面发弹幕（真正执行的是 sdk/sender.js）
      case "SEND_DANMAKU": {
        if (!Number.isInteger(message.tabId)) return { error: "无效的标签页" };
        if (!message.text) return { error: "弹幕内容为空" };

        try {
          await chrome.tabs.update(message.tabId, { active: true });
          await new Promise((r) => setTimeout(r, 150));
        } catch {
          // 激活失败也照常发
        }

        try {
          await chrome.tabs.sendMessage(message.tabId, {
            type: "SEND_DANMAKU",
            text: message.text,
          });
          return { ok: true };
        } catch {
          return { error: "页面没有响应，刷新直播间再试" };
        }
      }

      // content script 回报发送结果 -> 转给面板
      case "SEND_DANMAKU_RESULT": {
        chrome.runtime
          .sendMessage({ type: "PANEL_DANMAKU_RESULT", result: message.result })
          .catch(() => {});
        return { ok: true };
      }

      // 面板：读写「要展示哪些数据」
      case "GET_VISIBILITY":
        return { visible: await loadVisibility() };

      case "SET_VISIBILITY": {
        if (!message.visible) return { ok: false };
        await chrome.storage.local.set({ LIVRA_VISIBLE: message.visible });
        return { ok: true, visible: message.visible };
      }

      default:
        return null;
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));

  return true;
});

/* ============================ 展示偏好 ============================ */

async function loadVisibility() {
  try {
    const saved = await chrome.storage.local.get("LIVRA_VISIBLE");
    return saved.LIVRA_VISIBLE || null;
  } catch {
    return null;
  }
}

function emptyLive() {
  return {
    summary: null,
    counts: {},
    metrics: {},
    socket: { open: false },
    messages: [],
    hasData: false,
  };
}

/* ============================ 清理 ============================ */

chrome.tabs.onRemoved.addListener((tabId) => {
  dropTab(tabId);
});
