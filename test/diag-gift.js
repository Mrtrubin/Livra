#!/usr/bin/env node
/**
 * 抓一条真实的 WebcastGiftMessage，把它的 protobuf 字段树打出来。
 *
 * 用来确认礼物名称、数量、价值到底在第几个字段（不靠猜）。
 *
 * 用法：node test/diag-gift.js [等待秒数]
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const WAIT = Number(process.argv[2] || 25);

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
  const live = targetInfos.find(
    (t) => t.type === "page" && (t.url || "").includes("live.douyin.com")
  );
  if (!live) throw new Error("没找到直播间页面");

  const { sessionId } = await send("Target.attachToTarget", { targetId: live.targetId, flatten: true });

  const ev = async (expression) => {
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    return r.exceptionDetails
      ? "EXC: " + (r.exceptionDetails.exception?.description || "")
      : r.result?.value;
  };

  /**
   * 包一层 decodePushFrame。
   * ⚠️ 不能去包 decoder.extractMessage —— decodePushFrame 内部调的是闭包里的那个，
   * 换导出对象上的引用拦不到。所以这里自己再解一遍原始帧找礼物消息。
   */
  const hooked = await ev(`
    (() => {
      if (!window.Livra || !window.Livra.decoder) return "no-sdk";
      if (window.__giftHookV3) return "already";
      window.__giftHookV3 = true;

      const wire = window.Livra.wire;
      const { decodeFields, str, num, isGzip, gunzip } = wire;
      window.__giftDump = [];

      const describe = (bytes, depth) => {
        if (depth > 2 || !bytes) return null;
        let fields;
        try { fields = decodeFields(bytes); } catch { return "(解不开)"; }

        return fields.map((f) => {
          const item = { no: f.no, wire: f.wire };
          if (f.wire === 0) item.v = f.value;
          else if (f.wire === 2) {
            const s = str(f);
            // 像文本就当文本记，否则当嵌套结构再展开一层
            if (s && /^[\\u0009\\u000a\\u000d\\u0020-\\u007e\\u4e00-\\u9fa5]+$/.test(s) && s.length <= 80) item.s = s;
            else if (depth < 2) item.nested = describe(f.bytes, depth + 1);
            else item.len = f.bytes ? f.bytes.length : 0;
          } else if (f.wire === 5) item.fixed32 = f.value;
          else if (f.wire === 1) item.fixed64 = f.value;
          return item;
        });
      };

      async function scan(bytes) {
        try {
          const frame = decodeFields(bytes);
          if (num(frame, 1) === 1) return;
          const payload = frame.find((f) => f.no === 8)?.bytes;
          if (!payload || payload.length < 2) return;

          let plain = payload;
          if (isGzip(payload)) plain = await gunzip(payload);

          for (const field of decodeFields(plain).filter((f) => f.no === 1)) {
            const message = decodeFields(field.bytes);
            const method = str(message.find((f) => f.no === 1));
            const body = message.find((f) => f.no === 2)?.bytes;
            if (method === "WebcastGiftMessage" && body && window.__giftDump.length < 4) {
              window.__giftDump.push(describe(body, 0));
            }
          }
        } catch {}
      }

      const orig = window.Livra.decoder.decodePushFrame;
      window.Livra.decoder.decodePushFrame = async function (bytes) {
        await scan(bytes);
        return orig.call(this, bytes);
      };
      return "hooked";
    })()
  `);

  if (hooked !== "hooked" && hooked !== "already") throw new Error(`装 hook 失败：${hooked}`);
  console.log(`hook 状态: ${hooked}，等 ${WAIT} 秒收礼物消息…\n`);

  for (let i = 0; i < WAIT; i++) {
    await sleep(1000);
    const n = await ev("window.__giftDump.length");
    if (i % 10 === 9) {
      console.log(
        `  ${i + 1}s：抓到 ${n} 条礼物，当前礼物计数 ${await ev("window.Livra.room.counts().gift")}`
      );
    }
    if (Number(n) >= 1) break;
  }

  const dump = await ev("JSON.stringify(window.__giftDump)");
  const parsed = JSON.parse(dump || "[]");

  if (!parsed.length) {
    console.log("这段时间没人送礼物，换个热闹点的直播间或多等一会儿再试。");
    ws.close();
    return;
  }

  const flat = (list, indent = "  ") => {
    for (const f of list || []) {
      const head = `#${f.no}(wire ${f.wire})`;
      if (f.s !== undefined) console.log(`${indent}${head} 字符串 "${f.s}"`);
      else if (f.v !== undefined) console.log(`${indent}${head} 数字 ${f.v}`);
      else if (f.fixed32 !== undefined) console.log(`${indent}${head} fixed32 ${f.fixed32}`);
      else if (f.fixed64 !== undefined) console.log(`${indent}${head} fixed64 ${f.fixed64}`);
      else if (f.nested) {
        console.log(`${indent}${head} 嵌套结构 {`);
        if (typeof f.nested === "string") console.log(`${indent}  ${f.nested}`);
        else flat(f.nested, indent + "  ");
        console.log(`${indent}}`);
      } else console.log(`${indent}${head} 字节 ${f.len || 0}`);
    }
  };

  parsed.forEach((item, i) => {
    console.log(`───── 礼物消息 ${i + 1} ─────`);
    flat(item);
    console.log();
  });

  // 关键字段摘要：几条对比一下才能看出哪个是数量（单个礼物时多个字段值会撞在一起）
  console.log("关键字段摘要：");
  console.log(
    await ev(
      `JSON.stringify(window.__giftDump.map((d) => {
        const g = (no) => d.find((f) => f.no === no);
        const gift = g(15)?.nested || [];
        const gg = (n) => gift.find((f) => f.no === n);
        return {
          giftId: g(2)?.v, d4: g(4)?.v, d5: g(5)?.v, d6: g(6)?.v,
          d29: g(29)?.v, d30: g(30)?.v, d43: g(43)?.v,
          d18: g(18)?.nested?.map((x) => "#" + x.no + "=" + x.v).join(","),
          gift内: { id: gg(5)?.v, name: gg(16)?.s, desc: gg(2)?.s },
        };
      }), null, 1)`
    )
  );

  // 顺带看看当前 SDK 解出来的礼物消息长什么样
  console.log("当前 SDK 解出的礼物消息：");
  console.log(
    await ev(
      `JSON.stringify(window.Livra.room.messages().filter(m => m.type === "gift").slice(-3), null, 1)`
    )
  );

  ws.close();
}

main().catch((error) => {
  console.error("失败:", error.message);
  process.exit(1);
});
