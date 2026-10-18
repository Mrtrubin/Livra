/**
 * 面板 · 侧边栏界面
 *
 * 面板是「窗口级」的：一个窗口一个面板，内容始终跟随该窗口的**当前标签页**。
 * 所以切换标签页时要重新取状态（onActivated / onUpdated / onFocusChanged）。
 *
 * 整个面板只做两件事：
 *   1. 读：把 store 里的直播数据显示出来（哪些类型出现由「数据类型」tab 里的勾选决定）
 *   2. 写：发一条弹幕
 * 真正的状态在后台 store.js 里，抖音协议在 sdk/ 里 —— 这里一行都不碰。
 *
 * 布局是两个 tab：消息流看数据，数据类型管「要哪些数据」。在线人数和消息总数
 * 交给页面上的浮窗显示，面板不重复摆。
 */

/**
 * 类型清单直接从 SDK 的类型定义读 —— 和页面里给消息打标记用的是同一份文件，
 * 不会出现「面板能勾，但页面不知道这是什么」的情况。
 */
const CATALOG = window.Livra ? window.Livra.types.catalog() : [];

// 消息文案由展示层负责 —— SDK 只解码并完整保留字段，不替界面决定显示什么
const describeMessage = window.Livra?.format?.describe || (() => "");

const els = {
  badge: document.getElementById("badge"),

  tabs: [...document.querySelectorAll(".tab")],
  panes: {
    stream: document.getElementById("pane-stream"),
    types: document.getElementById("pane-types"),
  },

  // 虚拟滚动两件套：撑出滚动高度的容器 + 里面真实渲染的行
  list: document.getElementById("messageList"),
  rows: document.getElementById("messageRows"),
  messageEmpty: document.getElementById("messageEmpty"),
  streamCount: document.getElementById("streamCount"),

  typeList: document.getElementById("typeList"),
  typeCount: document.getElementById("typeCount"),
  selectAll: document.getElementById("selectAll"),

  danmakuInput: document.getElementById("danmakuInput"),
  danmakuSend: document.getElementById("danmakuSend"),
  sendStatus: document.getElementById("sendStatus"),
};

let windowId = null;
let tabId = null;

// 当前这轮数据的概要（后台每次只发概要，消息列表另走增量/整包）
let live = {
  counts: {},
  metrics: {},
  socket: { open: false },
};

/**
 * 本场完整历史，面板自己攒的一份副本。
 *
 * ⚠️ 不能直接挂在 live 上：后台每次广播都带一份新的 live（只有概要、没有 messages），
 * 一赋值就把历史冲掉了。所以完整列表单独存。
 */
let allMessages = [];

// 勾选项：{ [typeId]: boolean }
let visible = {};

const typeMeta = new Map();

/* ============================ 通信 ============================ */

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

async function refresh() {
  const response = await send({ type: "GET_PANEL_STATE", windowId });

  if (!response) {
    els.badge.textContent = "离线";
    els.badge.className = "badge off";
    return;
  }

  tabId = response.tab?.id ?? null;
  live = response.live || live;
  allMessages = response.live?.messages || [];
  if (response.visible) visible = response.visible;

  syncVisibleWithTypes();
  updatePresence(response.injectable);
  renderTypeList();
  rebuildList();
}

/** 类型清单和勾选偏好对齐：新出现的类型按 SDK 的默认值 */
function syncVisibleWithTypes() {
  let changed = false;

  for (const type of CATALOG) {
    if (typeof visible[type.id] !== "boolean") {
      visible[type.id] = type.defaultOn !== false;
      changed = true;
    }
  }

  if (changed) persistVisible();
}

function persistVisible() {
  send({ type: "SET_VISIBILITY", visible });
}

/* ============================ 渲染 ============================ */

/** 徽章只表达「这个标签页到底有没有在采集数据」这一件事 */
function updatePresence(injectable) {
  if (injectable === false) {
    els.badge.textContent = "非直播间";
    els.badge.className = "badge off";
    return;
  }

  const connected = live.socket?.open === true;
  els.badge.textContent = connected ? "已连接" : allMessages.length ? "已断开" : "未连接";
  els.badge.className = "badge" + (connected ? " on" : "");
}

