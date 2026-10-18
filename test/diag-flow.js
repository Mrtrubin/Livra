#!/usr/bin/env node
/**
 * 链路诊断：验证 SDK -> content script -> 后台 -> 面板 这条增量链路到底通不通。
 *
 * 用法：node test/diag-flow.js
 *
 * 每一段都打印实际返回值，哪一步断了立刻能看出来。
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // 复用同一个 session，避免反复 attach
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
  const page = (kw) => targets.find((t) => t.type === "page" && (t.url || "").includes(kw));

  const live = page("live.douyin.com");
  const panel = page("panel.html");

  console.log("直播间页面:", live ? live.url.slice(0, 70) : "❌ 没找到");
  console.log("面板页面  :", panel ? panel.url.slice(0, 70) : "❌ 没找到");
  if (!live || !panel) throw new Error("缺少目标页面");

  /* ---------- 1. SDK 在不在 ---------- */
  console.log("\n--- 1. 全局对象 ---");
  console.log("window.Livra      :", await evalIn(live.targetId, "typeof window.Livra"));
  console.log(
    "  顶层键          :",
    await evalIn(live.targetId, "Object.keys(window.Livra).join(', ')")
  );
  console.log(
    "  已装模块        :",
    await evalIn(live.targetId, "JSON.stringify(window.Livra.installed)")
  );
  console.log(
    "  协议标记        :",
    await evalIn(live.targetId, "JSON.stringify(window.Livra.protocol)")
  );
  console.log(
    "  原生 API 备份   :",
    await evalIn(live.targetId, "Object.keys(window.Livra.native || {}).join(', ')")
  );
  // 桥接层在隔离世界，主世界看不到它 —— 这里期望是 undefined
  console.log(
    "window.Livra.bridge:",
    await evalIn(live.targetId, "typeof window.Livra.bridge"),
    "/ gen =",
    await evalIn(live.targetId, "window.Livra.bridge?.gen ?? 'none'")
  );
  // 这几个键以前是直接撒在 window 上的，现在应该都没了
  console.log(
    "残留旧键          :",
    await evalIn(
      live.targetId,
      `["__livraHook","LivraTypes","__livraCsGen","__livraWinListener"]
        .filter(k => k in window).join(", ") || "无"`
    )
  );
  console.log("room.ingest       :", await evalIn(live.targetId, "typeof window.Livra?.room?.ingest"));
  console.log("HUD 节点          :", await evalIn(live.targetId, "!!document.getElementById('livra-hud')"));

  /* ---------- 2. 面板装计数器 ---------- */
  console.log("\n--- 2. 面板计数器 ---");
  console.log(
    await evalIn(
      panel.targetId,
      `(() => {
        self.__perf = { events: 0, appended: 0, replace: 0, lastTypes: {} };
        chrome.runtime.onMessage.addListener((m) => {
          if (m && m.type === "PANEL_LIVE_DATA") {
            self.__perf.events++;
            if (m.replace) self.__perf.replace++;
            self.__perf.appended += (m.appended || []).length;
            self.__perf.lastTypes[m.replace ? "replace" : (m.appended ? "appended" : "plain")] =
              (self.__perf.lastTypes[m.replace ? "replace" : (m.appended ? "appended" : "plain")] || 0) + 1;
          }
        });
        return "armed";
      })()`
    )
  );

  /* ---------- 3. 清空后注入 ---------- */
  console.log("\n--- 3. 注入 ---");
  console.log("clear():", await evalIn(live.targetId, "window.Livra.room.clear() ?? 'ok'"));
  await sleep(600);
  console.log("清空后 room.total():", await evalIn(live.targetId, "window.Livra.room.total()"));

  const inject = (n) =>
    evalIn(
      live.targetId,
      `(() => {
        const now = Date.now();
        const batch = [];
        for (let k = 0; k < ${n}; k++) {
          batch.push({
            id: "diag-" + now + "-" + k, method: "WebcastChatMessage", type: "danmaku",
            content: "诊断消息 " + k, value: null,
            user: { id: "pu" + k, nickname: "诊断用户" + k }, extra: {}, ts: now + k
          });
        }
        window.Livra.room.ingest(batch);
        return batch.length;
      })()`
    );

  console.log("注入返回  :", await inject(10));
  await sleep(500);
  console.log("注入后 room.total():", await evalIn(live.targetId, "window.Livra.room.total()"));

  for (let i = 0; i < 9; i++) {
    await inject(10);
    await sleep(150);
  }
  console.log("二轮注入后 room.total():", await evalIn(live.targetId, "window.Livra.room.total()"));

  /* ---------- 4. 看结果 ---------- */
  console.log("\n--- 4. 结果 ---");
  await sleep(1500);
  console.log("面板计数器:", await evalIn(panel.targetId, "JSON.stringify(self.__perf)"));
  console.log(
    "面板本地消息数:",
    await evalIn(panel.targetId, "((window.__livraPanel?.live?.messages) || []).length")
  );
  console.log("DOM 消息节点 :", await evalIn(panel.targetId, "document.querySelectorAll('#messageList .msg').length"));

  /**
   * 5. 跨世界调用往返
   * 面板 -> 后台 -> 桥接层 --postMessage(CALL)--> SDK --postMessage(RESULT)--> 桥接层 -> 后台 -> 面板
   * 走的正是 namespace.js 里那两个跨世界标记（CALL / RESULT），两个世界共用同一份定义。
   * 用 PULL_SNAPSHOT 而不是真发弹幕：链路完全一样，但不会往直播间里发东西。
   */
  console.log("\n--- 5. 跨世界调用往返 ---");
  const before = JSON.parse(await evalIn(panel.targetId, "JSON.stringify(self.__perf)"));

  console.log(
    "PULL_SNAPSHOT   :",
    await evalIn(
      panel.targetId,
      `chrome.runtime.sendMessage({ type: "GET_PANEL_STATE" })
        .then((r) => (r?.tab?.id == null
          ? "拿不到标签页"
          : chrome.runtime.sendMessage({ type: "PULL_SNAPSHOT", tabId: r.tab.id })))
        .then(() => "sent")
        .catch((e) => "ERR " + e.message)`
    )
  );

  await sleep(2000);
  const after = JSON.parse(await evalIn(panel.targetId, "JSON.stringify(self.__perf)"));
  const delta = after.replace - before.replace;

  console.log(
    `新增整包广播    : ${delta} 次`,
    delta > 0 ? "→ 调用往返正常（SDK 回了 RESULT，桥接层转成 LIVE_SYNC）" : "→ ⚠️ 跨世界调用可能断了"
  );

  ws.close();
}

main().catch((error) => {
  console.error("失败:", error.message);
  process.exit(1);
});
