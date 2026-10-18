#!/usr/bin/env node
/**
 * 验证两个世界各自只挂了一个全局对象。
 *
 * 隔离世界（content script）和主世界（SDK）不共享 window 上的 JS 属性，CDP 默认
 * 只在主世界求值，所以 window.LivraBridge 得切到隔离世界的执行上下文才看得到。
 *
 * 用法：node test/diag-worlds.js
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const contexts = [];

  await new Promise((r) => { ws.onopen = r; });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.method === "Runtime.executionContextCreated") {
      contexts.push(msg.params.context);
      return;
    }
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

  const { targetInfos } = await send("Target.getTargets");
  const live = targetInfos.find(
    (t) => t.type === "page" && (t.url || "").includes("live.douyin.com")
  );
  if (!live) throw new Error("没找到直播间页面");

  const { sessionId } = await send("Target.attachToTarget", { targetId: live.targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await sleep(600);

  console.log(`直播间页面: ${live.url.slice(0, 60)}`);
  console.log(`执行上下文: ${contexts.length} 个\n`);

  const evalIn = async (contextId, expression) => {
    const r = await send(
      "Runtime.evaluate",
      { expression, contextId, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return r.exceptionDetails
      ? "EXC: " + (r.exceptionDetails.exception?.description || "")
      : r.result?.value;
  };

  const seen = new Set();

  for (const ctx of contexts) {
    const where = `${ctx.auxData?.frameId ? "frame" : "page"} ${ctx.id}`;
    const hasSdk = await evalIn(ctx.id, "typeof window.Livra");
    const hasBridge = await evalIn(ctx.id, "typeof window.Livra?.bridge");

    // 两个对象都不在的上下文（iframe、扩展自己的其它世界）就不展开看了
    if (hasSdk === "undefined") continue;

    // 两个世界各有一份 window.Livra；区分就看 Livra.bridge —— 那个只有桥接层会挂
    const label = hasBridge !== "undefined" ? "隔离世界（桥接层）" : "主世界（SDK）";
    const key = label + hasSdk + hasBridge;
    if (seen.has(key)) continue;
    seen.add(key);

    console.log(`── ${label}  ctx=${ctx.id}  (${where})`);

    if (hasSdk !== "undefined") {
      console.log("   Livra 顶层键 :", await evalIn(ctx.id, "Object.keys(window.Livra).join(', ')"));
      console.log("   已装模块     :", await evalIn(ctx.id, "JSON.stringify(window.Livra.installed)"));
    } else {
      console.log("   Livra        : undefined（隔离世界读不到，符合预期）");
    }

    if (hasBridge !== "undefined") {
      console.log("   bridge 模块  :", await evalIn(ctx.id, "JSON.stringify({ keys: Object.keys(window.Livra.bridge), gen: window.Livra.bridge.gen, hasListener: typeof window.Livra.bridge.listener })"));
      console.log("   wire.b64     :", await evalIn(ctx.id, "typeof window.Livra?.wire?.b64"));
    }

    console.log(
      "   旧键残留     :",
      await evalIn(
        ctx.id,
        `["LivraBridge","__livraHook","LivraTypes","__livraCsGen","__livraWinListener"].filter(k => k in window).join(", ") || "无"`
      ),
      "\n"
    );
  }

  ws.close();
}

main().catch((error) => {
  console.error("失败:", error.message);
  process.exit(1);
});
