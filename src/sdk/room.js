/**
 * SDK · 房间状态
 *
 * SDK 里唯一持有「当前直播间长什么样」的地方。别人（transport / sender / index）
 * 往这里灌数据、从这里读状态。
 *
 * 三类状态：
 *   counts   每种数据各来了多少条 —— 侧边栏顶部那些数字就是它
 *   metrics  会变化的指标（在线人数等），一个 type 对应一个数字
 *   messages 事件流，所有 stream 类数据按时间排成一条，由界面按勾选过滤
 *
 * 攒批：普通直播间每秒好几条消息，每来一条就往外发一次的话宿主会被淹没。
 * 所以 messages 攒 300ms 再 emit；在线人数这类低频数据来了就发。
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.room) return;
  NS.installed.room = true;

  // 页面侧同样不截断：content script / 面板随时能从这里取到本场完整历史。
  // 只有超过安全阀才丢最老的，理由同 store.js。
  const MAX_MESSAGES = 30000;
  const EMIT_DEBOUNCE_MS = 300;

  /** 每种类型都从 0 开始计数，界面直接读，不用自己判断有没有这个 key */
  function emptyCounts() {
    const counts = {};
    for (const type of NS.types.list) counts[type.id] = 0;
    return counts;
  }

  let counts = emptyCounts();
  let metrics = {};
  let messages = [];
  let total = 0;
  let socket = { open: false, url: "", at: 0 };
  let lastAt = 0;

  let pending = [];
  let emitTimer = null;

  function summary() {
    return {
      total,
      counts: { ...counts },
      metrics: { ...metrics },
      socket: { ...socket },
      lastAt,
    };
  }

  function flush() {
    emitTimer = null;
    if (!pending.length) return;

    const batch = pending;
    pending = [];

    NS.bus.emit("messages", { batch, summary: summary() });
  }

  function scheduleEmit() {
    if (emitTimer) return;
    emitTimer = setTimeout(flush, EMIT_DEBOUNCE_MS);
  }

  /* ============================ 灌数据 ============================ */

  function setSocket(open, url) {
    socket = { open: Boolean(open), url: String(url || ""), at: Date.now() };
    NS.bus.emit("socket", { socket: { ...socket }, summary: summary() });
  }

  function ingest(list) {
    if (!Array.isArray(list) || !list.length) return;

    const streamBatch = [];
    let metricsChanged = false;

    for (const message of list) {
      total++;
      lastAt = Date.now();

      const type = NS.types.byId(message.type);

      // 在线人数这类是「当前值」，只更新不入列表
      if (type.kind === NS.types.KIND.METRIC) {
        if (message.value != null) {
          metrics[type.id] = message.value;
          metricsChanged = true;
        }
        continue;
      }

      counts[type.id] = (counts[type.id] || 0) + 1;

      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.shift();

      streamBatch.push(message);
    }

    if (metricsChanged) {
      NS.bus.emit("metrics", { metrics: { ...metrics }, summary: summary() });
    }

    if (streamBatch.length) {
      pending.push(...streamBatch);
      scheduleEmit();
    }
  }

  function clear() {
    counts = emptyCounts();
    metrics = {};
    messages = [];
    total = 0;
    lastAt = 0;

    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    pending = [];

    NS.bus.emit("reset", { summary: summary() });
  }

  /* ============================ 对外读取 ============================ */

  NS.room = {
    state: summary,
    metrics: () => ({ ...metrics }),
    counts: () => ({ ...counts }),
    // 不传 limit 就给全量 —— 面板重开、插件重载后要靠它把历史补回来
    messages: (limit) => (limit ? messages.slice(-limit) : messages.slice()),
    total: () => total,
    isConnected: () => socket.open,

    ingest,
    setSocket,
    clear,
  };
})();
