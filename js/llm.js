"use strict";
/* llm.js — 可选联网 AI（默认关闭，设置里开启）。
   支持 OpenAI 兼容（chat/completions）与 Anthropic（messages）两种接口；
   支持拉取模型列表、流式/非流式。本地词库为主，AI 做改写增强。 */

const LLM = (function () {

  function cfg() { return Store.getSettings(); }
  function activeId() { return Store.activeProviderId(); }
  function activeProvider() {
    const p = Store.getProviders()[activeId()] || {};
    // API Key 只从 IndexedDB secret store 读
    return Object.assign({}, p, { key: Store.getSecret(activeId()), model: activeModelOf(p) });
  }
  function activeModelOf(p) {
    // 收敛到 store.js 的 activeModel（同一逻辑单点，避免双份漂移）
    return Store.activeModel(activeId());
  }
  // 按 id 取 Provider（含 key + 指定模型）
  function providerById(id, model) {
    const p = Store.getProviders()[id] || {};
    const models = (Array.isArray(p.models) && p.models.length) ? p.models : (p.model ? [p.model] : []);
    const m = (model && models.includes(model)) ? model : (models[0] || p.model || "");
    return Object.assign({}, p, { key: Store.getSecret(id), model: m, type: p.type || "openai" });
  }
  function confEnabled(c) { return !!(c && c.base && c.key); }
  function enabled() { return !!cfg().llmEnabled && confEnabled(activeProvider()); }
  // 归一化临时配置（测试/拉模型/路由用）；无则取当前默认
  function resolveConf(conf) {
    if (conf) {
      // 路由/指定 Provider：{ providerId, model }
      if (conf.providerId) return providerById(conf.providerId, conf.model);
      return { type: conf.type || "openai", base: conf.base || "", key: conf.key || "", model: conf.model || "" };
    }
    const p = activeProvider();
    return { type: p.type || "openai", base: p.base || "", key: p.key || "", model: p.model || "" };
  }
  function defaultModel(type) {
    return type === "anthropic" ? "claude-sonnet-4-20250514" : "deepseek-chat";
  }
  function normBase(base) { return String(base || "").replace(/\/+$/, ""); }

  function chatEndpoint(base, type) {
    if (type === "anthropic") return /\/v1$/.test(base) ? base + "/messages" : base + "/v1/messages";
    return base + "/chat/completions";
  }
  function modelsEndpoint(base, type) {
    if (type === "anthropic") return /\/v1$/.test(base) ? base + "/models" : base + "/v1/models";
    return base + "/models";
  }
  function headers(type, key) {
    const h = { "Content-Type": "application/json" };
    if (type === "anthropic") {
      h["x-api-key"] = key;
      h["anthropic-version"] = "2023-06-01";
    } else {
      h["Authorization"] = "Bearer " + key;
    }
    return h;
  }
  function buildBody(messages, opts, c) {
    const body = {
      model: c.model || defaultModel(c.type),
      max_tokens: (opts && opts.max_tokens) || 400,
      temperature: (opts && opts.temperature) != null ? opts.temperature : 0.7
    };
    // 流式请求必须在请求体声明 stream:true，否则服务端返回完整 JSON 而非 SSE（BUG-004）
    if (opts && opts.stream) body.stream = true;
    if (c.type === "anthropic") {
      const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
      if (sys) body.system = sys;
      body.messages = messages.filter(m => m.role !== "system");
    } else {
      body.messages = messages;
    }
    return body;
  }
  function parseContent(data, type) {
    if (type === "anthropic") {
      const parts = data && data.content || [];
      return parts.filter(p => p.type === "text").map(p => p.text).join("");
    }
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }
  function errMsg(res, body) {
    if (body && body.error && body.error.message) return body.error.message;
    return res.status + " " + res.statusText;
  }
  // 常见状态码 → 中文友好提示
  function friendlyStatus(res, msg) {
    const s = res && res.status;
    if (s === 401 || s === 403) return "认证失败：请检查 API Key 是否正确";
    if (s === 408) return "请求超时：请检查网络后重试";
    if (s === 429) return "请求过多或额度不足：请稍后再试";
    if (s >= 500) return "服务端错误（HTTP " + s + "）：请稍后再试";
    return msg;
  }

  // 返回 { req, cleanup, refresh }。keepAlive=true（流式）时挂起清理，
  // 由调用方在读完 body 后 cleanup；否则 fetch 结束即自动清理。
  // 超时与用户取消区分：超时抛普通 Error（非 AbortError），避免被当作"已取消"静默处理。
  function fetchW(url, init, timeout, keepAlive) {
    const ctrl = new AbortController();
    const ext = (init && init.signal) || null;
    let t = null;
    let timedOut = false;
    const arm = () => { clearTimeout(t); t = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout || 60000); };
    const onExt = () => ctrl.abort();
    if (ext) {
      if (ext.aborted) ctrl.abort();
      else ext.addEventListener("abort", onExt, { once: true });
    }
    const base = fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
    const req = base.catch(err => {
      if (err && err.name === "AbortError" && timedOut) throw new Error("请求超时：请检查网络后重试");
      throw err;
    });
    const refresh = arm;
    const cleanup = () => { clearTimeout(t); if (ext) ext.removeEventListener("abort", onExt); };
    arm();
    if (!keepAlive) req.finally(cleanup).catch(() => { });
    return { req, cleanup, refresh };
  }

  // 非流式对话：返回文本
  async function chat(messages, opts, conf) {
    const c = resolveConf(conf);
    if (!cfg().llmEnabled && !conf) throw new Error("AI 未开启：请先在设置里配置");
    if (!confEnabled(c)) throw new Error("AI 未开启：请先填写 API Base 和 Key");
    const res = await fetchW(chatEndpoint(normBase(c.base), c.type), {
      method: "POST", headers: headers(c.type, c.key), body: JSON.stringify(buildBody(messages, opts, c)),
      signal: opts && opts.signal
    }, (opts && opts.timeout) || 60000).req;
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); msg = errMsg(res, j); } catch (e) { }
      throw new Error(friendlyStatus(res, msg));
    }
    const data = await res.json();
    return parseContent(data, c.type);
  }

  // 流式对话：解析 SSE，按 delta 回调，返回完整文本（可传 signal 取消）
  async function streamChat(messages, opts, conf) {
    const c = resolveConf(conf);
    if (!cfg().llmEnabled && !conf) throw new Error("AI 未开启：请先在设置里配置");
    if (!confEnabled(c)) throw new Error("AI 未开启：请先填写 API Base 和 Key");
    // streamChat 本身即流式函数：无论调用方是否传 opts.stream，请求体必须声明 stream:true（BUG-004），
    // 否则服务端返回完整 JSON 而非 SSE，只能走下方兜底解析（能出稿但不是真流式）
    const streamOpts = Object.assign({}, opts, { stream: true });
    const fr = fetchW(chatEndpoint(normBase(c.base), c.type), {
      method: "POST", headers: headers(c.type, c.key), body: JSON.stringify(buildBody(messages, streamOpts, c)),
      signal: opts && opts.signal
    }, (opts && opts.timeout) || 60000, true);
    let res;
    try { res = await fr.req; }
    catch (e) { fr.cleanup(); throw e; }
    if (!res.ok || !res.body) {
      fr.cleanup();
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); msg = errMsg(res, j); } catch (e) { }
      throw new Error(friendlyStatus(res, msg));
    }
    const onDelta = opts && opts.onDelta;
    // 兜底：服务端未按 SSE 返回（如请求体丢了 stream:true），content-type 是 JSON → 直接按一次性 JSON 解析
    const ctype = (res.headers && typeof res.headers.get === "function") ? (res.headers.get("content-type") || "") : "";
    if (/json/i.test(ctype)) {
      fr.cleanup();
      let data;
      try { data = await res.json(); }
      catch (e) { throw new Error("流式接口响应异常（非 SSE）：" + (e && e.message || e)); }
      const text = parseContent(data, c.type);
      if (text) { if (onDelta) onDelta(text); return text; }
      throw new Error("流式接口返回 JSON 但未解析出正文，请检查 Provider 的流式设置与模型");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", allText = "", full = "", stop = false, sawData = false;
    try {
      while (!stop) {
        const chunk = await reader.read();   // 取消/超时：AbortError 直接向上抛，调用方按"已取消"处理
        if (chunk.done) break;
        fr.refresh();                        // 每收到一块数据重置超时
        const dec = decoder.decode(chunk.value, { stream: true });
        buf += dec;
        allText += dec;
        let idx;
        while (!stop && (idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          sawData = true;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") { stop = true; break; }
          if (!payload) continue;
          let delta = "";
          try {
            const j = JSON.parse(payload);
            if (c.type === "anthropic") {
              if (j.type === "content_block_delta" && j.delta && j.delta.text) delta = j.delta.text;
            } else if (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) {
              delta = j.choices[0].delta.content;
            }
          } catch (e) { }
          if (delta) { full += delta; if (onDelta) onDelta(full); }
        }
      }
      // 兜底 2：全程没有 data: 行（非 SSE，但 content-type 未标记 json）→ 把收满的原文当 JSON 解析
      if (!sawData && !full && allText.trim()) {
        try {
          const j = JSON.parse(allText.trim());
          const text = parseContent(j, c.type);
          if (text) { full = text; if (onDelta) onDelta(full); }
          else throw new Error("未解析出正文");
        } catch (e) {
          throw new Error("流式接口响应异常（既非 SSE 也未解析出内容）：" + (e && e.message || e));
        }
      }
      return full;
    } finally {
      fr.cleanup();
    }
  }

  // 拉取模型列表
  async function fetchModels(opts, conf) {
    const c = resolveConf(conf);
    if (!cfg().llmEnabled && !conf) throw new Error("AI 未开启：请先在设置里配置");
    if (!confEnabled(c)) throw new Error("AI 未开启：请先填写 API Base 和 Key");
    const res = await fetchW(modelsEndpoint(normBase(c.base), c.type), { headers: headers(c.type, c.key) }, 20000).req;
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); msg = errMsg(res, j); } catch (e) { }
      throw new Error(friendlyStatus(res, msg));
    }
    const data = await res.json();
    return (data && data.data || []).map(m => m && m.id).filter(Boolean);
  }

  // 把模型输出切成 2-3 个版本；只过滤"序号列表"形态（如 1./2、），不吞数字开头的正常段落（12号/2024年）
  function splitVersions(text) {
    return String(text || "").split(/\n+/).map(s => s.trim()).filter(s => s && !/^\d{1,2}[.、)．]\s*/.test(s)).slice(0, 3);
  }

  function sysPrompt() {
    return "你是资深网文写作助手。根据上下文、当前情绪与可用素材（来自真实网文提炼的词库/黄金句），改写用户指定的句子，让它更具体、更有人味、去掉 AI 味套话，多写身体反应和小动作。只输出 2-3 个改写版本，每行一个，不加序号和解释。";
  }

  // 润色当前句（AI 按钮）
  async function polish(context, candidates, opts) {
    const candText = (candidates || []).slice(0, 10).map(c => "- " + c).join("\n");
    const msgs = [
      { role: "system", content: sysPrompt() },
      { role: "user", content: "上下文片段：\n" + context + "\n\n可用素材：\n" + (candText || "（无）") + "\n\n请改写这句话：" }
    ];
    if (opts && opts.stream) return streamChat(msgs, opts);
    return splitVersions(await chat(msgs, opts));
  }

  // 选区改写（换说法）
  async function rewriteSelection(sel, context, emotion, candidates, opts) {
    const candText = (candidates || []).slice(0, 10).map(c => "- " + c).join("\n");
    const msgs = [
      { role: "system", content: sysPrompt() },
      { role: "user", content: "情绪方向：" + (emotion || "无指定") + "\n上下文：\n" + context + "\n\n可用素材：\n" + (candText || "（无）") + "\n\n要改写的句子：\n" + sel }
    ];
    if (opts && opts.stream) return streamChat(msgs, opts);
    return splitVersions(await chat(msgs, opts));
  }

  return { enabled, confEnabled, chat, streamChat, polish, rewriteSelection, fetchModels, splitVersions, activeProvider, activeId, providerById, resolveConf, providerPresets: () => Store.providerPresets() };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LLM;
if (typeof globalThis !== "undefined") globalThis.LLM = LLM;
