/**
 * SDK · 数据类型清单
 *
 * 这是整个 SDK 的「数据字典」，也是侧边栏「自选展示哪些数据」的唯一数据源：
 * 界面上能勾的每一项、渲染时用什么颜色、属于列表消息还是顶部指标，全都由这里决定。
 * 新增一种数据类型 = 在这里加一条 + 在 decoder.js 里加对应的解析分支。
 *
 * 零依赖、不碰 DOM、不装 hook，所以三种环境都能直接加载：
 *   - 页面 MAIN world（作为 content script 的一部分）
 *   - service worker（background.js importScripts）
 *   - 单测里 import 出来做数据驱动校验
 */

(() => {

  /** kind 决定了这类数据最终出现在界面的什么位置 */
  const KIND = {
    // 事件流：一条一条往下滚的消息
    STREAM: "stream",
    // 指标：一个会变化的数字，显示在顶部
    METRIC: "metric",
  };

  /**
   * 逐项说明：
   *
   *   id       界面勾选项的 key，存进 storage 的就是它
   *   label    勾选项的中文名
   *   desc     鼠标悬停时的说明
   *   kind     stream = 进消息流；metric = 进顶部指标
   *   method   抖音 protobuf 的 method 名。null 表示兜底类型（所有没认出来的都归它）
   *   color    渲染用的色号，对应 panel.css 里的 .c-<color>
   *   defaultOn 新用户第一次打开时是否默认勾选
   */
  const DATA_TYPES = [
    {
      id: "danmaku",
      label: "弹幕",
      short: "弹幕",
      desc: "观众发的聊天消息",
      kind: KIND.STREAM,
      method: "WebcastChatMessage",
      color: "blue",
      defaultOn: true,
    },
    {
      id: "gift",
      label: "礼物",
      short: "礼物",
      desc: "观众送出的礼物",
      kind: KIND.STREAM,
      method: "WebcastGiftMessage",
      color: "amber",
      defaultOn: true,
    },
    {
      id: "enter",
      label: "进场",
      short: "进场",
      desc: "观众进入直播间",
      kind: KIND.STREAM,
      method: "WebcastMemberMessage",
      color: "gray",
      defaultOn: true,
    },
    {
      id: "like",
      label: "点赞",
      short: "点赞",
      desc: "观众点赞",
      kind: KIND.STREAM,
      method: "WebcastLikeMessage",
      color: "pink",
      defaultOn: true,
    },
    {
      id: "social",
      label: "关注",
      short: "关注",
      desc: "观众关注主播",
      kind: KIND.STREAM,
      method: "WebcastSocialMessage",
      color: "teal",
      defaultOn: true,
    },
    {
      id: "stats",
      label: "房间统计",
      short: "统计",
      desc: "抖音推送的房间统计快照（内容是一个裸数值，语义不明，默认关闭防刷屏）",
      kind: KIND.STREAM,
      method: "WebcastRoomStatsMessage",
      color: "purple",
      defaultOn: false,
    },
    {
      id: "fansclub",
      label: "粉丝团",
      short: "粉丝",
      desc: "粉丝团相关事件",
      kind: KIND.STREAM,
      method: "WebcastFansclubMessage",
      color: "coral",
      defaultOn: false,
    },
    {
      id: "control",
      label: "直播控制",
      short: "控制",
      desc: "暂停 / 结束等直播间控制指令",
      kind: KIND.STREAM,
      method: "WebcastControlMessage",
      color: "red",
      defaultOn: false,
    },
    {
      id: "room",
      label: "房间变更",
      short: "房间",
      desc: "标题、封面等房间信息变更",
      kind: KIND.STREAM,
      method: "WebcastRoomMessage",
      color: "purple",
      defaultOn: false,
    },
    {
      id: "product",
      label: "商品",
      short: "商品",
      desc: "讲解中的商品变化",
      kind: KIND.STREAM,
      method: "WebcastProductChangeMessage",
      color: "amber",
      defaultOn: false,
    },
    {
      id: "rank",
      label: "榜单",
      short: "榜单",
      desc: "贡献榜、人气榜变化",
      kind: KIND.STREAM,
      method: "WebcastRankTextMessage",
      color: "amber",
      defaultOn: false,
    },
    {
      id: "delete",
      label: "撤回",
      short: "撤回",
      desc: "被撤回的消息",
      kind: KIND.STREAM,
      method: "WebcastImDeleteMessage",
      color: "gray",
      defaultOn: false,
    },
    {
      // 实测发现这个消息量很大（画面内容识别），不单列的话会被塞进「其他消息」里刷屏
      id: "camrecognition",
      label: "画面识别",
      short: "识别",
      desc: "抖音对直播画面做的内容识别，属平台内部用途",
      kind: KIND.STREAM,
      method: "WebcastGroupLiveOnCamRecognitionMessage",
      color: "gray",
      defaultOn: false,
    },

    /* ---------- 指标类：不构成消息列表，只是一个会变的数字 ---------- */

    {
      id: "online",
      label: "在线人数",
      short: "在线",
      desc: "当前直播间在线人数",
      kind: KIND.METRIC,
      method: "WebcastRoomUserSeqMessage",
      unit: "人",
      // 指标类要说明「数值在第几个字段」，解码层照这个取，别的字段一概不碰
      field: 7,
      defaultOn: true,
    },

    /* ---------- 兜底：认不出来的都归这里，至少让用户看到「抖音还推了什么」 ---------- */

    {
      id: "other",
      label: "其他消息",
      short: "其他",
      desc: "SDK 还没专门解析的消息，会显示原始 method 名",
      kind: KIND.STREAM,
      method: null,
      color: "gray",
      defaultOn: false,
    },
  ];

  // method -> 类型定义。查不到就落到 other，保证任何一条消息都有归属
  const BY_METHOD = new Map();
  for (const type of DATA_TYPES) {
    if (type.method) BY_METHOD.set(type.method, type);
  }

  const OTHER_TYPE = DATA_TYPES.find((t) => t.id === "other");

  function typeOfMethod(method) {
    return BY_METHOD.get(method) || OTHER_TYPE;
  }

  function typeById(id) {
    return DATA_TYPES.find((t) => t.id === id) || OTHER_TYPE;
  }

  /** 给侧边栏渲染勾选项用。必须是可结构化克隆的纯数据。 */
  function typeCatalog() {
    return DATA_TYPES.map((t) => ({
      id: t.id,
      label: t.label,
      // 消息流里的类型标签统一用两字短名，宽度一致看着整齐
      short: t.short || t.label,
      desc: t.desc,
      kind: t.kind,
      unit: t.unit || null,
      color: t.color || null,
      method: t.method,
      defaultOn: t.defaultOn !== false,
    }));
  }

  const api = {
    KIND,
    list: DATA_TYPES,
    catalog: typeCatalog,
    ofMethod: typeOfMethod,
    byId: typeById,
  };

  // 命名空间骨架由 namespace.js 建好，本文件只挂自己的模块（见 namespace.js 的模块表）
  const NS = window.Livra;
  if (NS.installed.types) return;

  NS.installed.types = true;
  NS.types = api;
})();
