#!/usr/bin/env node
/**
 * 面板诊断：抓面板页面的报错 + 回读关键状态
 *
 * 用法：node test/diag-panel.js
 */

const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const PANEL_URL_HINT = "panel/panel.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }

  static async connect() {
    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const client = new Cdp(ws);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("连不上调试端口"));
    });

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && client.pending.has(msg.id)) {
        const p = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        console.log("[异常]", msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        console.log("[console]", msg.params.args.map((a) => a.value ?? a.description).join(" "));
      } else if (msg.method === "Log.entryAdded") {
        console.log("[log]", msg.params.entry.text, msg.params.entry.url || "");
      }
    };

    return client;
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  async evalIn(targetId, expression) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || "出错" };
    return r.result.value;
  }

  targets() {
    return this.send("Target.getTargets").then((r) => r.targetInfos);
  }

  close() {
    this.ws.close();
  }
}

(async () => {
  const cdp = await Cdp.connect();
  const list = await cdp.targets();
  const panel = list.find((t) => t.type === "page" && t.url.includes(PANEL_URL_HINT));

  if (!panel) {
    console.log("面板没打开");
    cdp.close();
    return;
  }

  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: panel.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);

  console.log("面板 URL:", panel.url);

  // 重新加载一次，才能抓到启动时的报错
  await cdp.send("Page.reload", {}, sessionId);
  await sleep(3000);

  console.log("\n--- window.Livra ---");
  console.log(
    await cdp.evalIn(
      panel.targetId,
      `JSON.stringify({
        keys: Object.keys(window.Livra || {}),
        types: typeof window.Livra?.types,
        catalogLen: window.Livra?.types?.catalog ? window.Livra.types.catalog().length : null,
        wire: typeof window.Livra?.wire,
        format: typeof window.Livra?.format
      })`
    )
  );

  console.log("\n--- 直接问后台要状态 ---");
  console.log(
    await cdp.evalIn(
      panel.targetId,
      `(async () => Promise.race([
        chrome.runtime.sendMessage({type:"GET_PANEL_STATE"}).then(r => JSON.stringify({tab:r?.tab?.id, n:r?.live?.messages?.length})),
        new Promise(r => setTimeout(() => r("超时"), 3000))
      ]))()`
    )
  );

  console.log("\n--- DOM ---");
  console.log(
    await cdp.evalIn(
      panel.targetId,
      `JSON.stringify({
        badge: document.getElementById("badge").textContent,
        typeRows: document.querySelectorAll(".type-item").length,
        msgs: document.querySelectorAll("#messageList .msg").length,
        scripts: [...document.scripts].map(s => s.src.split("/").slice(-2).join("/"))
      })`
    )
  );

  // 可选：node test/diag-panel.js "<在面板里执行的 JS>"
  const expr = process.argv[2];
  if (expr) {
    console.log("\n--- 自定义表达式 ---");
    console.log(await cdp.evalIn(panel.targetId, expr));
  }

  await sleep(500);
  cdp.close();
})();
