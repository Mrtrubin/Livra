# Livra — 项目笔记

Chrome MV3 扩展 **Livra**（简介：DY智能直播助手）：**按规则改写响应体**。命中规则的响应内容在到达页面前被替换。
文件：`manifest.json` / `background.js`（service worker，chrome.debugger）/ `sidepanel.html|css|js`（侧边栏「智能直播助手」）/ `content.js`（页面内悬浮按钮）/ `rewrite.js`（硬编码规则）。

## 定位（2026-10-14 大改）

原项目是「请求监听控制台」——side panel 形式的网络抓包面板（含请求列表、DevTools 风格详情弹窗、
时序瀑布、Cookie 等）。按需求**只保留规则改写**，其余功能连同 `panel.html` / `panel.js` / `panel.css` 全部删除。
面板相关的历史踩坑（DOM 约定、sidePanel 手势、详情渲染）见 `.workbuddy-ai/memory/2026-10-14.md`。

- 扩展名统一为 `Livra`，版本 2.2.0，权限 `debugger` + `tabs` + `sidePanel`。
- 规则**硬编码**在 `rewrite.js` 的 `REWRITE_RULES`，改规则 = 改代码 + 重新加载扩展。
- 开关入口有两个，走同一段代码（`toggleRewrite`）：
  1. **侧边栏「智能直播助手」**（主要）—— 点扩展图标打开
  2. **页面内悬浮按钮**（`content.js`）—— 只在 `content_scripts.matches` 命中的页面上出现
- **每个标签页一份独立会话**（`sessions: Map<tabId, session>`），可以同时开多个标签，互不影响。
  规则内容共享同一份，只有会话/开关/计数按标签隔离。

## 侧边栏（sidepanel.*）

- 侧边栏是**窗口级**的：一个窗口一个面板，内容**跟随该窗口的当前标签页**（`tabs.onActivated` /
  `onUpdated` / `windows.onFocusChanged` 都要 `refresh()`）。面板只是控制面，真状态在 `sessions`。
- 用 `setPanelBehavior({ openPanelOnActionClick: true })` 让 Chrome 自己处理图标点击。
  **这样 `action.onClicked` 就不再触发了**（Chrome 消费掉了这次点击），但换来的是完全绕开
  `sidePanel.open()` 的手势限制。窗口级面板正好符合现在的需求，所以比手动 `open({tabId})` 简单得多。
- 面板状态推送走 `chrome.runtime.sendMessage`（`PANEL_TAB_STATE`），**不能用 `tabs.sendMessage`**
  —— 后者只到 content script，到不了扩展页面。面板按 `msg.tabId === tabId` 过滤自己那一份，避免串标签。
- 面板里的规则列表来自 `rulesSummary()`（rewrite.js），**必须返回可结构化克隆的纯数据**
  （不能把预编译的 `findRe` RegExp 传过去）。
- 面板 DOM 三件套（html/js/css）必须对得上 —— 老项目就栽在这上面。改完记得核对一遍 id / class。
- 面板里所有内容用 `textContent` 拼，不走 `innerHTML`（规则内容是代码字符串）。

## 直播弹幕协议（抖音直播，已实测解开）

弹幕走 `wss://webcast*-ws-web-*.douyin.com/webcast/im/push/v2/`，**不能用普通 WebSocket 直接连**——URL 里带签名参数，必须由页面自己建立。

帧是 protobuf 的 **PushFrame**：

| 字段 | 含义 |
|---|---|
| #1 | seqId，**1 = 心跳**，2 = 有消息 |
| #5 | 重复的 header（#1=key, #2=value），含 `compress_type: gzip` |
| #6 | payloadType，消息帧是 `"pb"` |
| #7 | payloadEncoding，消息帧是 `"msg"`，心跳是 `"hb"` |
| #8 | payload —— gzip 压缩后的 Response |

