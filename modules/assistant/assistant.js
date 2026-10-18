/**
 * 主播助手模块 · 侧边栏界面
 *
 * 侧边栏是「窗口级」的：一个窗口一个面板，内容始终跟随该窗口的**当前标签页**。
 * 所以切换标签页时面板要重新取状态（onActivated / onUpdated / onFocusChanged）。
 *
 * 面板只是控制面，真正的会话状态在 background.js 的 sessions（按 tabId 一份），
 * 直播数据在同级 live-store.js（跑在 service worker 里，按 tabId 一份）。
 */

const els = {
  badge: document.getElementById("badge"),
  tabTitle: document.getElementById("tabTitle"),
  tabUrl: document.getElementById("tabUrl"),
  toggle: document.getElementById("toggle"),
  switchHint: document.getElementById("switchHint"),
  notice: document.getElementById("notice"),
  statState: document.getElementById("statState"),
  statCount: document.getElementById("statCount"),
  statOnline: document.getElementById("statOnline"),
  ruleList: document.getElementById("ruleList"),
  footText: document.getElementById("footText"),

  liveSocket: document.getElementById("liveSocket"),
  danmakuList: document.getElementById("danmakuList"),
  danmakuEmpty: document.getElementById("danmakuEmpty"),
  danmakuInput: document.getElementById("danmakuInput"),
  danmakuSend: document.getElementById("danmakuSend"),
  sendStatus: document.getElementById("sendStatus"),
  liveHint: document.getElementById("liveHint"),
};

let windowId = null;
let tabId = null;
let state = { enabled: false, count: 0, error: "" };
let injectable = true;
let rules = [];
let live = { socket: null, online: null, danmaku: [], stats: null };

// 已经渲染过的弹幕 key，避免后台重发时重复插入
const renderedDanmaku = new Set();

/* ============================ 通信 ============================ */

function send(message) {
  // 后台没醒 / 面板刚打开时可能失败，统一吞掉返回 null
  return chrome.runtime.sendMessage(message).catch(() => null);
}

async function refresh() {
  const response = await send({ type: "GET_PANEL_STATE", windowId });

  if (!response) {
    els.footText.textContent = "连接后台失败，点这里重试";
    return;
  }

  tabId = response.tab?.id ?? null;
  state = response.state || { enabled: false, count: 0, error: "" };
  injectable = response.injectable !== false;
  rules = response.rules || [];
  live = response.live || { socket: null, online: null, danmaku: [], stats: null };

  renderTab(response.tab);
  renderState();
  renderLive(true);
  renderRules();

  els.footText.textContent = "规则改完记得在扩展页点「重新加载」";
}

/* ============================ 直播数据 ============================ */

function danmakuKey(item) {
  return item.msgId || `${item.method}:${item.userId}:${item.content}:${item.ts}`;
}

function buildDanmakuNode(item) {
  const row = document.createElement("div");
  row.className = "danmaku" + (item.kind && item.kind !== "danmaku" ? ` ${item.kind}` : "");

  const name = document.createElement("span");
  name.className = "danmaku-user";
  name.textContent = item.nickname || "匿名";

  const text = document.createElement("span");
  text.className = "danmaku-text";
  text.textContent = item.content || "";

  row.append(name, text);
  return row;
}

function renderLive(reset) {
  const connected = live.socket?.state === "open";

  els.liveSocket.textContent = connected ? "已连接" : live.socket ? "已断开" : "未连接";
  els.liveSocket.className = "live-socket" + (connected ? " on" : "");

  els.statOnline.textContent = live.online == null ? "—" : String(live.online);

  if (reset) {
    renderedDanmaku.clear();
    els.danmakuList.textContent = "";
  }

  // 用户本来就在底部的话，追加后继续贴着底部
  const atBottom =
    els.danmakuList.scrollTop + els.danmakuList.clientHeight >= els.danmakuList.scrollHeight - 24;

  for (const item of live.danmaku || []) {
    const key = danmakuKey(item);
    if (renderedDanmaku.has(key)) continue;

    renderedDanmaku.add(key);
    els.danmakuList.append(buildDanmakuNode(item));
  }

  while (els.danmakuList.children.length > 200) {
    els.danmakuList.removeChild(els.danmakuList.firstChild);
  }

  els.danmakuEmpty.hidden = els.danmakuList.children.length > 0;

  if (atBottom) els.danmakuList.scrollTop = els.danmakuList.scrollHeight;

  const total = live.stats?.messages ?? 0;
  const online = live.online == null ? "" : ` · 在线 ${live.online}`;
  els.liveHint.textContent = `消息 ${total} 条${online}`;
}

/* ============================ 渲染 ============================ */

function renderTab(tab) {
  if (!tab) {
    els.tabTitle.textContent = "没有可用的标签页";
    els.tabUrl.textContent = "";
    els.toggle.disabled = true;
    return;
  }

  els.toggle.disabled = false;
  els.tabTitle.textContent = tab.title || "(无标题)";
  els.tabUrl.textContent = tab.url || "";
}