const formatNumber = (n) => {
  if (n == null) return "—";
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
};

/* ---------------- 数据类型 tab ---------------- */

function renderTypeList() {
  els.typeList.textContent = "";

  for (const type of CATALOG) els.typeList.append(buildTypeItem(type));

  updateTypeCount();
}

function buildTypeItem(type) {
  const row = document.createElement("label");
  row.className = "type-item";
  row.dataset.id = type.id;
  row.title = type.desc || "";

  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = visible[type.id] !== false;

  box.addEventListener("change", () => {
    visible[type.id] = box.checked;
    persistVisible();
    updateTypeCount();
    rebuildList();
  });

  const dot = document.createElement("span");
  dot.className = "dot c-" + (type.color || "gray");

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = type.label;

  const count = document.createElement("span");
  count.className = "count";

  const value = live.counts?.[type.id] || 0;
  count.textContent = String(value);
  count.classList.toggle("has", value > 0);

  row.append(box, dot, name, count);
  return row;
}

/** 只刷计数（后台来新数据时用，不重建 DOM，免得刚点下去的焦点丢掉） */
function refreshTypeCounts() {
  for (const type of CATALOG) {
    const row = els.typeList.querySelector(`[data-id="${type.id}"]`);
    if (!row) continue;

    const count = live.counts?.[type.id] || 0;
    const el = row.querySelector(".count");

    el.textContent = String(count);
    el.classList.toggle("has", count > 0);
  }
}

function updateTypeCount() {
  els.typeCount.textContent = String(CATALOG.filter((t) => visible[t.id] !== false).length);
}

/* ---------------- 消息流 tab ---------------- */

