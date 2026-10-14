/**
 * Livra —— 响应体正则改写
 *
 * 用 CDP 的 Fetch 域在「响应阶段」把请求挂起，正文命中规则就替换后再回填给浏览器。
 * 规则硬编码在下面的 REWRITE_RULES 里，改规则就改这里、重新加载扩展即可。
 *
 * 这个文件由 background.js 通过 importScripts() 加载，共用同一个全局作用域，
 * 所以可以直接用 background.js 里的 sendCommand()。
 */

/* ============================ 规则 ============================ */

// 注意：含反斜杠的字符串必须用 String.raw。
// 普通字符串字面量里的 '\.' 会把反斜杠吃掉变成 '.'，匹配就错了，而且不报错。
const REWRITE_FIND = String.raw`var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;`;
const REWRITE_REPLACE = String.raw`var c=/#.*$/,l=/(index)?\.(md|html)$/,u=/^[a-z]+:/i;alert('test');`;

/**
 * 规则字段说明：
 *
 *   name         规则名，只用于日志
 *   enabled      关掉就完全不参与（CDP 也不会拦它）
 *   fetchPattern CDP 的 URL 通配符，决定「哪些请求会被拦下来」。
 *                这是性能的关键：不匹配的请求压根不会被暂停，没有额外开销。
 *                用 "*" 表示所有请求，但那样每个文本响应都要多一次 CDP 往返，页面大会明显变慢。
 *   urlPattern   规则层的二次过滤（正则，可为 null）。null = 不再过滤。
 *                注意别拿它当主要过滤手段 —— 被 CDP 拦下来的请求仍然要走一次往返。
 *   find         要查找的字符串（按字面量处理，元字符会自动转义）
 *   replacement  替换成的字符串（按字面量处理，$& / $1 不会被当特殊记号）
 */
const REWRITE_RULES = [
  {
    name: "注入 alert('test')",
    enabled: true,

    // 只拦 URL 里带 config 的请求（例如 /assets/chunks/config.DHyWUa4I.js）
    fetchPattern: "*config*",

    urlPattern: null,

    find: REWRITE_FIND,
    replacement: REWRITE_REPLACE
  }
];

/* ============================ 选项 ============================ */

/**
 * 全局行为开关。这两项都直接影响性能，按需关掉能省下不少开销。
 */
const REWRITE_OPTIONS = {
  /**
   * 是否关闭该标签页的 HTTP 缓存。
   *
   * Fetch 域拦不到「由 HTTP 缓存直接满足」的响应 —— 命中缓存时 requestPaused 根本不触发，
   * 规则再匹配也改不到。所以开改写时默认必须关缓存（等于 DevTools 的 Disable cache）。
   * 代价是该标签页每次加载都真的走网络，会变慢。
   * 如果目标站点不强缓存（或你只需要第一次访问生效），把它关掉能明显提速。
   */
  disableCache: true,

  /**
   * 是否连跨站 iframe / Worker 一起改写。
   *
   * 开着会多一次 Target.setAutoAttach，且子 target 挂上来时每个都要再开一次 Fetch 域。
   * 只需要改主文档就关掉。
   */
  includeChildFrames: true
};

/* ============================ 工具 ============================ */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 预编译成带 g 的正则
for (const rule of REWRITE_RULES) {
  rule.findRe = new RegExp(escapeRegExp(rule.find), "g");
}

function hasEnabledRewriteRules() {
  return REWRITE_RULES.some(rule => rule.enabled);
}

/**
 * 给侧边栏展示用的规则摘要。
 * 必须是可结构化克隆的纯数据（不能把 RegExp / 预编译的 findRe 传过去）。
 */
function rulesSummary() {
  return REWRITE_RULES.map(rule => ({
    name: rule.name,
    enabled: rule.enabled,
    fetchPattern: rule.fetchPattern || "*",
    urlPattern: rule.urlPattern ? String(rule.urlPattern) : null,
    find: rule.find,
    replacement: rule.replacement
  }));
}

function ruleMatchesUrl(rule, url) {
  return !rule.urlPattern || rule.urlPattern.test(url);
}

// 只处理文本类响应；图片/字体/压缩包等一律放行
function isTextualResponse(contentType) {
  return /json|javascript|ecmascript|xml|text\/|charset=/i.test(contentType || "");
}

function findHeaderValue(headers, name) {
  const hit = (headers || []).find(h => h.name.toLowerCase() === name);
  return hit ? hit.value : "";
}

function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

