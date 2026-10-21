#!/usr/bin/env node
/**
 * 打开一个**看得见**的测试浏览器，把 Livra 加载进去。
 *
 * 和 test/rewrite-extension.js（headless、跑完就关）互补：这个脚本开的浏览器会
 * 一直留在屏幕上，方便肉眼点、手动验证。关掉窗口进程就结束。
 *
 * 用法：
 *   node test/open-browser.js                默认打开 https://live.douyin.com/
 *   node test/open-browser.js <任意 URL>
 *
 * 环境变量：
 *   CHROME     浏览器可执行文件路径（默认自动探测 Win / Mac / Linux）
 *   CDP_PORT   调试端口，默认 9351（和 bridge.js 一致）
 *   PROFILE    profile 目录，默认 ~/livra-test-profile（保留登录状态）
 *
 * 开好之后就可以用调试桥操作了：
 *   node test/bridge.js status
 *   node test/bridge.js panel
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const EXT = path.resolve(__dirname, "..");
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const PROFILE = process.env.PROFILE || path.join(os.homedir(), "livra-test-profile");
const DEFAULT_URL = "https://live.douyin.com/";
const START_URL = (process.argv[2] || process.env.URL || DEFAULT_URL).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按平台找一个能用的 Chromium 内核浏览器 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error("没找到 Chrome/Edge，用环境变量 CHROME 指一下路径");

  console.log(`浏览器  : ${chrome}`);
  console.log(`profile : ${PROFILE}`);
  console.log(`扩展    : ${EXT}`);
  console.log(`调试端口: ${CDP_PORT}\n`);

  // 关键是让浏览器**不属于当前进程树**：直接 spawn 的话，脚本一退出（或者外层
  // shell 回收子进程）它就被带走了。Windows 上借 cmd start 拉一把，Mac/Linux 用
  // detached + unref 即可。
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--remote-allow-origins=*",
    // Chrome 155 起 --load-extension 失效，卸载扩展必须走 CDP 的 Extensions.loadUnpacked，
    // 而它只在开了这个开关时才可用
    "--enable-unsafe-extension-debugging",
    // 别让页面顶部挂一条「正在被自动化调试」的提示条干扰观察
    "--silent-debugger-extension-api",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    START_URL,
  ];

  const proc =
    process.platform === "win32"
      ? // start 的第一个带引号参数是「窗口标题」，所以这里必须先塞一个空字符串
        spawn("cmd.exe", ["/c", "start", '""', chrome, ...args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn(chrome, args, { detached: true, stdio: "ignore" });

  proc.unref();

  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(300);
    }
  }
  if (!version) throw new Error("调试端口没起来，浏览器是不是启动失败了");

  console.log(`已就绪  : ${version.Browser}`);

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP WebSocket 连不上"));
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== 1) return;
        ws.removeEventListener("message", onMessage);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id: 1, method, params }));
    });

  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT });
  console.log(`扩展已加载: ${extId}`);

  await sleep(2000);

  const { targetInfos } = await send("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
  // 已打开的那个标签页此刻还没有 content script，补一次让它立刻接管
  const page = targetInfos.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));

  console.log(`service worker: ${sw ? "已启动" : "还没起来（多等几秒再看）"}`);

  // 扩展是在页面打开**之后**才加载的，content script 不会自己补进已经加载完的页面。
  // 刷一遍让新加载的扩展立刻接管，省得每次开完还要手动 reload。
  //
  // 用页面内 location.reload() 而不是 CDP 的 Page.reload：后者在这个 session 上会报
  // "Page.reload wasn't found"（Page 域没 enable 时不可靠），而 Runtime 域反正要开。
  if (page) {
    const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId).catch(() => {});

    // 页面一导航这次 evaluate 就不会有回应了，所以不 await，等一会儿就好
    send("Runtime.evaluate", { expression: "location.reload()" }, sessionId).catch(() => {});
    await sleep(4000);
  }

  console.log(`当前标签页    : ${page ? "已刷新（让扩展接管）" : "无"}`);

  ws.close();

  console.log(`\n浏览器已打开，可以手动点了。`);
  console.log(`接下来可以用调试桥操作（同一个端口 ${CDP_PORT}）：`);
  console.log(`  node test/bridge.js status`);
  console.log(`  node test/bridge.js panel`);
  console.log(`改了代码要重载：关掉窗口重跑本脚本（content script 只能靠刷新页面才生效）。`);
  console.log(`\n这个脚本会一直挂着维持浏览器存活，Ctrl+C 或关掉窗口即退出。`);

  // 之所以要挂住不退出：浏览器是本进程（或其子进程）拉起来的，脚本一退出它就
  // 跟着被回收。这里每 2 秒探一次调试端口，浏览器关了就自动收尾。
  for (;;) {
    await sleep(2000);
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch {
      console.log("浏览器已关闭");
      break;
    }
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(`失败: ${error.message}`);
  process.exit(1);
});