function metaOf(id) {
  if (!typeMeta.has(id)) {
    for (const type of CATALOG) if (type.id === id) typeMeta.set(id, type);
  }
  return typeMeta.get(id) || { label: id, color: "gray" };
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 行节点只建一次，之后一直复用。
 * _parts 存住四个子元素的引用，填充时不用再查 DOM。
 */
function createRowNode() {
  const row = document.createElement("div");
  row.className = "msg";

  // 类型标签放最前：扫消息时先看是什么类型，再决定要不要细看
  const kind = document.createElement("span");
  kind.className = "kind";

  const who = document.createElement("span");
  who.className = "who";

  const text = document.createElement("span");
  text.className = "text";

  const time = document.createElement("span");
  time.className = "time";

  row.append(kind, who, text, time);
  row._parts = { kind, who, text, time };
  return row;
}

/** 把一条消息填进已有的行节点：只改文本和 class，节点本身不动 */
function fillRowNode(row, message) {
  const meta = metaOf(message.type);
  const parts = row._parts;

  parts.kind.className = "kind c-" + (meta.color || "gray");
  parts.kind.textContent = meta.short || meta.label;

  const who = message.user?.nickname || "";
  parts.who.textContent = who;
  parts.who.hidden = !who;

  parts.text.textContent = describeMessage(message);
  parts.time.textContent = formatTime(message.ts);
}

/* ---------------- 渲染：虚拟滚动 ----------------
 *
 * 消息本体一直在内存里（后台和页面都不再截断，标签关掉才释放），但 DOM 里只放
 * **视口里那几十行**，外加上下各一小段缓冲。
 *
 * 定位方式：#messageList 撑出完整滚动高度（条数 × 行距），可见行绝对定位、
 * 用 translateY(下标 × 行距) 摆到自己的位置。
 *
 * ⚠️ 为什么不用上下两块占位：那样每滚一行都要改视口**上方**那块的高度，浏览器
 * 的滚动锚定会「补偿」这个变化、反向改 scrollTop，于是又触发一次 scroll ——
 * 一次手滚被放大成每帧一次的循环，滚到列表边界才停。改成 translateY 之后，
 * 上方没有任何盒子的高度会变，锚定无从下手，循环从源头断掉。
 * （这也是 TanStack Virtual / virtua 的定位方式；配套还要在 .pane 上关掉
 * overflow-anchor，双保险。）
 */

// 视口外多渲染几行：快速滚动时不至于闪白
const BUFFER_ROWS = 8;

let filtered = [];      // 按勾选过滤后的消息，滚动只在这个数组里按下标取
let windowStart = -1;   // 当前已渲染的区间 [windowStart, windowEnd)
let windowEnd = -1;
let rowStep = 33;       // 一行占的高度（行高 + 间距），启动时从 CSS 变量读
let renderQueued = false;

/**
 * 用户是不是贴着底部看直播。
 *
 * 只在真正的 scroll 事件里更新。反过来在收到新消息时现算 scrollHeight 是不准的：
 * 那时容器还是上一帧的高度，会把正在翻历史的人误判成「贴底」，一次次拽回底部。
 */
let stuckToBottom = true;

// 复用节点池：DOM 里始终只有视口 + 缓冲这么多行，滚动时只改内容和位置
let pool = [];

function readRowStep() {
  const style = getComputedStyle(document.documentElement);
  const h = parseFloat(style.getPropertyValue("--msg-h")) || 30;
  const gap = parseFloat(style.getPropertyValue("--msg-gap")) || 3;
  rowStep = h + gap;
}

function isVisible(message) {
  return visible[message.type] !== false;
}

/** 内容总高度。行的位置由 translateY 决定，容器只负责把滚动条撑到这个高度 */
function contentHeight() {
  return filtered.length * rowStep;
}

/**
 * 按当前滚动位置渲染视口那一段。
 * 区间没变化就直接返回 —— 高频新消息大多落在视口下方，那时只有容器高度要改。
 */
function renderWindow(force = false) {
  const pane = els.panes.stream;
  const total = filtered.length;

  const height = `${contentHeight()}px`;
  if (els.list.style.height !== height) els.list.style.height = height;

  els.messageEmpty.hidden = total > 0;
  els.streamCount.textContent = formatNumber(total);

  const first = Math.max(0, Math.floor(pane.scrollTop / rowStep) - BUFFER_ROWS);
  const count = Math.ceil(pane.clientHeight / rowStep) + BUFFER_ROWS * 2;
  const last = Math.min(total, first + count);

  if (!force && first === windowStart && last === windowEnd) return;

  windowStart = first;
  windowEnd = last;

  // 节点池按需伸缩，绝不整块清空重建
  const need = last - first;
  while (pool.length < need) {
    const row = createRowNode();
    els.rows.append(row);
    pool.push(row);
  }
  while (pool.length > need) pool.pop().remove();

  for (let i = first; i < last; i++) {
    const row = pool[i - first];
    fillRowNode(row, filtered[i]);
    row.style.transform = `translateY(${i * rowStep}px)`;
  }
}

/**
 * 攒到下一帧再渲染。
 *
 * ⚠️ 后台标签页里 requestAnimationFrame **不会触发**（浏览器不绘制就不给帧），
 * 所以看不见的时候直接同步刷 —— 反正没人看，省一帧没意义。
 */
function scheduleRender() {
  if (renderQueued) return;

  if (document.hidden) {
    renderWindow();
    return;
  }

  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderWindow();
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderWindow(true);
});

/** 重算过滤后的列表。整包替换、勾选项变化时才走 —— 要扫全量，平时不碰 */
function rebuildList() {
  filtered = allMessages.filter(isVisible);
  windowStart = windowEnd = -1;

  renderWindow(true);
  // 原来贴着底部（首屏也是这个状态）就继续贴底，正在翻历史就不动他
  if (stuckToBottom) els.panes.stream.scrollTop = els.panes.stream.scrollHeight;
}

/**
 * 追加一批新消息。
 * 用户贴着底部时跟着往下走（直播间的正常看法）；往上翻历史时不打断他。
 */
