/**
 * 面板 · 消息文案
 *
 * SDK 那边的分工是「只解码，不解释」：把 protobuf 解成字段列表，原样挂在
 * message.fields 上，一个字段都不丢。至于这条消息**该怎么显示**，是这里的事。
 *
 * 这么分是有代价的教训：以前解码层自己拼了一句「送出礼物」，并且只挑出 giftId
 * 塞进 extra —— 礼物名称和数量就是这么丢的。解码层一旦替界面做决定，丢信息是迟早的事。
 * 现在要显示什么，直接从完整字段里取，抖音加字段也不会看不见。
 *
 * 字段号依据 douyin.proto（GiftMessage / ChatMessage / LikeMessage 等）：
 *   GiftMessage   #2 giftId  #5 repeatCount  #29 totalCount  #15 GiftStruct
 *   GiftStruct    #2 describe（"送出小心心"）  #16 name（"小心心"）
 *   ChatMessage   #3 content
 *   LikeMessage   #2 count（本次）  #3 total（房间累计）
 *   RoomStats     #2 数字文本
 */

// 顶层 const 会进全局词法作用域，和别的文件撞名会让整个脚本加载失败，所以整段包起来
(() => {
const { decodeFields, str, num, bytesOf } = window.Livra.wire;

/** 解一层嵌套字段。解不开就当没有，不让一条坏消息影响整屏 */
function nested(fields, no) {
  // 字段字节过了扩展消息通道是 base64，bytesOf 负责解回字节
  const bytes = bytesOf((fields || []).find((f) => f.no === no));
  if (!bytes) return [];

  try {
    return decodeFields(bytes);
  } catch {
    return [];
  }
}

function text(fields, no) {
  return str((fields || []).find((f) => f.no === no)) || "";
}

/* ============================ 各类型怎么显示 ============================ */

const FORMATTERS = {
  danmaku: (fields) => text(fields, 3),

  gift: (fields) => {
    const gift = nested(fields, 15);
    // #16 是礼物名（"小心心"），#2 是描述（"送出小心心"），都没有就退回类型名
    const name = text(gift, 16) || text(gift, 2) || "礼物";
    // #5 是本次连击数量，#29 是累计数量
    const count = num(fields, 5) || num(fields, 29) || 1;

    return count > 1 ? `送出 ${name} ×${count}` : `送出 ${name}`;
  },

  like: (fields) => {
    // #2 是本次点了几下；#3 是房间累计点赞数（几百万那个），别拿错
    const count = num(fields, 2);
    return count > 1 ? `点了赞 ×${count}` : "点了赞";
  },

  stats: (fields) => text(fields, 2),

  enter: () => "来了",
  social: () => "关注了主播",
  fansclub: () => "粉丝团动态",
  control: () => "直播间控制指令",
  room: () => "房间信息变更",
  product: () => "商品变更",
  rank: () => "榜单更新",
  delete: () => "消息被撤回",
};

/**
 * 把一条消息变成展示用的一句话。
 * 认不出/没内容的兜底：有类型名就显示类型名，否则显示原始 method —— 至少让人
 * 知道抖音还推了什么。
 */
function describe(message) {
  const build = FORMATTERS[message.type];
  const content = build ? build(message.fields || []) : "";

  if (content) return content;

  const meta = window.Livra.types.byId(message.type);
  return meta?.method ? `(${meta.label})` : message.method;
}

// 挂到 window.Livra 下面，不另开全局 —— 面板页面里也只有这一个 Livra 对象
window.Livra.format = { describe, nested, text };
})();
