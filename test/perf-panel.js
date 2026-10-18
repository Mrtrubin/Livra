#!/usr/bin/env node
/**
 * 面板渲染性能采样：对比「增量渲染」和老的「整包重发 + 全量重建」两种方案。
 *
 * 用法：
 *   node test/perf-panel.js [采样秒数]        采样真实直播间流量
 *   INJECT=300 node test/perf-panel.js 6     灌 300 条合成消息，结果不受直播间忙闲影响
 *
 * 三个指标，每一项都给出「实际」和「整包方案会怎样」：
 *   传输条数     后台 -> 面板 每次带多少条消息
 *   传输体积     这些消息序列化后的字节数
 *   DOM 新增节点 面板为了渲染这些消息创建了多少个节点
 *
 * 「整包方案」的对照是**在同一批事件上**算出来的：每个事件到达时记下当时列表的长度，
 * 老方案就是把这个长度的列表整个发一遍、整个重建一遍。
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const SECONDS = Number(process.argv[2] || 25);
const INJECT = Number(process.env.INJECT || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (bytes) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  await new Promise((r) => { ws.onopen = r; });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      const payload = { id: i, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });

  // 复用 session，别反复 attach
  const sessions = new Map();
  const evalIn = async (targetId, expression) => {
    if (!sessions.has(targetId)) {
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      sessions.set(targetId, sessionId);
    }
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessions.get(targetId)
    );
    if (r.exceptionDetails) return "EXCEPTION: " + (r.exceptionDetails.exception?.description || "");
    return r.result?.value;
  };

  const targets = (await send("Target.getTargets")).targetInfos;
  const live = targets.find((t) => t.type === "page" && (t.url || "").includes("live.douyin.com"));
  const panel = targets.find((t) => t.type === "page" && (t.url || "").includes("panel.html"));

  if (!panel) throw new Error("面板没打开，先跑 node test/bridge.js panel");

  /* ---------- 装计数器 ---------- */

  const armed = await evalIn(
    panel.targetId,
    `(() => {
      // 这个脚本可能跑多次，先把上一轮的监听器摘掉，否则计数会成倍虚高
      if (self.__perfListener) chrome.runtime.onMessage.removeListener(self.__perfListener);
      if (self.__perfObserver) self.__perfObserver.disconnect();

      // localTotal 从面板当前已经持有的条数起步 —— 老方案每次广播都是按这个长度整包发的
      self.__perf = {
        events: 0, appended: 0, replace: 0, bytes: 0, naiveMsgs: 0, domAdded: 0,
        localTotal: document.querySelectorAll("#messageList .msg").length,
      };

      const list = document.getElementById("messageList");
      self.__perfObserver = new MutationObserver((records) => {
        for (const r of records) self.__perf.domAdded += r.addedNodes.length;
      });
      self.__perfObserver.observe(list, { childList: true });

      self.__perfListener = (m) => {
        if (!m || m.type !== "PANEL_LIVE_DATA") return;
        const p = self.__perf;
        p.events++;

        // 实际传了什么
        const sent = m.appended || [];
        p.appended += sent.length;
        p.bytes += JSON.stringify(sent).length;

        // 同一时刻，老方案会把**整个列表**发一遍、重建一遍。
        // 采样器自己维护一份列表长度（上限 300），就能算出老方案每次会传多少条。
        if (m.replace) p.localTotal = (m.messages || []).length;
        else p.localTotal = Math.min(p.localTotal + sent.length, 300);
        if (m.replace) p.replace++;

        p.naiveMsgs += p.localTotal;
      };
      chrome.runtime.onMessage.addListener(self.__perfListener);
      return "armed";
    })()`
  );

  if (armed !== "armed") throw new Error(`装计数器失败：${armed}`);

  /* ---------- 压测模式 ---------- */

  if (INJECT > 0) {
    if (!live) throw new Error("没找到直播间页面");

    await evalIn(live.targetId, "window.Livra.room.clear()");
    await sleep(500);

    const BATCH = 10;
    const ROUNDS = Math.ceil(INJECT / BATCH);

    for (let i = 0; i < ROUNDS; i++) {
      await evalIn(
        live.targetId,
        `(() => {
          const now = Date.now();
          const batch = [];
          for (let k = 0; k < ${BATCH}; k++) {
            const n = ${i} * ${BATCH} + k;
            batch.push({
              id: "perf-" + now + "-" + n, method: "WebcastChatMessage", type: "danmaku",
              content: "压测消息 " + n, value: null,
              user: { id: "pu" + n, nickname: "压测用户" + n }, extra: {}, ts: now + k
            });
          }
          window.Livra.room.ingest(batch);
          return batch.length;
        })()`
      );
      await sleep(120);
    }

    console.log(`已注入 ${ROUNDS * BATCH} 条合成消息`);
  }

  console.log(`采样 ${SECONDS} 秒…`);
  await sleep(SECONDS * 1000);

  const perf = JSON.parse(await evalIn(panel.targetId, "JSON.stringify(self.__perf)"));
  const domCount = await evalIn(panel.targetId, "document.querySelectorAll('#messageList .msg').length");

  const cut = (actual, naive) =>
    naive ? `${(100 - (actual / naive) * 100).toFixed(1)}%` : "—";

  // 平均每条多少字节，用它把「条数」折算成体积
  const avgBytes = perf.appended ? perf.bytes / perf.appended : 0;
  const naiveBytes = Math.round(perf.naiveMsgs * avgBytes);

  console.log(`
广播次数            : ${perf.events} 次（其中整包重建 ${perf.replace} 次）

传输消息条数        增量 ${perf.appended} 条        整包方案 ${perf.naiveMsgs} 条      省 ${cut(perf.appended, perf.naiveMsgs)}
传输体积            增量 ${kb(perf.bytes)}        整包方案 ${kb(naiveBytes)}      省 ${cut(perf.bytes, naiveBytes)}
DOM 新增节点        增量 ${perf.domAdded} 个        整包方案 ${perf.naiveMsgs} 个      省 ${cut(perf.domAdded, perf.naiveMsgs)}

当前 DOM 消息节点   : ${domCount} 个（上限 300，超了从顶部裁）
`);

  ws.close();
}

main().catch((error) => {
  console.error("失败:", error.message);
  process.exit(1);
});
