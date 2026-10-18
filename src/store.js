/**
 * 后台 · 直播数据仓（在 service worker 里跑）
 *
 * 按标签页存一份，A 标签开着不影响 B 标签 —— 和原来的设计一致，可以同时看多个直播间。
 * 这边只做存储和广播，不碰任何抖音协议（那是 sdk/ 的事）。
 *
 * ⚠️ 这个文件和面板不是同一个运行环境：
 *   - 本文件由 background.js 用 importScripts() 加载，跑在 service worker 里
 *   - 面板是扩展页面，两边只能靠 chrome.runtime 消息通信
 */

/**
 * 消息保留策略：**标签关闭前一直留着** —— 面板可以往上翻到本场最早的一条。
 *
 * 这里原本只留 300 条、页面 SDK 只留 500 条，那是为了迁就「一次把全部消息渲染成
 * DOM」的老面板；现在面板改成虚拟滚动了，渲染成本和条数无关，就没有丢弃的理由了。
 *
 * 只留一道安全阀：单标签超过这个数才从头部丢最老的。目的是防止忘了关标签页导致
 * 内存无限涨 —— 一场正常直播的条数远够不着（几千到一两万条）。
 */
const MAX_MESSAGES = 30000;

const tabs = new Map();

function emptySession() {
  return {
    summary: null,
    messages: [],
    seen: new Set(),
  };
}

function getTab(tabId) {
  let session = tabs.get(tabId);

  if (!session) {
    session = emptySession();
    tabs.set(tabId, session);
  }

  return session;
}

function resetTab(tabId) {
  tabs.set(tabId, emptySession());
  // 面板要把列表清空，所以走整包
  broadcast(tabId, { replace: true, messages: [] });
}

function dropTab(tabId) {
  tabs.delete(tabId);
}

/**
 * 追加一批消息。replace = 面板刚打开或页面刚同步时的补发，直接覆盖而不是追加，
 * 避免和已经收到的重复。
 *
 * 返回**这一次真正新增**的那部分 —— 面板靠它做增量渲染，不必每次都把整个列表
 * 重传一遍再重扫一遍。
 */
function ingestMessages(tabId, batch, { replace = false } = {}) {
  const session = getTab(tabId);

  if (replace) {
    session.messages = [];
    session.seen.clear();
  }

  const added = [];

  for (const message of batch || []) {
    const key = message.id;
    if (key && session.seen.has(key)) continue;

    if (key) session.seen.add(key);
    session.messages.push(message);
    added.push(message);
  }

  while (session.messages.length > MAX_MESSAGES) {
    const dropped = session.messages.shift();
    if (dropped?.id) session.seen.delete(dropped.id);
  }

  // 一旦超过上限就从 seen 里剔除已不在窗口内的，避免 Set 无限增长
  if (session.seen.size > MAX_MESSAGES * 2) {
    session.seen = new Set(session.messages.map((m) => m.id).filter(Boolean));
  }

  return added;
}

function setSummary(tabId, summary) {
  if (!summary) return;
  getTab(tabId).summary = summary;
}

function setSocket(tabId, socket) {
  const session = getTab(tabId);
  session.summary = { ...(session.summary || {}), socket };
}

/**
 * 概要（不含消息列表）。
 * 高频路径只传这个 —— 消息列表动辄三百条，每次都带上会白白多传几十 KB。
 */
function summaryOnly(tabId) {
  const session = getTab(tabId);

  return {
    summary: session.summary,
    counts: session.summary?.counts || {},
    metrics: session.summary?.metrics || {},
    socket: session.summary?.socket || { open: false },
    hasData: session.messages.length > 0 || Boolean(session.summary),
  };
}

/** 含完整消息列表的快照，只在首屏和「整包替换」时用 */
function snapshot(tabId) {
  return { ...summaryOnly(tabId), messages: getTab(tabId).messages.slice() };
}

/**
 * 广播给面板。
 *
 * extra 说明这次是增量还是整包：
 *   { appended: [...] }        增量 —— 只带本次新增的几条，面板追加渲染
 *   { replace: true, messages } 整包 —— 面板清空重建（首屏、页面同步、重置）
 */
function broadcast(tabId, extra = {}) {
  chrome.runtime
    .sendMessage({
      type: "PANEL_LIVE_DATA",
      tabId,
      live: summaryOnly(tabId),
      ...extra,
    })
    .catch(() => {
      // 面板没开就没人听，忽略
    });
}