function ingestAppended(list) {
  if (!list || !list.length) return;

  let added = 0;
  for (const message of list) if (isVisible(message)) { filtered.push(message); added++; }
  if (!added) return;

  // 先把容器撑到新高度，再压到底 —— 顺序反过来会被浏览器夹到旧的最大滚动距离
  els.list.style.height = `${contentHeight()}px`;
  if (stuckToBottom) els.panes.stream.scrollTop = els.panes.stream.scrollHeight;

  scheduleRender();
}

/**
 * 滚动时只做两件事：更新「贴底」状态，重算可视区间。
 *
 * 贴底与否**只在 scroll 事件里判定**：这里的 scrollHeight 是最新的，
 * 不像 ingestAppended 那样读到上一帧的旧高度。走 scheduleRender 是为了
 * 复用「后台标签页里 rAF 不触发」的兜底。
 */
els.panes.stream.addEventListener(
  "scroll",
  () => {
    const pane = els.panes.stream;
    stuckToBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= rowStep * 1.5;
    scheduleRender();
  },
  { passive: true }
);

window.addEventListener("resize", () => renderWindow(true));

/* ============================ 交互 ============================ */

function switchTab(name) {
  for (const tab of els.tabs) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
    els.panes[tab.dataset.tab].hidden = !on;
  }

  // 消息流 tab 隐藏时 clientHeight 是 0，切回来得按真实高度重算一次
  if (name === "stream") renderWindow(true);
}

for (const tab of els.tabs) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
}

els.selectAll.addEventListener("click", () => {
  const allOn = CATALOG.every((t) => visible[t.id] !== false);

  for (const type of CATALOG) visible[type.id] = !allOn;
  persistVisible();
  renderTypeList();
  rebuildList();
});

async function sendDanmaku() {
  const text = els.danmakuInput.value.trim();
  if (!text || tabId == null) return;

  els.danmakuSend.disabled = true;
  setSendStatus("发送中…", "pending");

  const response = await send({ type: "SEND_DANMAKU", tabId, text });

  els.danmakuSend.disabled = false;

  if (!response) {
    setSendStatus("连接后台失败，请重新打开侧边栏", "err");
    return;
  }

  if (response.error) {
    setSendStatus(`发送失败：${response.error}`, "err");
    return;
  }

  setSendStatus("已提交，等页面回报结果…", "pending");
}

function setSendStatus(text, kind) {
  els.sendStatus.textContent = text;
  els.sendStatus.className = "send-status " + (kind || "");
}

els.danmakuSend.addEventListener("click", sendDanmaku);

els.danmakuInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendDanmaku();
});

els.danmakuInput.addEventListener("input", () => {
  els.sendStatus.textContent = "";
  els.sendStatus.className = "send-status";
});

/* ============================ 后台推送 ============================ */

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PANEL_LIVE_DATA") {
    if (message.tabId !== tabId) return;

    live = message.live;

    syncVisibleWithTypes();
    updatePresence(true);
    refreshTypeCounts();

    if (message.replace) {
      // 整包：首屏、页面同步、重置 —— 后台把完整列表发过来了
      allMessages = message.messages || [];
      rebuildList();
    } else if (message.appended?.length) {
      // 增量：完整历史自己攒着（改勾选时要重算），DOM 只动视口那几十行
      allMessages.push(...message.appended);
      ingestAppended(message.appended);
    }
    return;
  }

  if (message?.type === "PANEL_DANMAKU_RESULT") {
    const result = message.result || {};

    if (result.ok) {
      setSendStatus(`发送成功${result.note ? `（${result.note}）` : ""}`, "ok");
      els.danmakuInput.value = "";
    } else {
      setSendStatus(`发送失败：${result.error || "未知原因"}`, "err");
    }
  }
});

/* ============================ 跟随当前标签页 ============================ */

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
  readRowStep();

  const win = await chrome.windows.getCurrent().catch(() => null);
  windowId = win?.id ?? null;
  await refresh();

  // 面板可能比后台里的旧数据晚到，主动要一次全量快照
  if (tabId != null) send({ type: "PULL_SNAPSHOT", tabId });
})();