gunzip 后是 **Response**，#1 是重复的 **Message**（#1=方法名字符串, #2=payload, #3=msgId）。

各消息 payload 的字段（实测）：
- `WebcastChatMessage`（弹幕）：#1=common, **#2=user（#1=userId, #3=nickname）**, **#3=正文**, #15=秒级时间戳
- `WebcastMemberMessage`（进场）：#2=user
- `WebcastRoomUserSeqMessage`（在线人数）：#7=人数
- `WebcastGiftMessage`：#2=user
- 其他：OnlineCamRecognition / RoomRank / RoomStats / ShortTouch / RanklistHourEntrance 等

**浏览器里的坑**：`Uint8Array` **没有** `toString("utf8")`（那是 Node Buffer 才有），在页面里调会得到 `"87,101,98,99..."` 这种逗号分隔的十进制串且**不报错**。必须用 `new TextDecoder().decode(bytes)`。
分析脚本里的 `decodeFields/readVarint` 是现成的最小 protobuf 解码器，可直接抄。

## MAIN world hook 的架构约束（踩过坑）

- `injected.js` 用 `content_scripts + world:"MAIN" + run_at:"document_start"` 注入，
  这样能在页面自己建 WebSocket **之前**把 `WebSocket` 换掉。用 `class extends` 或
  函数包装都可以，但要把 `prototype` 和静态常量对齐，否则页面的 `instanceof` 判断会挂。
- **`document_start` 的脚本比 `document_idle` 的 content script 早很多**（抖音直播页尤其慢）。
  这期间产生的 socket/messages 事件没有监听者，会全丢。所以 injected.js 要留 outbox +
  snapshot 补发接口，content script 启动后立刻 `window.postMessage({__livraSync:true})` 要一份快照。
  后台侧用 `LIVE_DATA` 的 `replace` 标记做覆盖而非追加，避免重复。
- **插件重启后已打开的页面不会自动重新注入 content script**（Chrome 只在页面加载时注一次）。
  页面里的 hook 还活着（挂在 window 上、WebSocket 还是 patch 过的那个），但没人转数据给后台了。
  解法：SW 启动时主动 `chrome.scripting.executeScript` 补注入（需要 `scripting` 权限 + `host_permissions`），
  content.js 自身做幂等（摘掉旧 window message 监听、拆掉重建悬浮按钮）。
- content script 反复注入时，旧实例的 window message 监听还在（扩展上下文已失效），
  必须 `removeEventListener` 摘掉，否则每条弹幕会被转发两遍。

### ⚠️ 隔离世界只共享 DOM，**不共享 window 上的属性**

`window.__livraLive = {...}` 挂在 main world 上，**在 content script 里访问是 `undefined`**
（两个世界的 `window` 不是同一个对象，只有 DOM 树是共享的）。
所以任何「页面拿数据 → 扩展」或「扩展控制页面」的路径**都必须走 `window.postMessage`**，
不能直接读 main world 的对象。这是「点发送没反应也不报错」这种假死的经典成因。
（顺带：同理，在 main world patch `window.postMessage` 也拦不到 content script 的调用。）

### 发弹幕（写）的正确做法

- 页面输入框是 `div[contenteditable="true"]`（class 含 `editor-kit-container`，在
  `webcast-chatroom___input-container` 里），**回车发送**，页面上没有发送按钮。
- 真实请求长这样：
  `GET live.douyin.com/webcast/room/chat/?...&room_id=xxx&content=<urlencoded>&msToken=...&a_bogus=...`
  **带 a_bogus 签名，自造请求必被拒**。唯一可行的路线是驱动页面自己的输入框，让页面去签。
- 流程：`execCommand("insertText", false, text)` 插入 → **等 ~180ms** → 在编辑器上
  dispatch `keydown{key:"Enter", keyCode:13, bubbles:true}`。
