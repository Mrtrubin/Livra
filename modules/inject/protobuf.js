/**
 * 注入模块 · protobuf / gzip 解码（MAIN world）
 *
 * 抖音直播的弹幕走 wss://webcast*-ws-web-*.douyin.com/webcast/im/push/v2/，
 * 帧是 PushFrame protobuf，里面 #8 是 gzip 压缩的 Response，Response.#1 是重复的 Message。
 *
 * 这个文件是纯函数，不碰 DOM、不装 hook，可以单独拿出来跑测试。
 */

(() => {
  const NS = (window.__livraNS = window.__livraNS || {});
  if (NS.installed) return;

  function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;

    while (pos < buf.length) {
      const byte = buf[pos++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (!(byte & 0x80)) return [result, pos];
    }

    throw new Error("varint 越界");
  }

  function decodeFields(buf) {
    const fields = [];
    let pos = 0;

    while (pos < buf.length) {
      const [tag, afterTag] = readVarint(buf, pos);
      pos = afterTag;

      const no = tag >> 3;
      const wire = tag & 7;

      if (wire === 0) {
        const [value, after] = readVarint(buf, pos);
        pos = after;
        fields.push({ no, wire, value });
      } else if (wire === 2) {
        const [len, afterLen] = readVarint(buf, pos);
        pos = afterLen;
        fields.push({ no, wire, bytes: buf.subarray(pos, pos + len) });
        pos += len;
      } else if (wire === 5) {
        fields.push({ no, wire, value: buf.readUInt32LE(pos) });
        pos += 4;
      } else if (wire === 1) {
        fields.push({ no, wire, value: Number(buf.readBigUInt64LE(pos)) });
        pos += 8;
      } else {
        throw new Error(`未知 wire type ${wire}`);
      }
    }

    return fields;
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 注意：浏览器里 Uint8Array 没有 toString("utf8")（那是 Node Buffer 才有），
  // 直接调会得到一串用逗号分隔的十进制数字，而且不报错。必须用 TextDecoder。
  const decoder = new TextDecoder("utf-8");
  const str = (field) => (field?.bytes ? decoder.decode(field.bytes) : "");

  /* ============================ 消息结构 ============================ */

  // PushFrame.#5 是重复的 header（#1=key, #2=value）
  function readHeaders(fields) {
    const headers = {};

    for (const field of fields.filter((f) => f.no === 5)) {
      const kv = decodeFields(field.bytes);
      const key = str(kv.find((f) => f.no === 1));
      const value = str(kv.find((f) => f.no === 2));
      if (key) headers[key] = value;
    }

    return headers;
  }

  function readUser(body) {
    const fields = decodeFields(body);
    const user = fields.find((f) => f.no === 2)?.bytes;
    if (!user) return null;

    const userFields = decodeFields(user);

    return {
      id: String(userFields.find((f) => f.no === 1)?.value ?? ""),
      nickname: str(userFields.find((f) => f.no === 3)) || "(未知用户)"
    };
  }

  // 把一条 Message 变成侧边栏能直接用的结构
  function extractMessage(method, body) {
    const fields = decodeFields(body);
    const base = { method };

    const common = fields.find((f) => f.no === 1)?.bytes;
    if (common) {
      base.msgId = String(decodeFields(common).find((f) => f.no === 2)?.value ?? "");
    }

    const user = readUser(body);
    if (user) {
      base.userId = user.id;
      base.nickname = user.nickname;
    }

    switch (method) {
      case "WebcastChatMessage":
        // #3 = 弹幕正文，#15 = 秒级时间戳
        base.kind = "danmaku";
        base.content = str(fields.find((f) => f.no === 3));
        base.ts = fields.find((f) => f.no === 15)?.value ?? null;
        break;

      case "WebcastMemberMessage":
        base.kind = "enter";
        base.content = "来了";
        break;

      case "WebcastLikeMessage":
        base.kind = "like";
        base.content = "点了赞";
        break;

      case "WebcastGiftMessage":
        base.kind = "gift";
        base.content = "送出礼物";
        break;

      case "WebcastSocialMessage":
        base.kind = "social";
        base.content = "关注了主播";
        break;

      case "WebcastRoomUserSeqMessage":
        // #7 = 在线人数
        base.kind = "online";
        base.online = fields.find((f) => f.no === 7)?.value ?? null;
        break;

      case "WebcastRoomStatsMessage":
        base.kind = "stats";
        base.content = str(fields.find((f) => f.no === 2));
        break;

      default:
        base.kind = "other";
        break;
    }

    return base;
  }

  async function decodePushFrame(bytes) {
    const fields = decodeFields(bytes);
    const seqId = fields.find((f) => f.no === 1)?.value;

    // seqId = 1 是心跳
    if (seqId === 1) return [];

    const payload = fields.find((f) => f.no === 8)?.bytes;
    if (!payload || payload.length < 2) return [];

    const headers = readHeaders(fields);

    let plain = payload;
    if (payload[0] === 0x1f && payload[1] === 0x8b) {
      plain = await gunzip(payload);
    } else if (headers.compress_type === "gzip") {
      plain = await gunzip(payload);
    }

    const response = decodeFields(plain);
    const out = [];

    for (const field of response.filter((f) => f.no === 1)) {
      try {
        const message = decodeFields(field.bytes);
        const method = str(message.find((f) => f.no === 1));
        const body = message.find((f) => f.no === 2)?.bytes;
        if (!method || !body) continue;
        out.push(extractMessage(method, body));
      } catch {
        // 单条消息解不开就跳过，不影响整帧
      }
    }

    return out;
  }

  NS.protobuf = { readVarint, decodeFields, gunzip, decodePushFrame, extractMessage, str };
})();
