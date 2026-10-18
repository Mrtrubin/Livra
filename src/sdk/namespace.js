/**
 * SDK · 全局命名空间
 *
 * 插件往网页 window 上挂的**唯一**对象就是 window.Livra，其余一律按模块往下拆：
 *
 *   Livra.installed    各模块装好了没（幂等，重复注入不会叠加副作用）
 *   Livra.protocol     跨世界消息标记
 *   Livra.native       被 SDK 换掉的原生 API 原件（transport.js 填）
 *
 *   Livra.types        SDK · 数据字典
 *   Livra.bus          SDK · 事件总线
 *   Livra.wire         SDK · protobuf 解码原语
 *   Livra.decoder      SDK · 抖音消息解码
 *   Livra.room         SDK · 房间状态
 *   Livra.transport    SDK · WebSocket 拦截
 *   Livra.sender       SDK · 发弹幕
 *   Livra.send         SDK · 对外入口的快捷发送
 *   Livra.bridge       桥接层（隔离世界）
 *   Livra.format       面板 · 消息文案（只在面板页面里）
 *
 * ⚠️ 隔离世界和 MAIN world **不共享** window 上的 JS 属性（只共享 DOM），所以两边
 * 各自有一份 window.Livra，内容也不同：MAIN world 那份是 SDK，隔离世界那份只有
 * wire 和 bridge。本文件两个世界都加载，protocol 也只在这里定义一次 —— 以前它
 * 在 bus.js 和 bridge.js 里各写了一份，改一边忘另一边就直接断链。
 *
 * 加载顺序：本文件必须排第一（manifest 的 content_scripts、面板的 <script>、
 * 以及 background.js 补注入时的 files 都是）。
 */

(() => {
  const NS = (window.Livra = window.Livra || {});

  NS.installed = NS.installed || {};

  /**
   * 跨世界消息标记。SDK 在 MAIN world、桥接层在隔离世界，两边不共享 window，
   * 只能靠 postMessage 传结构化数据 —— 所以这些标记必须写在消息体里。
   */
  NS.protocol = NS.protocol || {
    EVENT: "__livra",        // SDK -> 宿主：事件推送
    CALL: "__livraCall",     // 宿主 -> SDK：调用方法
    RESULT: "__livraResult", // SDK -> 宿主：调用结果
    SYNC: "__livraSync",     // 宿主 -> SDK：要一份全量快照
  };
})();