- 四个坑：
  1. `execCommand("insertText")` 才能让框架感知到输入；直接改 `textContent` 框架不知道。
  2. 插入和 Enter 放同一个同步块里会被忽略（编辑器还没把输入落下来），必须隔一会儿。
  3. **`document.hasFocus()` 为 false 时 Enter 被完全忽略** —— 浏览器窗口不在前台就发不出去。
     表现是「字塞进去了但什么都没发生」。发送前先把标签页拉到前台。
  4. 发送成功后输入框会被清空 —— 可以用这个当成功判据（比监听请求更可靠）。
- 发送失败时**必须撤回插入的文本**（selectAll + delete），否则残留文本会一直留着，
  下次发送被一起发出去（实测串过两次文本）。

### 多个 content script 实例

同一个页面可能同时有多个 content script 实例（manifest 注入的 + 插件重启后 SW 补注入的）。
`chrome.tabs.sendMessage` 会**发给所有实例**，一条消息被处理两遍（弹幕被插入输入框两次）。
用挂在 window 上的世代计数只让最新实例响应：

```js
window.__livraCsGen = (Number(window.__livraCsGen) || 0) + 1;
const myGen = window.__livraCsGen;
const isCurrentInstance = () => window.__livraCsGen === myGen;
```
（世代数在隔离世界之间是可见的，在 main world 里读不到。）

### 调试桥

`test/bridge.js`（`node test/bridge.js help`）把重载/发弹幕/看状态/开侧边栏/发真实按键收成命令：
`status` / `reload <ext|page|both>` / `tabs` / `hook` / `ws` / `send <内容>` / `click-send <内容>`
（点侧边栏真实按钮）/ `panel [截图]` / `rules` / `rewrite on|off` / `focus` / `key <Enter>`
（CDP 发 isTrusted=true 的真按键）/ `main <JS>` / `sw <JS>`。

- **`Extensions.loadUnpacked` 不会重读已加载扩展的代码**（表现：「明明改了代码行为没变」）。
  改 `injected.js` / `content.js` / `sidepanel.js` 后必须**刷页面**（`reload page`）。
  页面上已注入的 hook 实例还活着、继续用旧代码，这是我们特意做的持久化行为。
- 不要在 SW 里调 `chrome.runtime.reload()` 重启扩展（会把 CDP 加载的扩展直接搞没）。

## 踩坑：Chrome 匹配模式不写端口，端口在匹配时被忽略

`matchPatternToRegExp()` 把 `content_scripts.matches` 转成正则来判断「当前页面会不会出现悬浮按钮」。
第一版忘了端口，生成的 `^https?://127\.0\.0\.1/.*$` **匹配不上** `http://127.0.0.1:8820/`，
面板就一直显示「当前页面不在注入范围」——而实际上 content script 注入得好好的。
必须补一个可选的 `(?::\d+)?`。这个 bug 断言没抓到，是**截图肉眼看出来的**。
教训：UI 类改动光看 PASS 不够，得把界面截出来看一眼。

## 按标签隔离的架构（重要）

- `sessions` 的 key 是 `tabId`，`debugger.onEvent` 里先查 `sessions.get(tabId)?.attached` 再处理 → 天然隔离。
- `startRewrite` **不再**去 detach 其它标签页（旧版是「同时只允许一个」）。代价：每个开着的标签都会弹一条
  「已开始调试此浏览器」（Chrome 内置，去不掉）。这是用户明确接受的取舍。
- content script 天然每标签一份，所以页面按钮本身就是按标签的；`sender.tab.id` 就是「当前标签页」，
  后台靠它锁定会话，不依赖任何全局「当前标签」概念。
- 页面按钮的界面放在 **shadow DOM** 里（`all:initial` 切断宿主样式继承），避免被直播页的样式污染。
- 按钮位置存在 `sessionStorage`（天然按标签隔离、同标签刷新还在），key `__livra_pos__`。

## 性能相关（2026-10-14 优化）

