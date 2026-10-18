/**
 * SDK · 抖音消息解码
 *
 * 依赖 protocol/wire.js（底层解码）和 types.js（类型清单）。
 *
 * ⚠️ 职责边界：**只解码，不解释**。
 *
 * 这里做三件事，多一件都不做：
 *   1. 把 protobuf 帧解成字段列表
 *   2. 通用归一化 —— 去重 id、消息类型、发送者、时间戳、指标数值
 *   3. 把解码结果**原样挂在 message.fields 上，一个字段都不丢**
 *
 * 「这条消息该怎么显示」不归这里管，归展示层（src/panel/format.js）。礼物叫什么、
 * 送了几个、点赞几次，都由展示层自己从 fields 里取。
 *
 * 以前这里硬编码了一句「送出礼物」，并且只挑出一个 giftId 塞进 extra —— 礼物名称
 * 和数量就是这么丢的。解码层一旦开始替界面做决定，丢信息是迟早的事。
 *
 * 统一输出格式：
 *   {
 *     id,      去重用的 key
 *     method,  抖音原始 method 名（兜底类型时最有用，能看出抖音还推了什么）
 *     type,    types.js 里的 id，界面按它决定展示与否、用什么颜色
 *     user,    { id, nickname }，可能没有
 *     value,   仅 metric 类型，按 types.js 里声明的 field 取的数字
 *     fields,  解码后的完整字段列表（嵌套结构保留原始字节，交给展示层按需再解）
 *     ts,      毫秒时间戳
 *   }
 *
 * ⚠️ 关于 User 的定位：不硬编码「第几个字段是 user」，而是按 User 的结构特征去探。
 * User 的形状固定是 { #1=id(varint), #3=nickname(string) }，所以扫一遍嵌套字段，
 * 命中这个形状的就是它。这样换了 method 不用改代码 —— 抖音 GiftMessage 的 user 在 #7、
 * ChatMessage 在 #2，硬编码必然出错。
 */

(() => {
  const NS = window.Livra;
  if (NS.installed.decoder) return;
  NS.installed.decoder = true;

  const { decodeFields, str, gunzip, isGzip, num } = NS.wire;

  /* ============================ 通用结构探测 ============================ */

  /** 按 User 的形状特征找 user，找不到返回 null */
  function probeUser(fields) {
    for (const field of fields) {
      if (field.wire !== 2 || !field.bytes) continue;

      try {
        const inner = decodeFields(field.bytes);
        const id = inner.find((f) => f.no === 1 && f.wire === 0)?.value;
        const nickname = str(inner.find((f) => f.no === 3));

        // id 要是个正数，昵称不能长得离谱 —— 防止把别的嵌套结构误认成 user
        if (id && id > 0 && nickname && nickname.length <= 64) {
          return { id: String(id), nickname };
        }
      } catch {
        // 解不开就当不是，继续找下一个
      }
    }

    return null;
  }

  /** common(#1) 里的 msgId(#2)，是天然的去重 key */
  function probeMsgId(fields) {
    const common = fields.find((f) => f.no === 1 && f.wire === 2);
    if (!common) return "";

    try {
      return String(num(decodeFields(common.bytes), 2) ?? "");
    } catch {
      return "";
    }
  }

  /* ============================ 单条消息 ============================ */

  /**
   * 把字段里的字节从原帧 buffer 上摘下来。
   *
   * decodeFields 返回的是 subarray（视图，共享底层 buffer）。不复制的话，
   * 只要留着任一消息的 fields，整帧（里面还有同帧其它几十条消息的字节）就
   * 一直没法回收。复制一份切片，内存就只等于这条消息自己那点字节。
   */
  function detach(fields) {
    for (const field of fields) {
      if (field.bytes) field.bytes = field.bytes.slice();
    }
    return fields;
  }

  /**
   * 解码 + 通用归一化。除 types.js 里声明的指标字段外，不读任何业务字段 ——
   * 那些留给展示层（src/panel/format.js）按需解释。
   *
   * fields 是 wire.decodeFields 的原始输出：嵌套结构只解到这一层，里面的字节
   * 原样留着。展示层要深挖时再解（src/panel/format.js 就是这么干活的）。
   */
  function extractMessage(method, body) {
    const fields = detach(decodeFields(body));
    const type = NS.types.ofMethod(method);
    const user = probeUser(fields);
    const msgId = probeMsgId(fields);

    return {
      id: msgId || `${method}:${user?.id || ""}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      method,
      type: type.id,
      user: user || null,
      // 指标类才有值，字段号写在类型清单里，不在这里硬编码
      value: type.field != null ? num(fields, type.field) : null,
      fields,
      ts: num(fields, 15) ? Number(num(fields, 15)) * 1000 : Date.now(),
    };
  }

  /* ============================ 整帧 ============================ */

  async function decodePushFrame(bytes) {
    const frame = decodeFields(bytes);

    // seqId = 1 是心跳，没有业务内容
    if (num(frame, 1) === 1) return [];

    const payload = frame.find((f) => f.no === 8)?.bytes;
    if (!payload || payload.length < 2) return [];

    // 压缩有两种判据：魔数头（最可靠），或 header 里声明了 compress_type
    let plain = payload;
    if (isGzip(payload)) {
      plain = await gunzip(payload);
    } else {
      for (const field of frame.filter((f) => f.no === 5)) {
        try {
          const kv = decodeFields(field.bytes);
          if (str(kv.find((f) => f.no === 1)) === "compress_type") {
            if (str(kv.find((f) => f.no === 2)) === "gzip") plain = await gunzip(payload);
            break;
          }
        } catch {
          // 忽略
        }
      }
    }

    const out = [];

    for (const field of decodeFields(plain).filter((f) => f.no === 1)) {
      try {
        const message = decodeFields(field.bytes);
        const method = str(message.find((f) => f.no === 1));
        const body = message.find((f) => f.no === 2)?.bytes;

        if (method && body) out.push(extractMessage(method, body));
      } catch {
        // 单条解不开就跳过，不影响整帧
      }
    }

    return out;
  }

  NS.decoder = { decodePushFrame, extractMessage, probeUser };
})();
