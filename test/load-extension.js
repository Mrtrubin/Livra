#!/usr/bin/env node
/**
 * 连接测试浏览器，把 Livra 扩展加载进去，并列出当前所有 target。
 *
 * Chrome 155 起 --load-extension 已失效，必须走 CDP 的 Extensions.loadUnpacked
 * （浏览器需以 --enable-unsafe-extension-debugging 启动）。
 *
 * 日常调试直接用 test/open-browser.js，它一条命令就把浏览器和扩展都开好了。
 */
const path = require("path");

const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const EXT = process.env.EXT || path.resolve(__dirname, "..");

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      const payload = { id: mid, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
  });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  };

  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  console.log(`扩展已加载: ${extId}`);

  const { targetInfos } = await send("Target.getTargets");
  console.log(`\n当前 target（${targetInfos.length} 个）:`);
  for (const t of targetInfos) {
    console.log(`  ${String(t.type).padEnd(16)} ${String(t.url).slice(0, 100)}`);
  }

  ws.close();
}

main().catch((error) => {
  console.error("setup 失败:", error.message);
  process.exit(1);
});