function base64ToText(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 对正文套用所有规则。
 * 返回 { text, hits }，hits 是命中的规则名数组。
 */
function applyRewriteRules(url, text) {
  let out = text;
  const hits = [];

  for (const rule of REWRITE_RULES) {
    if (!rule.enabled) continue;
    if (!ruleMatchesUrl(rule, url)) continue;

    // 带 /g 的正则 test() 会改 lastIndex，连续调用必须重置，否则会漏匹配
    rule.findRe.lastIndex = 0;
    if (!rule.findRe.test(out)) continue;

    rule.findRe.lastIndex = 0;
    // 用函数形式替换：replacement 里的 $& / $1 / $' 等会被当成特殊记号，
    // 函数形式则一律按字面量处理。
    out = out.replace(rule.findRe, () => rule.replacement);
    hits.push(rule.name);
  }

  return { text: out, hits };
}

/**
 * 正文已经被 CDP 解压过了，所以 content-encoding 必须删掉、content-length 必须重算，
 * 否则浏览器会拿明文去 gunzip，直接报错。
 */
function buildRewrittenHeaders(headers, body) {
  const out = [];

  for (const { name, value } of headers || []) {
    const lower = name.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length") continue;
    out.push({ name, value });
  }

  out.push({ name: "Content-Length", value: String(utf8Length(body)) });
  return out;
}

/* ============================ Fetch 域 ============================ */

/**
 * 把规则里的 fetchPattern 收成 CDP 的 patterns。
 * 只有被拦下来的请求才可能被改写，所以这里决定的是「拦截范围」。
 */
function buildFetchPatterns() {
  const seen = new Set();
  const patterns = [];

  for (const rule of REWRITE_RULES) {
    if (!rule.enabled) continue;

    const urlPattern = rule.fetchPattern || "*";
    if (seen.has(urlPattern)) continue;

    seen.add(urlPattern);
    patterns.push({ urlPattern, requestStage: "Response" });
  }

  return patterns;
}

function enableRewriteDomain(session) {
  const patterns = buildFetchPatterns();
  if (!patterns.length) return Promise.resolve();

  return sendCommand(session, "Fetch.enable", {
    patterns,
    handleAuthRequests: false
  });
}

/**
 * 关键：Fetch 域**不会拦截由 HTTP 缓存直接满足的响应**。
 * 命中缓存时 `Fetch.requestPaused` 根本不会触发，改写自然无从谈起。
 *
 * 像 cn.vuejs.org 这种带 `cache-control: max-age=31536000, immutable` 的站点，
 * 第二次访问所有 chunk 都从磁盘缓存出，表现就是「规则明明匹配、却一条都没改写」。
 *
 * 所以开改写时必须同时把缓存关掉（DevTools 的 "Disable cache" 复选框做的就是这件事）。
 * 实测：关缓存前只拦到 10 条（config chunk 不在其中），关掉后拦到 28 条并成功改写。
 */
function disableCacheForRewrite(session) {
  if (!REWRITE_OPTIONS.disableCache) return Promise.resolve();
  if (!hasEnabledRewriteRules()) return Promise.resolve();
  return sendCommand(session, "Network.setCacheDisabled", { cacheDisabled: true });
}

/**
 * 处理 Fetch.requestPaused。
 *
 * 每一条都必须回应（continueRequest / fulfillRequest / failRequest 三选一），
 * 漏一条那个请求就永远挂起，页面直接卡死。
 *
 * 返回 { rewritten, hits } 供调用方标记请求。
 */
async function handleRequestPaused(session, params) {
  const { requestId, request, responseStatusCode, responseHeaders } = params;

  const reply = (method, extra) =>
    sendCommand(session, method, { requestId, ...extra }).catch(() => {});

  // 重定向 / 拿不到响应体 -> 放行
  if (responseStatusCode == null || (responseStatusCode >= 300 && responseStatusCode < 400)) {
    await reply("Fetch.continueRequest");
    return { rewritten: false };
  }

  // 204 / 304 没有响应体，省掉一次 Fetch.getResponseBody 往返
  if (responseStatusCode === 204 || responseStatusCode === 304) {
    await reply("Fetch.continueRequest");
    return { rewritten: false };
  }

  if (!isTextualResponse(findHeaderValue(responseHeaders, "content-type"))) {
    await reply("Fetch.continueRequest");
    return { rewritten: false };
  }

  const url = request.url;
  const applicable = REWRITE_RULES.some(rule => rule.enabled && ruleMatchesUrl(rule, url));

  if (!applicable) {
    await reply("Fetch.continueRequest");
    return { rewritten: false };
  }

  try {
    const result = await sendCommand(session, "Fetch.getResponseBody", { requestId });

    // 注意：纯文本 JS / JSON 也常常返回 base64Encoded = true，
    // 所以不能拿这个字段判断「是不是二进制」，只能按 content-type 判断。
    const text = result.base64Encoded ? base64ToText(result.body) : result.body;

    const { text: out, hits } = applyRewriteRules(url, text);

    if (!hits.length) {
      await reply("Fetch.continueRequest");
      return { rewritten: false };
    }

    console.log(`[rewrite] ${url} 命中：${hits.join("、")}`);

    await reply("Fetch.fulfillRequest", {
      responseCode: responseStatusCode,
      responsePhrase: "OK",
      responseHeaders: buildRewrittenHeaders(responseHeaders, out),
      body: textToBase64(out)
    });

    return { rewritten: true, hits };
  } catch (error) {
    console.warn(`[rewrite] 处理失败，回退放行 ${url}：${error.message}`);
    await reply("Fetch.continueRequest");
    return { rewritten: false };
  }
}