function renderState() {
  const on = Boolean(state.enabled);

  els.toggle.classList.toggle("on", on);
  els.toggle.setAttribute("aria-checked", String(on));

  els.badge.textContent = state.error ? "出错" : on ? "已开启" : "未开启";
  els.badge.className = "badge" + (state.error ? " err" : on ? " on" : "");

  els.statState.textContent = on ? "已开启" : "未开启";
  els.statCount.textContent = String(state.count || 0);

  if (state.error) {
    showNotice(state.error);
  } else if (!injectable) {
    showNotice("当前页面不在注入范围（页面里不会出现悬浮按钮），但依然可以从这里开启改写。");
  } else {
    els.notice.hidden = true;
  }
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = false;
}

function renderRules() {
  els.ruleList.textContent = "";

  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "rule-empty";
    empty.textContent = "没有规则";
    els.ruleList.append(empty);
    return;
  }

  for (const rule of rules) {
    const item = document.createElement("div");
    item.className = "rule" + (rule.enabled ? "" : " off");

    const head = document.createElement("div");
    head.className = "rule-head";

    const name = document.createElement("span");
    name.className = "rule-name";
    name.textContent = rule.name;
    name.title = rule.name;

    const scope = document.createElement("code");
    scope.className = "rule-scope";
    scope.textContent = rule.fetchPattern;
    scope.title = "CDP 拦截范围（fetchPattern）";

    head.append(name, scope);

    // 全部用 textContent 拼，规则内容是代码字符串，不走 innerHTML
    const find = document.createElement("div");
    find.className = "rule-line";
    find.textContent = rule.find;
    find.title = rule.find;

    const arrow = document.createElement("div");
    arrow.className = "rule-arrow";
    arrow.textContent = "↓";

    const replacement = document.createElement("div");
    replacement.className = "rule-line repl";
    replacement.textContent = rule.replacement;
    replacement.title = rule.replacement;

    item.append(head, find, arrow, replacement);
    els.ruleList.append(item);
  }
}

/* ============================ 交互 ============================ */

els.toggle.addEventListener("click", async () => {
  if (tabId == null) return;

  els.toggle.disabled = true;
  const response = await send({ type: "TOGGLE_TAB_REWRITE", tabId });
  els.toggle.disabled = false;

  if (!response) {
    showNotice("连接后台失败，请重新打开侧边栏。");
    return;
  }

  if (response.state) state = response.state;
  renderState();
});

/* ============================ 发弹幕 ============================ */

async function sendDanmaku() {
  const text = els.danmakuInput.value.trim();
  if (!text || tabId == null) return;

  els.danmakuSend.disabled = true;
  els.sendStatus.textContent = "发送中…";
  els.sendStatus.className = "send-status pending";

  const response = await send({ type: "SEND_DANMAKU", tabId, text });

  els.danmakuSend.disabled = false;

  if (!response) {
    els.sendStatus.textContent = "连接后台失败，请重新打开侧边栏";
    els.sendStatus.className = "send-status err";
    return;
  }

  if (response.error) {
    els.sendStatus.textContent = `发送失败：${response.error}`;
    els.sendStatus.className = "send-status err";
    return;
  }

  els.sendStatus.textContent = "已提交，等页面回报结果…";
  els.sendStatus.className = "send-status pending";
}

els.danmakuSend.addEventListener("click", sendDanmaku);

els.danmakuInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendDanmaku();
});

// 一开始输入就把上一次的结果清掉，避免旧提示留在那儿
els.danmakuInput.addEventListener("input", () => {
  els.sendStatus.textContent = "";
  els.sendStatus.className = "send-status";
});

/* ============================ 跟随当前标签页 ============================ */

chrome.runtime.onMessage.addListener((message) => {
  // 后台推来的改写状态。只认自己这个标签页的，避免串标签。
  if (message?.type === "PANEL_TAB_STATE") {
    if (message.tabId !== tabId) return;
    state = message.state;
    renderState();
    return;
  }

  // 后台推来的直播数据
  if (message?.type === "PANEL_LIVE_DATA") {
    if (message.tabId !== tabId) return;
    live = message.live;
    renderLive(false);
    return;
  }

  // 页面回报的发弹幕结果
  if (message?.type === "PANEL_DANMAKU_RESULT") {
    const result = message.result || {};

    if (result.ok) {
      els.sendStatus.textContent = `发送成功${result.note ? `（${result.note}）` : ""}`;
      els.sendStatus.className = "send-status ok";
      els.danmakuInput.value = "";
    } else {
      els.sendStatus.textContent = `发送失败：${result.error || "未知原因"}`;
      els.sendStatus.className = "send-status err";
    }
  }
});

chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId !== windowId) return;
  refresh();
});

chrome.tabs.onUpdated.addListener((id, info) => {
  if (id !== tabId) return;
  if (info.status === "complete" || info.url) refresh();
});

chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) refresh();
});

chrome.windows.onFocusChanged.addListener((id) => {
  if (id === windowId) refresh();
});

/* ============================ 启动 ============================ */

(async () => {
  const win = await chrome.windows.getCurrent().catch(() => null);
  windowId = win?.id ?? null;
  await refresh();
})();
