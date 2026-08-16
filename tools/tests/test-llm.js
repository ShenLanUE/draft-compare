"use strict";
globalThis.Store = {
  _s: {
    llmEnabled: false,
    activeProvider: "deepseek",
    providers: {
      deepseek: { id: "deepseek", name: "DeepSeek", type: "openai", base: "https://api.deepseek.com/v1", model: "deepseek-chat", stream: false },
      anthropic: { id: "anthropic", name: "Anthropic", type: "anthropic", base: "https://api.anthropic.com", model: "claude-sonnet-4-20250514", stream: true }
    },
    llmModels: {}
  },
  _sec: { deepseek: "sk-DS", anthropic: "sk-ANTH" },
  getSettings() { return this._s; },
  getProviders() { return this._s.providers; },
  activeProviderId() { return this._s.activeProvider; },
  activeModel(pid) {
    const p = this._s.providers[pid || this._s.activeProvider] || {};
    const models = (Array.isArray(p.models) && p.models.length) ? p.models : (p.model ? [p.model] : []);
    const remembered = (this._s.activeModels || {})[pid || this._s.activeProvider];
    if (remembered && models.includes(remembered)) return remembered;
    return models[0] || p.model || "";
  },
  getSecret(id) { return this._sec[id] || ""; },
  providerPresets() { return {}; }
};
const LLM = require(require("path").join(__dirname, "..", "..", "js", "llm.js"));

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ok:", name); } else { fail++; console.log("FAIL:", name); } }