- **UI 更新防抖 250ms**：一次页面加载可能瞬间命中好几条响应，角标 + `tabs.sendMessage` + 按钮重绘
  合并成一次（`scheduleUi` / `flushUi`）。旧版是每条改写都立刻发一次 IPC。
- **`REWRITE_OPTIONS`（rewrite.js）** 暴露两个影响性能的开关：
  - `disableCache`（默认 true）：关缓存是正确性必需（见下），但会让该标签页每次加载都真走网络。
  - `includeChildFrames`（默认 true）：关掉能省掉 `Target.setAutoAttach` 和每个子会话的 Fetch 域。
- `content_scripts.matches` **只列目标域名**（douyin.com + 本地调试），不是 `<all_urls>`，
  避免在无关页面上白注入一个按钮。改目标站点就改这里。
- `handleRequestPaused` 里对 204 / 304 提前放行，省一次 `Fetch.getResponseBody` 往返。

## 规则结构（rewrite.js）

- `fetchPattern`：CDP 的 URL 通配符，决定「哪些请求会被拦下来」，`buildFetchPatterns()` 据此生成
  `Fetch.enable` 的 `patterns`（自动去重）。**这是性能关键**——不匹配的请求压根不会被暂停。
- `urlPattern`：规则层正则二次过滤（可为 null）。别拿它当主要过滤手段，被拦下来的请求仍要走一次往返。
- `find` / `replacement`：按字面量处理，`find` 会自动 `escapeRegExp()`。

## 改写响应体（CDP Fetch 域）

- MV3 里唯一能改 body 的路：`Fetch.enable({patterns:[{urlPattern, requestStage:'Response'}]})`
  → `Fetch.requestPaused` → `Fetch.getResponseBody` → 正则替换 → `Fetch.fulfillRequest`。
- **`Fetch.getResponseBody` 返回的 body 已经是解压后的**，回填必须删 `content-encoding` 并重算
  `content-length`，否则浏览器按 gzip 解压明文会炸。
- **`base64Encoded` 对纯文本 JSON 也常常是 true**，不能拿它当"二进制"判据；
  要按 `content-type` 判断是否文本。`fulfillRequest` 的 body 必须是 base64。
- **每条 `requestPaused` 都必须回应**，漏一条页面就永久卡住。
  **绝对不能在 `Fetch.requestPaused` 的 `if` 条件里按 URL 过滤** —— 那等于把不匹配的请求丢弃，
  没人 continue 就永久挂起。过滤要放 `Fetch.enable` 的 `patterns` 或规则内部（应答后再放行）。
- **`Fetch` 域拦不到「由 HTTP 缓存直接满足」的响应** —— 命中缓存时 `requestPaused` 根本不触发。
  开改写必须同时 `Network.setCacheDisabled({cacheDisabled:true})`，否则带
  `cache-control: immutable` 的站点（绝大多数 CDN）第二次访问就一条都改不到。
- **跨站 iframe / Worker 要单独开**：`Target.setAutoAttach({flatten:true,...})` 后在
  `Target.attachedToTarget` 里给子会话各开一次 `Fetch.enable` + 关缓存。
- 排查这类问题要用**纯 CDP 不带扩展**做隔离，比在扩展里加桩更快定位到是 Chrome 行为还是接线问题。
- 带 `/g` 的正则 `test()` 有 `lastIndex` 状态，连续调用会漏匹配。
- 查找串当正则用之前必须 `escapeRegExp()`（`( ) { } [ ] . * + ? ^ $ | \` 都要转义）。
  另外**字符串字面量里的 `\.` 会丢反斜杠**，含反斜杠的查找串一律用 `String.raw`。
- 替换用 `out.replace(re, () => rule.replacement)`（函数形式），
  否则 replacement 里的 `$&` `$1` 会被当特殊记号。

## 接线约定

- `importScripts("rewrite.js")` **必须是 background.js 的第一条语句**；两边共用全局作用域，
  所以 rewrite.js 里可以直接调 background.js 的 `sendCommand()`。
- 规则里的 URL 过滤和 `Fetch.enable` 的 patterns 要对得上，否则规则永远不命中（容易被当成改写失效）。

## 有头测试浏览器（要人工登录时用）

headless 没法扫码登录，需要人工介入时开一个有头 Chrome：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/livra-test-profile" \
  --remote-debugging-port=9351 --remote-allow-origins='*' \
  --enable-unsafe-extension-debugging --silent-debugger-extension-api \
  --no-first-run --no-default-browser-check --no-sandbox \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  "https://live.douyin.com/"
```

