#!/usr/bin/env node
/**
 * 直播数据侦察记录器
 *
 * 连上测试浏览器，给所有 page / worker target 开 Network 域，然后把
 *   - WebSocket 的建连 / 收帧 / 发帧
 *   - URL 里带 webcast / danmaku / chat / im 的 HTTP 请求与响应
 * 落成 JSONL，供后续分析弹幕协议用。
 *
 * 用法：node recorder.js   （建议 nohup 后台跑）
 * 输出：/tmp/livra-ws/frames.jsonl
 */
const fs = require("fs");
const path = require("path");

const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const OUT_DIR = process.env.OUT_DIR || "/tmp/livra-ws";
const FRAMES = path.join(OUT_DIR, "frames.jsonl");
const MAX_INLINE = 256 * 1024;

// 只记和直播数据相关的 HTTP，避免把整站资源都刷进来
const INTERESTING = /webcast|danmaku|chat|im\/|live\//i;

fs.mkdirSync(OUT_DIR, { recursive: true });

const out = fs.createWriteStream(FRAMES, { flags: "a" });
let seq = 0;

function log(entry) {
  out.write(`${JSON.stringify({ n: ++seq, t: Date.now(), ...entry })}\n`);
}

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const enabled = new Set();

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

  // 给一个会话开 Network（同一个会话只开一次）
  async function enableOn(sessionId, label) {
    if (!sessionId || enabled.has(sessionId)) return;
    enabled.add(sessionId);

    try {
      await send("Network.enable", {
        maxTotalBufferSize: 200 * 1024 * 1024,
        maxResourceBufferSize: 20 * 1024 * 1024,
        maxPostDataSize: 1024 * 1024
      }, sessionId);
      log({ kind: "network-enabled", sessionId, label });
    } catch (error) {
      log({ kind: "network-enable-failed", sessionId, label, error: error.message });
    }
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }

    const { method, params, sessionId } = msg;
    if (!method) return;

    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo || {};
      log({ kind: "target", sessionId: params.sessionId, type: info.type, url: info.url });

      if (/page|worker|iframe/i.test(info.type || "")) {
        enableOn(params.sessionId, info.url);
      }
      return;
    }

    if (method === "Network.webSocketCreated") {
      log({ kind: "ws-created", sessionId, requestId: params.requestId, url: params.url });
      return;
    }

    if (method === "Network.webSocketClosed") {
      log({ kind: "ws-closed", sessionId, requestId: params.requestId });
      return;
    }

    if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
      const frame = params.response || {};
      const data = frame.payloadData || "";

      log({
        kind: method.includes("Received") ? "ws-in" : "ws-out",
        sessionId,
        requestId: params.requestId,
        opcode: frame.opcode,
        len: data.length,
        truncated: data.length > MAX_INLINE,
        payload: data.slice(0, MAX_INLINE)
      });
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const url = params.request?.url || "";
      if (INTERESTING.test(url)) {
        log({
          kind: "http-req",
          sessionId,
          requestId: params.requestId,
          httpMethod: params.request.method,
          url,
          postData: (params.request.postData || "").slice(0, 8192)
        });
      }
      return;
    }

    if (method === "Network.responseReceived") {
      const response = params.response || {};
      if (INTERESTING.test(response.url || "")) {
        log({
          kind: "http-res",
          sessionId,
          requestId: params.requestId,
          status: response.status,
          mime: response.mimeType,
          url: response.url
        });
      }
    }
  };

  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  });

  // setAutoAttach 只对「之后新建」的 target 生效，已存在的要手动 attach
  const { targetInfos } = await send("Target.getTargets");
  for (const info of targetInfos) {
    if (info.type === "browser") continue;
    if (!/page|worker|iframe/i.test(info.type)) continue;

    try {
      const { sessionId } = await send("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true
      });
      await enableOn(sessionId, info.url);
    } catch (error) {
      log({ kind: "attach-failed", url: info.url, error: error.message });
    }
  }

  log({ kind: "recorder-start", cdpPort: CDP_PORT });
  console.error(`recorder 已启动 -> ${FRAMES}`);

  // 保持连接；CDP 断开就退出
  ws.onclose = () => {
    log({ kind: "recorder-stop" });
    process.exit(0);
  };
}

main().catch((error) => {
  console.error("recorder 失败:", error.message);
  process.exit(1);
});
