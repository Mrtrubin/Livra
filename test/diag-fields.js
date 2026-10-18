#!/usr/bin/env node
/**
 * 验证「解码后完整保留、SDK 不处理、展示层自行解释」这条改造。
 *
 * 看三件事：
 *   1. 解码后的消息有没有带上完整字段（fields）
 *   2. 展示层能不能从字段里解出礼物名称 + 数量
 *   3. 面板里实际渲染出来的礼物文案长什么样
 *
 * 用法：node test/diag-fields.js [等礼物的秒数]
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const WAIT = Number(process.argv[2] || 60);

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

  const { targetInfos } = await send("Target.getTargets");
  const live = targetInfos.find((t) => t.type === "page" && (t.url || "").includes("live.douyin.com"));
  const panel = targetInfos.find((t) => t.type === "page" && (t.url || "").includes("panel.html"));
  if (!live || !panel) throw new Error("需要直播间页面和面板页面都开着");

  const sl = (await send("Target.attachToTarget", { targetId: live.targetId, flatten: true })).sessionId;
  const sp = (await send("Target.attachToTarget", { targetId: panel.targetId, flatten: true })).sessionId;

  const evLive = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sl);
    return r.exceptionDetails ? "EXC: " + (r.exceptionDetails.exception?.description || "") : r.result?.value;
  };
  const evPanel = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sp);
    return r.exceptionDetails ? "EXC: " + (r.exceptionDetails.exception?.description || "") : r.result?.value;
  };

  console.log("── 1. 解码层：字段有没有完整保留 ──");
  console.log(
    "  消息示例 ×3:",
    await evLive(
      `JSON.stringify(window.Livra.room.messages().slice(-3).map((m) => ({
        type: m.type,
        fields个: m.fields ? m.fields.length : "❌没有 fields",
        字段名: m.fields ? m.fields.map((f) => f.no).slice(0, 12).join(",") : "-",
        还有content吗: "content" in m ? "❌还在" : "已移除",
        还有extra吗: "extra" in m ? "❌还在" : "已移除"
      })), null, 1)`
    )
  );

  console.log(`\n── 2. 等 ${WAIT} 秒收礼物 ──`);
  for (let i = 0; i < WAIT; i++) {
    await sleep(1000);
    if (i % 15 === 14) {
      console.log(`  ${i + 1}s：礼物 ${await evLive('window.Livra.room.counts().gift')} 条`);
    }
  }

  console.log("\n── 3. 展示层：从字段里解出礼物名和数量 ──");
  console.log(
    await evPanel(
      `(() => {
        const rows = [...document.querySelectorAll('#messageList .msg')]
          .filter((n) => n.querySelector('.kind')?.textContent === '礼物');
        return rows.length
          ? rows.map((n) => n.textContent.trim().replace(/\\s+/g, ' ')).join("\\n  ")
          : "当前视口里没有礼物消息（滚一滚或等下一条）";
      })()`
    )
  );

  console.log("\n── 4. 直接调展示层接口验证 ──");
  console.log(
    await evLive(
      `(() => {
        const gifts = window.Livra.room.messages().filter((m) => m.type === "gift").slice(-3);
        if (!gifts.length) return "这段时间没收到礼物";
        // 面板里的 format.js 在页面这边没有，这里按同样规则复算一遍做交叉验证
        const wire = window.Livra.wire;
        return gifts.map((m) => {
          const g15 = m.fields.find((f) => f.no === 15);
          const inner = g15 ? wire.decodeFields(g15.bytes) : [];
          const name = wire.str(inner.find((f) => f.no === 16)) || wire.str(inner.find((f) => f.no === 2));
          return JSON.stringify({ 礼物名: name, 本次数量: wire.num(m.fields, 5), 累计: wire.num(m.fields, 29) });
        }).join("\\n  ");
      })()`
    )
  );

  ws.close();
}

main().catch((error) => {
  console.error("失败:", error.message);
  process.exit(1);
});