- **必须用 `run_in_background: true` 启动**。用 `nohup ... &` + `disown` 不行 ——
  Bash 工具的命令一返回，整个进程组就被回收，Chrome 直接没了（表现为 curl 端口拒绝）。
  后台任务则跨轮次存活。
- 工具沙箱会挡住 Chrome 自己的 sandbox 初始化（`sandbox initialization failed: Operation not permitted`
  → GPU 进程 exit_code=6 → FATAL），所以**必须加 `--no-sandbox`**（有头无头都一样）。
- 不能用默认 profile：Chrome 136+ 禁止默认 user-data-dir 配 `--remote-debugging-port`。
  用独立 profile，代价是要重新登录一次。
- `--silent-debugger-extension-api` 能去掉每条标签页那条「已开始调试此浏览器」提示。
- 扩展仍走 CDP `Extensions.loadUnpacked`（`test/load-extension.js`），Chrome 155 起 `--load-extension` 已失效。
- 侦察用 `test/recorder.js`：给所有 page/worker target 开 Network 域，把 WebSocket 收/发帧和
  带 webcast/danmaku/chat/im 的 HTTP 落成 JSONL（默认 `/tmp/livra-ws/frames.jsonl`）。同样要后台跑。

## 本地验证方法（无需手动开浏览器）

headless Chrome + CDP 可以端到端跑通整个扩展：

- Chrome 155 起 `--load-extension` 已失效，改用 CDP 的 `Extensions.loadUnpacked`，浏览器需以 `--enable-unsafe-extension-debugging` 启动。
- 在受限沙箱里启动 Chrome 必须加 `--no-sandbox`，否则 `sandbox initialization failed` → GPU 进程崩溃退出。
- **没有面板之后，测试改成直接驱动扩展**：`Target.getTargets` 找到 `type:"service_worker"`
  且 url 含扩展 id 的 target → attach → `Runtime.evaluate`。`background.js` 是 classic script，
  顶层函数挂在全局，可以直接调 `startRewrite(tabId)`、读 `sessions`。
- **点页面里的悬浮按钮也能从测试里驱动**：shadow root 是 `open` 模式，页面世界可以用
  `document.getElementById("livra-floating-button").shadowRoot.querySelector("button").click()`。
  DOM 事件在页面世界和 content script 的隔离世界之间是共享的，所以真的能触发按钮逻辑。
- **侧边栏面板怎么测**：面板是窗口级的，直接当普通标签页打开会让它把「自己」当成当前标签页。
  正确做法是用扩展的 `chrome.windows.create()` 开一个新窗口（被测页面），再用
  `chrome.tabs.create({windowId, url: getURL("sidepanel.html"), active:false})` 在同一窗口建面板标签，
  最后 `chrome.tabs.update(probeTabId, {active:true})` 把被测页面激活 → 面板就会显示它。
  面板脚本是 classic script，`refresh()` / `renderRules()` 都挂在全局，可以直接 `Runtime.evaluate` 调。
- `test/rewrite-extension.js`（扩展内，19 项全过；含双标签隔离/并发、页面悬浮按钮、侧边栏面板）、
  `test/rewrite-response.js`（纯 CDP，不依赖扩展，4 项全过）。
- **截图要看**：`os.tmpdir()` 在 macOS 上是 `/var/folders/...` 不是 `/tmp`。
