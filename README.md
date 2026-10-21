# Livra · DY 智能直播助手

Chrome 扩展（MV3）。在直播间页面里采集抖音的直播数据，侧边栏实时展示，并能代发弹幕。

```
抖音页面 ──MAIN world SDK──> bridge.js ──> 后台 ──> 侧边栏面板
```

## 四层职责

| 层 | 文件 | 职责 | 约束 |
|---|---|---|---|
| SDK | `src/sdk/` | 抖音协议解码、发送弹幕 | **不碰任何 `chrome.*`**，不知道自己跑在扩展里 |
| 桥接层 | `src/bridge.js` | SDK ↔ 扩展的数据管道、页面数据浮窗 | 唯一同时知道「SDK」和「扩展」的地方 |
| 后台 | `src/background.js` + `src/store.js` | 按标签页存数据、广播给面板 | 不碰抖音协议 |
| 面板 | `src/panel/` | 展示数据、发弹幕 | 不知道数据从哪来 |

SDK 在 **MAIN world**（`document_start` 注入），桥接层在**隔离世界**。两个世界的 `window` 不共享 JS 属性（只共享 DOM），所以跨层调用只能走 `window.postMessage`。

## 网页里的全局对象

插件往网页 `window` 上挂的对象**只有 `window.Livra` 一个**，其余全按模块往下拆。

```
window.Livra
├── installed   各模块装好了没（幂等）
├── protocol    跨世界消息标记（EVENT / CALL / RESULT / SYNC）
├── native      被 SDK 换掉的原生 API 原件（transport.js 填）
│
├── types       数据字典          ├── bus        事件总线
├── wire        protobuf 解码原语 ├── decoder    抖音消息解码
├── room        房间状态           ├── transport  WebSocket 拦截
├── sender      发弹幕             ├── send       对外入口的快捷发送
├── bridge      桥接层（仅隔离世界）
└── format      消息文案（仅面板页面）
```

⚠️ 隔离世界和 MAIN world **不共享** `window` 上的 JS 属性（只共享 DOM），所以两边各有一份 `window.Livra`，装的内容也不同：

| 世界 | 装了哪些模块 |
|---|---|
| MAIN world（SDK） | `types` `bus` `wire` `decoder` `room` `transport` `sender` `send` `native` |
| 隔离世界（桥接层） | `wire`（桥接层要用同一套 base64 编解码）+ `bridge` |
| 面板页面 | `types` `wire` `format` |

骨架和 `protocol` 由 `src/sdk/namespace.js` 统一建，两个世界都加载它 —— 协议标记只有一份定义，不存在改一边忘另一边。`namespace.js` 在加载顺序里必须排第一。

## 只解码，不解释

SDK 的解码层（`sdk/protocol/decoder.js`）把 protobuf 解成**完整的字段列表**挂在 `message.fields` 上，一个字段都不丢；除类型清单里声明的指标字段外，不读任何业务字段。

「这条消息该怎么显示」归展示层（`src/panel/format.js`）：礼物叫什么、送了几个、点赞几下，都是它按需从字段里取的。教训是以前解码层自己拼了一句「送出礼物」、只挑出一个 giftId —— 礼物名称和数量就这么丢了。

字段字节跨进程搬运：扩展消息通道走 JSON 序列化，`Uint8Array` 过不去（到对面会变成 `{0:10,1:39}` 这种普通对象，内存还翻十几倍）。所以桥接层出页面前把字节转成 base64（`bridge.js` 的 `pack`），展示层用 `wire.bytesOf` 两种装法都收。页面里保留的始终是完整的 `Uint8Array`。

## 数据怎么流

**采集**：`transport.js` 在页面建连前替换 `window.WebSocket`，收帧后交给 `decoder.js` 解码成统一消息格式，进 `room.js`。

**攒批**：`room.js` 每 300ms 把攒下的消息 emit 一次，避免高频刷屏。

**传输**：后台只把**本次新增**的几条发给面板（`{appended}`），首屏 / 页面同步 / 重置才发整包（`{replace, messages}`）。实测同样流量下传输量减少 91%~99%。

**渲染**：面板用虚拟滚动 —— 消息全在内存里，DOM 里只有视口那几十行加上下各 8 行缓冲。`#messageList` 撑出完整滚动高度，每行绝对定位 + `translateY(下标 × 行距)`，滚动只改 transform。收 3000 条和收 30 条的 DOM 成本一样（30 行 / 1ms）。

⚠️ 别用「上下两块占位 div」那种写法：每滚一行都要改视口**上方**那块的高度，浏览器的滚动锚定会补偿这个变化、反向改 `scrollTop`，一次手滚被放大成每帧一次的自激循环（表现：滚一下就一直滚到边界）。配套还要在滚动容器上关掉 `overflow-anchor`。

**浮窗**：页面右下角那个小仪表盘只在**真的开始采集**时才进 DOM —— 抖音域名下不只有直播间，首页、个人页那些地方挂一个永远灰着的圆点没有信息量还挡着页面按钮。连上过之后再断线会留着（黄点），那时它表达的是「掉了线」，比凭空消失有用。

**保留**：后台和页面 SDK 都不截断消息，标签关闭才释放（安全阀 30000 条）。面板关掉重开、甚至扩展重载后，历史都能拿回来。

## 发弹幕

签名（`a_bogus` 等）是页面安全 SDK 算的，插件复现不了，所以**借页面自己的发送函数**：

1. 从出站请求的调用栈里（或从 React fiber 兜底）定位到页面的 `onSend`
2. 用 `Function.prototype.apply` 探针空跑一次 `onSend()`，把输入框控制器 `I` 钓出来
3. 临时把 `I.getTextInfo` 换成返回目标文本 → 调 `onSend()` → 立刻还原

全程不碰输入框 DOM，输入框一个字没有也能发出去。判定成功不看返回值，而是看 hook 住的出站请求里有没有出现 `content` 等于目标文本的聊天请求。

## 开发调试

```bash
node test/open-browser.js            # 开测试浏览器（CDP 9351）、加载扩展、刷新页面让它接管
node test/bridge.js reload           # 改完 src/ 后：重载扩展 + 刷新直播间（service worker 必须重载才吃新代码）
node test/bridge.js status           # SDK 采集状态 + 浮窗 + 后台
node test/bridge.js panel [截图路径]  # 打开侧边栏、打印渲染结果、可选截图
node test/bridge.js probe            # 发送控制器定位状态
node test/bridge.js send <文本>       # 发一条弹幕

node test/diag-worlds.js             # 两个世界的全局对象、旧键残留
node test/diag-panel.js [JS]         # 面板报错抓取 + 可选在面板里执行 JS
node test/diag-flow.js               # 链路 + 跨世界调用往返（注入合成消息）
node test/diag-vlist.js              # 虚拟滚动：条数/DOM 行数/滚动/滚动稳定性/渲染耗时/勾选过滤
INJECT=3000 node test/diag-vlist.js  # 灌 3000 条再测
node test/perf-panel.js 30           # 传输量对照（增量 vs 整包）
```

⚠️ Chrome 155 起 `--load-extension` 失效，加载未打包扩展必须走 CDP 的 `Extensions.loadUnpacked`（浏览器需带 `--enable-unsafe-extension-debugging`）。
