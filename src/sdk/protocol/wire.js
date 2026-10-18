/**
 * SDK · 协议底层（纯函数）
 *
 * protobuf 的 wire format 解码 + gzip 解压。这里不知道任何抖音业务，
 * 换个站也能用。
 *
 * 抖音直播的弹幕走 wss://webcast*-ws-web-*.douyin.com/webcast/im/push/v2/，
 * 帧是 PushFrame protobuf：#8 是 payload（可能 gzip），解开后是 Response，
 * Response.#1 是重复的 Message，每条 Message.#1 = method 名、#2 = 消息体。
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.wire) return;
  NS.installed.wire = true;

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

  /** 把一段 buffer 解成扁平的字段列表 [{ no, wire, value|bytes }] */
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

  // 浏览器里 Uint8Array 没有 toString("utf8")（那是 Node Buffer 才有的），
  // 直接调会得到一串用逗号分隔的十进制数字，而且不报错。必须用 TextDecoder。
  const decoder = new TextDecoder("utf-8");

  /* ---------------- 字节的两种装法 ----------------
   *
   * 页面里字段字节就是 Uint8Array；但扩展的消息通道（runtime.sendMessage）走的是
   * JSON 序列化，Uint8Array 过不去 —— 到对面会变成 {0:10,1:39,...} 这种普通对象，
   * 既没法解，占的内存还是原来的十几倍。所以字节要出页面时先转成 base64
   * （见 bridge.js 的 pack），对面原样存着，哪个模块要读再解回来。
   */
  // ⚠️ 不能走 TextDecoder("latin1")：它按 windows-1252 解，0x80~0x9F 会变成 € 这类
  // U+00FF 以上的字符，btoa 直接抛 InvalidCharacterError。只能按块拼二进制串。
  function b64(bytes) {
    let binary = "";
    const CHUNK = 0x8000; // apply 的参数个数有上限，一次别喂太多

    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    return btoa(binary);
  }

  // atob 出来的字符正好落在 U+0000~U+00FF，charCodeAt 就是原始字节
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  /** 取字段的字节：页面里是 Uint8Array，跨进程搬运后是 base64，两种都收 */
  function bytesOf(field) {
    if (!field) return null;
    if (field.bytes) return field.bytes;
    if (typeof field.b64 === "string") return unb64(field.b64);
    return null;
  }

  function str(field) {
    const bytes = bytesOf(field);
    return bytes ? decoder.decode(bytes) : "";
  }

  /** 一眼看出是不是 gzip 魔数头 */
  function isGzip(bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  /** 找 varint 字段的值 */
  function num(fields, no) {
    return fields.find((f) => f.no === no)?.value ?? null;
  }

  NS.wire = { readVarint, decodeFields, gunzip, str, bytesOf, b64, unb64, isGzip, num };
})();