(async () => {
  // activeProvider 解析：从 providers[activeProvider] + secret key
  const ap = LLM.activeProvider();
  ok(ap.base.includes("deepseek") && ap.key === "sk-DS" && ap.model === "deepseek-chat", "activeProvider 组合 base/key/model");

  let lastReq = null;
  globalThis.fetch = async (url, init) => {
    lastReq = { url, headers: init.headers, body: JSON.parse(init.body) };
    const isAnthropic = /\/messages$/.test(url);
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => isAnthropic
        ? { content: [{ type: "text", text: "测试回复" }] }
        : { choices: [{ message: { content: "测试回复" } }] }
    };
  };

  const out = await LLM.chat([{ role: "user", content: "hi" }], null, { type: "openai", base: "https://api.deepseek.com/v1", key: "sk-T", model: "deepseek-chat" });
  ok(out === "测试回复", "chat 临时配置成功");
  ok(lastReq.headers.Authorization === "Bearer sk-T", "openai Bearer 头");

  const out2 = await LLM.chat([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], null, { type: "anthropic", base: "https://api.anthropic.com", key: "sk-A", model: "claude-x" });
  ok(out2 === "测试回复", "chat anthropic 临时配置");
  ok(lastReq.headers["x-api-key"] === "sk-A" && !("Authorization" in lastReq.headers), "anthropic 只发 x-api-key");
  ok(lastReq.body.system === "sys", "anthropic system 分离");

  // 非流式 chat 支持外部 signal（取消入口）
  globalThis.fetch = (url, init) => new Promise((res, rej) => {
    const sig = init && init.signal;
    let done = false;
    const fail = (e) => { if (!done) { done = true; rej(e); } };
    if (sig && sig.aborted) return fail(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    if (sig) sig.addEventListener("abort", () => fail(Object.assign(new Error("Aborted"), { name: "AbortError" })));
  });
  const ctrl = new AbortController();
  let aborted = false;
  const p2 = LLM.chat([{ role: "user", content: "hi" }], { signal: ctrl.signal }, { type: "openai", base: "https://x", key: "k", model: "m" });
  setTimeout(() => ctrl.abort(), 100);
  try { await p2; } catch (e) { aborted = (e && e.name === "AbortError"); }
  ok(aborted, "非流式 chat 可被外部 signal 取消");

  // fetchW 超时 → 友好错误（非 AbortError，避免被当成"已取消"静默处理）
  const t0 = Date.now();
  let timedOut = false, isAbort = true;
  try { await LLM.chat([{ role: "user", content: "hi" }], { timeout: 200 }, { type: "openai", base: "https://x", key: "k", model: "m" }); }
  catch (e) { timedOut = /请求超时/.test(e.message); isAbort = (e && e.name === "AbortError"); }
  ok(timedOut && !isAbort && (Date.now() - t0) < 3000, "fetchW 超时转友好错误（非 AbortError）");
  await new Promise(r => setTimeout(r, 130));   // 排空上一条外部 abort 定时器，避免脏拒绝

  // streamChat 中途取消 → 抛 AbortError（不 resolve 半截文本）
  const abortErr = () => Object.assign(new Error("Aborted"), { name: "AbortError" });
  globalThis.fetch = (url, init) => {
    const sig = init && init.signal;
    const enc = new TextEncoder();
    let n = 0;
    return Promise.resolve({
      ok: true, status: 200, statusText: "OK",
      body: { getReader: () => ({
        read: () => {
          if (sig && sig.aborted) return Promise.reject(abortErr());
          n++;
          if (n === 1) return Promise.resolve({ done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n') });
          // 之后挂起，等外部 abort
          return new Promise((res, rej) => {
            let done = false;
            const fail = (e) => { if (!done) { done = true; rej(e); } };
            const onA = () => fail(abortErr());
            sig.addEventListener("abort", onA);
            if (sig.aborted) fail(abortErr());
          });
        }
      }) }
    });
  };
  const c2 = new AbortController();
  let streamRejected = false, partial = null;
  const p3 = LLM.streamChat([{ role: "user", content: "hi" }], { signal: c2.signal, onDelta: (t) => { partial = t; } }, { type: "openai", base: "https://x", key: "k", model: "m" })
    .then(() => { ok(false, "取消后不应 resolve"); })
    .catch((e) => { if (e && e.name === "AbortError") streamRejected = true; });
  setTimeout(() => c2.abort(), 50);
  await p3;
  ok(streamRejected, "streamChat 取消→抛 AbortError");
  ok(partial === "半截", "取消时只流过已到内容，不 resolve 半截文本");

  // 路由：providerById / resolveConf(providerId, model)
  const rp = LLM.providerById("deepseek", "deepseek-chat");
  ok(rp.key === "sk-DS" && rp.base.includes("deepseek") && rp.type === "openai", "providerById 组合 base/key/type");
  const rc = LLM.resolveConf({ providerId: "anthropic" });
  ok(rc.type === "anthropic" && rc.key === "sk-ANTH" && rc.model === "claude-sonnet-4-20250514", "resolveConf 按 providerId 取默认模型");

  // BUG-004：流式请求体必须带 stream:true（否则服务端返回非 SSE），且 SSE 能正常解析
  let lastBody = null;
  globalThis.fetch = (url, init) => {
    lastBody = JSON.parse(init.body);
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"流"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"式正文"}}]}\n\n',
      "data: [DONE]\n\n"
    ];
    let n = 0;
    return Promise.resolve({
      ok: true, status: 200, statusText: "OK",
      headers: { get: () => "text/event-stream" },
      body: { getReader: () => ({ read: () => n < chunks.length
        ? Promise.resolve({ done: false, value: enc.encode(chunks[n++]) })
        : Promise.resolve({ done: true }) }) }
    });
  };
  let streamed = "";
  const sOut = await LLM.streamChat([{ role: "user", content: "hi" }], { stream: true, onDelta: (t) => { streamed = t; } }, { type: "openai", base: "https://x", key: "k", model: "m" });
  ok(lastBody.stream === true, "流式请求体含 stream:true（BUG-004）");
  ok(sOut === "流式正文" && streamed === "流式正文", "SSE 解析返回完整文本并逐段回调");

  // BUG-004 兜底：Provider 未按 SSE 返回（完整 JSON + content-type json）也能出稿
  globalThis.fetch = () => Promise.resolve({
    ok: true, status: 200, statusText: "OK", body: {},
    headers: { get: () => "application/json" },
    json: async () => ({ choices: [{ message: { content: "JSON 兜底正文" } }] })
  });
  let deltaOnce = null;
  const jOut = await LLM.streamChat([{ role: "user", content: "hi" }], { stream: true, onDelta: (t) => { deltaOnce = t; } }, { type: "openai", base: "https://x", key: "k", model: "m" });
  ok(jOut === "JSON 兜底正文", "非 SSE JSON 响应走兜底解析（BUG-004）");
  ok(deltaOnce === "JSON 兜底正文", "非 SSE 兜底也回调 onDelta 一次");

  console.log("\nPASS=" + pass + " FAIL=" + fail);
  process.exit(fail ? 1 : 0);
})();
