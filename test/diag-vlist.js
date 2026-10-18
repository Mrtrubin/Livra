#!/usr/bin/env node
/**
 * 虚拟滚动 + 全量保留 的验证脚本。
 *
 * 用法：
 *   node test/diag-vlist.js              只检查当前状态
 *   INJECT=3000 node test/diag-vlist.js  先灌 3000 条再检查
 *
 * 看四件事：
 *   1. 数据条数：面板里到底存了多少条（应该等于灌进去的量，不再被截到 300）
 *   2. DOM 节点：不管存了多少条，DOM 里只有视口 + 缓冲那几十行
 *   3. 滚动：滚到顶能看到最早一条，滚到底能看到最新一条
 *   4. 定位：容器高度 = 条数 × 行距，首行偏移 = 首条下标 × 行距
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const INJECT = Number(process.env.INJECT || 0);

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

  const sessions = new Map();
  const ev = async (targetId, expression) => {
    if (!sessions.has(targetId)) {
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      sessions.set(targetId, sessionId);
    }
    const r = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessions.get(targetId)
    );
    return r.exceptionDetails
      ? "EXC: " + (r.exceptionDetails.exception?.description || "")
      : r.result?.value;
  };

  const find = async (kw) => {
    const { targetInfos } = await send("Target.getTargets");
    return targetInfos.find((t) => t.type === "page" && (t.url || "").includes(kw));
  };

  const live = await find("live.douyin.com");
  const panel = await find("panel.html");
  if (!live || !panel) throw new Error("需要直播间页面和面板页面都开着");

  /* ---------- 灌数据 ---------- */

  if (INJECT > 0) {
    await ev(live.targetId, "window.Livra.room.clear()");
    await sleep(600);

    const BATCH = 100;
    const ROUNDS = Math.ceil(INJECT / BATCH);

    for (let i = 0; i < ROUNDS; i++) {
      await ev(
        live.targetId,
        `(() => {
          const now = Date.now();
          const batch = [];
          for (let k = 0; k < ${BATCH}; k++) {
            const n = ${i} * ${BATCH} + k;
            batch.push({
              id: "vl-" + n, method: "WebcastChatMessage", type: "danmaku",
              content: "第 " + n + " 条消息", value: null,
              user: { id: "u" + n, nickname: "用户" + n }, extra: {}, ts: now + k
            });
          }
          window.Livra.room.ingest(batch);
          return batch.length;
        })()`
      );
      await sleep(80);
    }

    console.log(`已注入 ${ROUNDS * BATCH} 条`);
    await sleep(2000);
  }

  /* ---------- 状态 ---------- */

  const snapshot = `(() => {
    const pane = document.getElementById("pane-stream");
    const rows = document.querySelectorAll("#messageList .msg");
    const list = document.getElementById("messageList");
    return JSON.stringify({
      stored: Number(document.getElementById("streamCount").textContent.replace(/[^0-9]/g, "")) || 0,
      domRows: rows.length,
      listHeight: Math.round(list.getBoundingClientRect().height),
      firstOffset: rows.length
        ? Math.round(rows[0].getBoundingClientRect().top - list.getBoundingClientRect().top)
        : 0,
      scrollTop: Math.round(pane.scrollTop),
      scrollHeight: Math.round(pane.scrollHeight),
      clientHeight: pane.clientHeight,
      firstRow: rows.length ? rows[0].textContent : "(空)",
      lastRow: rows.length ? rows[rows.length - 1].textContent : "(空)"
    });
  })()`;

  const show = (title, raw) => {
    const s = JSON.parse(raw);
    console.log(`\n[${title}]`);
    console.log(`  存储条数    ${s.stored}`);
    console.log(`  DOM 行数    ${s.domRows}   容器高 ${s.listHeight}px，首行偏移 ${s.firstOffset}px`);
    console.log(`  滚动        top ${s.scrollTop} / ${s.scrollHeight}（视口 ${s.clientHeight}）`);
    console.log(`  首行        ${s.firstRow}`);
    console.log(`  末行        ${s.lastRow}`);
  };

  show("当前（默认贴底）", await ev(panel.targetId, snapshot));

  /* ---------- 滚到顶 ---------- */

  await ev(panel.targetId, `(() => {
    const pane = document.getElementById("pane-stream");
    pane.scrollTop = 0;
    pane.dispatchEvent(new Event("scroll"));
    window.renderWindow && window.renderWindow(true);
    return "top";
  })()`);
  await sleep(400);
  show("滚到最顶", await ev(panel.targetId, snapshot));

  /* ---------- 滚到中间 ---------- */

  await ev(panel.targetId, `(() => {
    const pane = document.getElementById("pane-stream");
    pane.scrollTop = Math.round(pane.scrollHeight / 2);
    pane.dispatchEvent(new Event("scroll"));
    window.renderWindow && window.renderWindow(true);
    return "mid";
  })()`);
  await sleep(400);
  show("滚到中间", await ev(panel.targetId, snapshot));

  /* ---------- 滚到底 ---------- */

  await ev(panel.targetId, `(() => {
    const pane = document.getElementById("pane-stream");
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new Event("scroll"));
    window.renderWindow && window.renderWindow(true);
    return "bottom";
  })()`);
  await sleep(400);
  show("滚到最底", await ev(panel.targetId, snapshot));

  /* ---------- 渲染细节 ---------- */

  console.log("\n[渲染细节]");

  console.log(
    "  单行高度    ",
    await ev(
      panel.targetId,
      `(() => {
        const row = document.querySelector("#messageList .msg");
        return row ? row.getBoundingClientRect().height + "px" : "(没有行)";
      })()`
    )
  );

  console.log(
    "  超长文本    ",
    await ev(
      panel.targetId,
      `(() => {
        const text = document.querySelector("#messageList .msg .text");
        if (!text) return "(没有行)";
        return text.scrollWidth > text.clientWidth
          ? "已省略（" + text.scrollWidth + "px 挤进 " + text.clientWidth + "px）"
          : "未超出";
      })()`
    )
  );

  // 连续渲染 30 次看单次耗时 —— 这是滚动时每帧要干的活
  console.log(
    "  渲染耗时    ",
    await ev(
      panel.targetId,
      `(() => {
        if (typeof window.renderWindow !== "function") return "(renderWindow 不可访问)";
        const t0 = performance.now();
        for (let i = 0; i < 30; i++) window.renderWindow(true);
        return ((performance.now() - t0) / 30).toFixed(2) + " ms/次";
      })()`
    )
  );

  /**
   * 注：面板「可见」时走 requestAnimationFrame 批处理，本脚本测不到 ——
   * 测试环境里面板是个标签页，把它拉到前台它就按设计改成读自己了（真实侧边栏
   * 不是标签页，不会这样）。两条分支调的是同一个 renderWindow()，差别只在延不延迟一帧。
   */

  // 勾掉「弹幕」再勾回来，验证过滤后重算
  const before = await ev(panel.targetId, "document.getElementById('streamCount').textContent");
  await ev(
    panel.targetId,
    `(() => {
      const box = document.querySelector('#typeList [data-id="danmaku"] input');
      if (!box) return "no-box";
      box.checked = false;
      box.dispatchEvent(new Event("change"));
      return "off";
    })()`
  );
  await sleep(300);
  const afterOff = await ev(panel.targetId, "document.getElementById('streamCount').textContent");
  await ev(
    panel.targetId,
    `(() => {
      const box = document.querySelector('#typeList [data-id="danmaku"] input');
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      return "on";
    })()`
  );
  await sleep(300);
  const afterOn = await ev(panel.targetId, "document.getElementById('streamCount').textContent");
  console.log(`  勾选过滤    全部 ${before} → 关掉弹幕 ${afterOff} → 勾回 ${afterOn}`);

  ws.close();
}

main().catch((error) => {
  console.error("失败:", error.message);
  process.exit(1);
});
