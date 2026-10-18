/**
 * 替换模块 · CDP Fetch 域改写引擎
 *
 * 职责：跟 CDP 打交道的那部分 —— 开 Fetch 域、处理 requestPaused、回填响应体。
 * 规则和正文替换在同级 rules.js（importScripts 会先加载它）。
 *
 * 依赖全局的 sendCommand()（background.js 提供）。
 */

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

  if (!hasApplicableRule(url)) {
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
