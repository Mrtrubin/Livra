/**
 * 主播助手模块 · 后台侧（在 service worker 里跑）
 *
 * ⚠️ 注意：这个文件和 assistant.js 不是同一个运行环境。
 *   - 本文件由 background.js 用 importScripts() 加载，跑在 service worker 里
 *   - assistant.js / assistant.html / assistant.css 是侧边栏页面，跑在扩展页面里
 * 两边只能通过 chrome.runtime 消息通信。
 *
 * 职责：
 *   1. 按标签页存直播数据（弹幕 / 在线人数 / 统计 / 出站请求）
 *   2. 把「发弹幕」请求转到页面里（由注入模块的 hook 真正执行）
 */

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

function resetLive(tabId) {
  liveByTab.set(tabId, {
    socket: null,
    online: null,
    danmaku: [],
    stats: null,
    outbound: null,
    lastAt: 0,
  });
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

function setLiveSocket(tabId, state, url) {
  getLive(tabId).socket = { state, url, at: Date.now() };
}

/**
 * 追加一批弹幕。
 * replace = 页面 hook 刚启动时补发的快照，直接覆盖而不是追加，避免重复。
 */
function pushLiveData(tabId, batch, stats, replace) {
  const live = getLive(tabId);

  if (replace) live.danmaku = [];

  if (Array.isArray(batch)) {
    live.danmaku.push(...batch);
    while (live.danmaku.length > MAX_DANMAKU) live.danmaku.shift();
  }

  if (stats) {
    live.stats = stats;
    if (stats.online != null) live.online = stats.online;
  }

  live.lastAt = Date.now();
}

function setLiveOutbound(tabId, info) {
  getLive(tabId).outbound = { ...info, at: Date.now() };
}

function dropLive(tabId) {
  liveByTab.delete(tabId);
}

/**
 * 让页面发一条弹幕。
 *
 * 真正执行的是注入模块（modules/inject/sender.js）—— 它直接调页面自己的发送函数，
 * 所以不需要页面有焦点。这里只负责把请求送到那个标签页。
 *
 * 顺手把标签页激活：焦点回到页面上能让兜底路线（输入框 + 回车）也能用，
 * 顺带让用户看到发送结果。
 */
async function requestSendDanmaku(tabId, text) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 150));
  } catch {
    // 激活失败也照常发，靠页面那侧的兜底文案提示用户
  }

  await chrome.tabs.sendMessage(tabId, { type: "SEND_DANMAKU", text });
}
