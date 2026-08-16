"use strict";
/* editor-ai.js — AI 深度辅助面板 / 浮动结果卡 / 历史 / 钉选（从 editor.js 拆出）。 */
const EditorAi = (function () {
  const core = () => (typeof globalThis !== "undefined" && globalThis.Editor && Editor._) || null;
  const el = (id) => document.getElementById(id);
  const esc = U.esc;
  const toast = U.toast;
  const copyText = U.copyText;
  const _hideSelToolbar = () => { const c = core(); if (c) c.hideSelToolbar(); };
  const _renderAiMenuModels = () => { const c = core(); if (c) c.renderAiMenuModels(); };
  const _setUi = (p) => { const c = core(); if (c) c.setUi(p); };
  const _doReplace = () => { const c = core(); if (c) c.doReplace(); };
  const _lastSentence = (s) => { const c = core(); return c ? c.lastSentence(s) : ""; };
  const _lastParagraph = (s) => { const c = core(); return c ? c.lastParagraph(s) : ""; };
  const _insertText = (t, r) => { const c = core(); if (c) c.insertText(t, r); };
  const _getEmotion = () => { const c = core(); return c ? c.getEmotion() : ""; };
  const _ta = () => { const c = core(); return c ? c.ta() : (typeof document !== "undefined" ? document.getElementById("editor-ta") : null); };

  let aiRange = null;
  let aiStreamCtrl = null;   // Agent 运行的取消句柄
  let aiTabOpen = false;     // AI 写作面板是否展开
  let aiResultTexts = [];    // 当前渲染的版本文本（data-ai-ins 下标引用，避免把全文塞进属性）
  let aiHistory = [];        // 最近 N 次运行记录
  let aiLastRun = null;      // 最近一次任务 { task, label, ctx, range }（重新生成用）
  let aiLastCtx = null;      // 本次任务上下文/选区快照（面板预览用）
  let aiLastKeywords = "";   // 本次手动关键词
  let aiCurRender = null;    // 当前渲染状态（删除单版后按它重渲染）
  let aiKwChips = [];        // 本次 plan 关键词（可编辑重跑）
  let aiHistType = "";       // 历史筛选：任务类型
  let aiHistKw = "";         // 历史筛选：关键词
  let floatingOn = false;    // 浮动结果卡是否打开
  let floatingStream = null; // 浮动流式 AbortController
  const AI_HISTORY_MAX = 20;

  function openAiTab() {
    aiTabOpen = true;
    _hideSelToolbar();
    if (floatingOn) closeFloating();
    _renderAiMenuModels();
    syncAiCfgUI();
    syncAiEmo();
    renderAiTasks();
    const db = el("dock-body");
    if (db) db.classList.add("show-ai");
    const body = el("ai-body");
    if (body && !body.innerHTML) {
      if (LLM.enabled()) body.innerHTML = '<div class="ai-tip">把光标放在要操作的位置选择任务，或「选中文字」自动弹润色工具条（Alt+P/E/R）。</div>';
      else renderAiOffHint();
    }
    _setUi({ aiTabOpen: true });
  }
  function closeAiTab() {
    aiTabOpen = false;
    const db = el("dock-body");
    if (db) db.classList.remove("show-ai");
    _setUi({ aiTabOpen: false });
  }
  function toggleAiTab() {
    if (aiTabOpen) closeAiTab();
    else openAiTab();
  }
  // 渲染任务区：内置 4 任务 + 用户自定义 Agent
  function renderAiTasks() {
    const bar = el("ai-taskbar");
    if (!bar) return;
    const builtin = [["polish", "润色当前句"], ["continue", "续写下一段"], ["expand", "扩写当前段"], ["rewrite", "重写全段"]];
    const customs = (Agent.customAgents() || []).filter(a => a.enabled !== false);
    bar.innerHTML = builtin.map(([k, n]) => '<button type="button" class="ai-task" data-ai-task="' + k + '">' + n + '</button>').join("") +
      customs.map(a => '<button type="button" class="ai-task ai-task-custom" data-ai-task="' + esc(a.id) + '" title="自定义 Agent：' + esc(a.systemPrompt || "") + '">' + esc(a.name) + '</button>').join("");
  }
  // 同步面板行为开关 + 温度 + 审校（读 Store）
  function syncAiCfgUI() {
    const ac = (Store.getSettings().agentCfg) || {};
    const set = (id, v) => { const n = el(id); if (n) n.checked = !!v; };
    set("ai-cfg-material", ac.useMaterial !== false);
    set("ai-cfg-lore", ac.useLore !== false);
    set("ai-cfg-prev", ac.usePrev !== false);
    set("ai-cfg-auto", ac.autoResearch !== false);
    set("ai-cfg-reviewer", Agent.reviewerEnabled());
    const t = el("ai-cfg-temp");
    if (t) t.value = (ac.temperature != null ? ac.temperature : 0.7);
  }
  // 面板开关改动 → 写回 Store（agentCfg + 审校开关）
  function syncAiCfgFromUI() {
    const ac = Object.assign({}, (Store.getSettings().agentCfg) || {});
    const g = (id, def) => { const n = el(id); return n ? n.checked : def; };
    ac.useMaterial = g("ai-cfg-material", true);
    ac.useLore = g("ai-cfg-lore", true);
    ac.usePrev = g("ai-cfg-prev", true);
    ac.autoResearch = g("ai-cfg-auto", true);
    const t = el("ai-cfg-temp");
    if (t && t.value !== "") ac.temperature = Math.max(0, Math.min(1.5, parseFloat(t.value) || 0.7));
    const am = Object.assign({}, (Store.getSettings().agentModels) || {});
    am.reviewer = Object.assign({}, am.reviewer || {}, { enabled: g("ai-cfg-reviewer", false) });
    Store.updateSettings({ agentCfg: ac, agentModels: am });
  }
  function syncAiEmo() {
    const n = el("ai-emo-cur");
    if (n) n.textContent = _getEmotion() || "全部";
  }
  function renderAiOffHint() {
    const body = el("ai-body");
    if (body) body.innerHTML = '<div class="ai-tip">AI 未开启：请在设置里配置 API（Provider / Base / Key）。<button type="button" class="m-ins" data-ai-goto-settings>去设置</button></div>';
  }

  // 从选区运行 AI 任务（浮动卡片路径）或换说法
  function runAiFromSelection(task) {
    const ed = _ta();
    const s0 = ed.selectionStart, s1 = ed.selectionEnd;
    _hideSelToolbar();
    if (s1 <= s0) { toast("请先选中文字"); return; }
    if (task === "replace") { _doReplace(); return; }
    if (!LLM.enabled()) { toast("AI 未开启：点齿轮按钮在设置里配置"); return; }
    const sel = ed.value.slice(s0, s1);
    const ctxLimit = parseInt(Store.getSettings().ctxLimit || 0, 10) || 0;
    const before = ed.value.slice(0, s0);
    const limitCtx = (s) => {
      const t = String(s || "");
      if (ctxLimit > 0 && t.length > ctxLimit) return "（上下文较长，已截取最近 " + ctxLimit + " 字）\n" + t.slice(-ctxLimit);
      return t;
    };
    const label = { polish: "润色当前句", expand: "扩写当前段", rewrite: "重写全段" }[task];
    const range = { start: s0, end: s1 };
    const kindBtn = document.querySelector("#seg-kind button.active");
    const kindCode = kindBtn ? kindBtn.getAttribute("data-kind") || "" : "";
    const ctx = {
      context: limitCtx(before.slice(-800)), sel,
      emotion: _getEmotion(), kind: kindCode,
      keywords: readAiKeywords()
    };
    aiRange = range;
    aiLastRun = { task, label, ctx, range };
    aiLastCtx = { context: ctx.context, sel, target: sel };
    aiLastKeywords = ctx.keywords;
    startFloatingAi(task, label, ctx, range);
  }

  /* ================= 浮动结果卡片（方案 B） ================= */

  function positionFloating() {
    const card = el("ai-float");
    if (!card || !card.classList.contains("on")) return;
    const wr = el("editor-wrap");
    // 定位到 AI 面板打开前记录的目标附近：贴选区上方/下方
    let top = parseFloat(card.style.top);
    if (isNaN(top)) { top = Math.max(4, wr.clientHeight - card.offsetHeight - 24); card.style.top = top + "px"; }
    const left = Math.max(2, Math.min(wr.clientWidth - card.offsetWidth - 4, (wr.clientWidth - card.offsetWidth) / 2));
    card.style.left = left + "px";
    card.style.maxHeight = Math.max(120, wr.clientHeight - 60) + "px";
  }
  function showFloating() {
    const card = el("ai-float");
    if (!card) return;
    card.classList.add("on");
    floatingOn = true;
    _hideSelToolbar();
    positionFloating();
    setTimeout(positionFloating, 0);
  }
  function closeFloating() {
    if (floatingStream) { floatingStream.abort(); floatingStream = null; }
    floatingOn = false;
    const card = el("ai-float");
    if (card) card.classList.remove("on");
  }
  async function startFloatingAi(task, label, ctx, range) {
    if (floatingStream) floatingStream.abort();
    const ctrl = new AbortController();
    floatingStream = ctrl;
    const card = el("ai-float"), body = el("af-body"), foot = el("af-foot");
    if (!card) return;
    el("af-title").textContent = label + (_getEmotion() ? " · " + _getEmotion() : "");
    const dtail = el("af-detail");
    if (dtail) dtail.classList.add("off");   // 流式中禁用「详情」
    body.innerHTML = '<div class="af-live">AI 写作中…<span class="af-cancel" data-af-cancel>取消</span></div>';
    if (foot) foot.textContent = "";
    showFloating();
    const writeConf = Agent.agentConf("writer");
    const ap = writeConf ? LLM.providerById(writeConf.providerId, writeConf.model) : LLM.activeProvider();
    const opts = {
      stream: !!(ap && ap.stream), signal: ctrl.signal,
      onLog: () => {}, onDelta: (t) => { const n = body.querySelector(".af-live"); if (n) { const c = n.querySelector("[data-af-cancel]"); n.textContent = ""; if (c) n.appendChild(c); n.prepend(document.createTextNode(t)); } }
    };
    try {
      const res = await Agent.run(task, ctx, opts);
      renderFloatResult(res, label, range);
    } catch (err) {
      if (err && err.name === "AbortError") { closeFloating(); return; }
      body.innerHTML = '<div class="ai-tip">AI 失败：' + esc(err.message) + '</div>';
      if (dtail) dtail.classList.remove("off");
    } finally { floatingStream = null; }
  }
  function renderFloatResult(res, label, range) {
    const body = el("af-body");
    if (!res || !res.versions || !res.versions.length) {
      body.innerHTML = '<div class="ai-tip">AI 没有产出内容，换一组关键词或情绪试试</div>';
      return;
    }
    const btn = (label === "润色当前句" || label === "重写全段") ? "替换" : "插入";
    body.innerHTML = '<div class="af-acts-row">' + (res.versions.length > 1 ? '<button type="button" class="sec-btn ai-mini" data-af-ins-all title="按顺序全部插入到光标处">全部插入</button>' : "") + '</div>' +
    res.versions.map((v, i) =>
      '<div class="af-item"><span class="af-text">' + esc(v) + '</span>' +
      '<div class="af-acts">' +
        '<button class="m-ins" data-af-ins="' + i + '">' + btn + '</button>' +
        '<button class="sec-btn ai-mini" data-af-copy="' + i + '" title="复制此版">复制</button>' +
        '<button class="sec-btn ai-mini" data-af-regen="' + i + '" title="按同样任务重新生成">重做</button>' +
        '<button class="sec-btn danger ai-mini" data-af-del="' + i + '" title="删除此版">删</button>' +
      '</div></div>'
    ).join("");
    const foot = el("af-foot");
    if (foot) {
      const hits = res.prevHits || [];
      foot.innerHTML = (res.count ? res.count + " 条素材" : "") +
        (res.count && hits.length ? " · " : "") + (hits.length ? hits.length + " 段前文" : "") +
        '<span class="af-detail" data-af-detail>详情</span>';
    }
    const dtail = el("af-detail");
    if (dtail) dtail.classList.remove("off");
    aiResultTexts = res.versions.slice();
    aiKwChips = (res.plan || []).map(x => x.kw);
    pushAiHistory(res, label, range, "float");
    positionFloating();
  }
  // 浮动卡里的版本操作
  function floatVersionAction(act, i) {
    const body = el("af-body");
    if (!body) return;
    const btns = body.querySelectorAll(".af-item");
    if (!btns[i]) return;
    if (act === "del") {
      if (!confirm("删除该版本？")) return;
      aiResultTexts.splice(i, 1);
      const h = aiHistory[0];
      if (h && h.versions && h.versions[i] != null) { h.versions = h.versions.slice(); h.versions.splice(i, 1); saveAiHistory(); }
      const items = body.querySelectorAll(".af-item");
      const cur = items[i];
      if (cur) cur.remove();
      if (body.querySelectorAll(".af-item").length === 0) body.innerHTML = '<div class="ai-tip">已删空所有版本，重新选择任务试试</div>';
      toast("已删除该版本");
      return;
    }
    if (act === "copy") { copyText(aiResultTexts[i]); toast("已复制第 " + (i + 1) + " 版"); return; }
    if (act === "ins" && aiLastRun) { _insertText(aiResultTexts[i], aiLastRun.range); closeFloating(); }
    if (act === "regen" && aiLastRun) startFloatingAi(aiLastRun.task, aiLastRun.label, aiLastRun.ctx, aiLastRun.range);
  }
  // 历史入栈（面板与浮动卡共用）
  function pushAiHistory(res, label, range, source) {
    aiHistory.unshift({
      id: Date.now().toString(36),
      label, emotion: _getEmotion(), ts: Date.now(),
      versions: res.versions.slice(),
      range: range ? { start: range.start, end: range.end } : null,
      materials: res.materials || "",
      count: res.count || 0,
      log: (res.log || []).slice(),
      keywords: aiLastKeywords,
      kwList: aiKwChips.slice(),
      prevHits: (res.prevHits || []).slice(),
      context: (aiLastCtx && aiLastCtx.context) || "",
      sel: (aiLastCtx && aiLastCtx.sel) || "",
      loreChars: res.loreChars || [],
      loreSets: res.loreSets || [],
      source: source || ""
    });
    if (aiHistory.length > AI_HISTORY_MAX) aiHistory.length = AI_HISTORY_MAX;
    renderAiHistory();
    saveAiHistory();
  }
  // 面板「目标选区」常驻块
  function aiTargetHtml() {
    const c = aiLastCtx;
    const t = (c && (c.sel || c.target)) || "";
    if (!t) return "";
    return '<div class="ai-target"><span class="ai-target-label">目标' + (c && c.sel ? "（选区）" : "（光标处）") + '</span><div class="ai-target-text">' + esc(String(t).slice(0, 400)) + '</div></div>';
  }

  // 前文命中 钉选 / 排除（settings libPins / libBlocks，重做后生效）
  function toggleLibPin(keyStr) {
    const sp = String(keyStr || "").split("|");
    const id = sp[0], i = +sp[1];
    if (!id || i == null) return;
    const s = Store.getSettings();
    const pins = (s.libPins || []).slice();
    const idx = pins.findIndex(p => p.id === id && p.i === i);
    if (idx >= 0) pins.splice(idx, 1); else pins.push({ id, i });
    Store.updateSettings({ libPins: pins });
    toast(idx >= 0 ? "已取消钉住" : "已钉住「重做」后强制注入该段");
    if (aiCurRender) renderVersionsWithMat(el("ai-body"), aiCurRender.versions, aiCurRender.range, aiCurRender.btn, aiCurRender.materials, aiCurRender.count, aiCurRender.extra, aiCurRender.hist);
  }
  function toggleLibBlock(keyStr) {
    const sp = String(keyStr || "").split("|");
    const id = sp[0], i = +sp[1];
    if (!id || i == null) return;
    const s = Store.getSettings();
    const blocks = (s.libBlocks || []).slice();
    const idx = blocks.findIndex(b => b.id === id && b.i === i);
    if (idx >= 0) blocks.splice(idx, 1); else blocks.push({ id, i });
    Store.updateSettings({ libBlocks: blocks });
    toast(idx >= 0 ? "已恢复该段" : "已排除该段（重做后不再返回）");
  }

  // AI 历史持久化（IndexedDB meta）
  function saveAiHistory() {
    if (window.Store && Store.setMeta) Store.setMeta("ai-history", aiHistory.slice(0, AI_HISTORY_MAX)).catch(() => {});
  }
  function loadAiHistory() {
    if (!(window.Store && Store.getMeta)) return;
    Store.getMeta("ai-history").then(arr => {
      if (Array.isArray(arr) && arr.length) { aiHistory = arr.slice(0, AI_HISTORY_MAX); renderAiHistory(); }
    }).catch(() => {});
  }

  function runAiTask(task) {
    if (!LLM.enabled()) { toast("AI 未开启：点齿轮按钮在设置里配置"); return; }
    const ed = _ta();
    const caret = ed.selectionStart;
    const before = ed.value.slice(0, caret);
    const kindBtn = document.querySelector("#seg-kind button.active");
    const kindCode = kindBtn ? kindBtn.getAttribute("data-kind") || "" : "";
    // 上下文长度上限（字，0=不限）；超出时取最近 N 字并在上下文里注明
    const ctxLimit = parseInt(Store.getSettings().ctxLimit || 0, 10) || 0;
    const limitCtx = (s) => {
      const t = String(s || "");
      if (ctxLimit > 0 && t.length > ctxLimit) return "（上下文较长，已截取最近 " + ctxLimit + " 字）\n" + t.slice(-ctxLimit);
      return t;
    };

    let label, ctx, range;
    const custom = Agent.customAgentById(task);
    if (custom) {
      // 自定义 Agent：有选区改写选区，否则续写在光标处
      label = custom.name || "自定义 Agent";
      if (ed.selectionEnd > ed.selectionStart) {
        const s0 = ed.selectionStart, s1 = ed.selectionEnd;
        range = { start: s0, end: s1 };
        ctx = { context: limitCtx(ed.value.slice(0, s0).slice(-800)), sel: ed.value.slice(s0, s1) };
      } else {
        range = { start: caret, end: caret };
        ctx = { context: limitCtx(before) };
      }
    } else if (task === "polish") {
      const sent = _lastSentence(before);
      if (!sent) { toast("光标放在要润色的句子末尾"); return; }
      const sentStart = before.lastIndexOf(sent);
      range = { start: sentStart >= 0 ? sentStart : caret - sent.length, end: caret };
      const prev = before.match(/([^。！？\n]*[。！？][^。！？\n]*[。！？][^。！？\n]*)$/);
      ctx = { context: limitCtx((prev ? prev[1] : "") + sent), sel: sent };
      label = "润色当前句";
    } else if (task === "continue") {
      range = { start: caret, end: caret };
      ctx = { context: limitCtx(before) };
      label = "续写下一段";
    } else if (task === "expand") {
      const para = _lastParagraph(before);
      const sent = _lastSentence(before);
      if (!para) { toast("没有可扩写的内容"); return; }
      const sentStart = before.lastIndexOf(sent);
      range = { start: sentStart >= 0 ? sentStart : caret - sent.length, end: caret };
      ctx = { context: limitCtx(para), sel: sent };
      label = "扩写当前段";
    } else {
      const para = _lastParagraph(before);
      if (!para) { toast("没有可重写的内容"); return; }
      const pStart = before.lastIndexOf(para);
      range = { start: pStart >= 0 ? pStart : before.length - para.length, end: caret };
      ctx = { context: limitCtx(para), sel: para };
      label = "重写全段";
    }
    ctx.emotion = _getEmotion();
    ctx.kind = kindCode;
    ctx.keywords = readAiKeywords();
    aiRange = range;
    aiLastRun = { task, label, ctx, range };
    aiLastCtx = { context: ctx.context, sel: ctx.sel, target: ctx.sel || _lastParagraph(before) };
    aiLastKeywords = ctx.keywords;
    startAgent(task, label, ctx, range);
  }

  function readAiKeywords() {
    const n = el("ai-keywords");
    return n ? n.value.trim() : "";
  }

  async function startAgent(task, label, ctx, range) {
    openAiTab();
    _renderAiMenuModels();
    // 写作子 Agent 的模型：绑定优先，否则当前默认（模型跟随 Agent）
    const writeConf = Agent.agentConf("writer");
    const ap = writeConf ? LLM.providerById(writeConf.providerId, writeConf.model) : LLM.activeProvider();
    el("ai-title").textContent = label + (_getEmotion() ? " · " + _getEmotion() : "") +
      (ap ? " · " + (ap.name || "") + (ap.model ? " · " + ap.model : "") : "");
    el("ai-log").innerHTML = "";
    el("ai-body").innerHTML = aiTargetHtml() + '<div class="ai-item ai-live">AI 写作中…</div>';
    aiResultTexts = [];
    if (aiStreamCtrl) aiStreamCtrl.abort();
    const ctrl = new AbortController();
    aiStreamCtrl = ctrl;
    const liveNode = () => el("ai-panel").querySelector(".ai-item.ai-live");
    const opts = {
      stream: !!(ap && ap.stream),
      signal: ctrl.signal,
      onLog: appendAiLog,
      onDelta: (t) => { const n = liveNode(); if (n) n.textContent = t; }
    };
    try {
      const res = await Agent.run(task, ctx, opts);
      renderAiResult(res, label, range);
    } catch (err) {
      if (err && err.name === "AbortError") { closeAiTab(); return; }
      el("ai-body").innerHTML = '<div class="ai-tip">AI 失败：' + esc(err.message) + '</div>';
    } finally {
      aiStreamCtrl = null;
    }
  }

  function appendAiLog(m) {
    const log = el("ai-log");
    if (!log) return;
    const d = document.createElement("div");
    d.className = "ai-log-line";
    d.textContent = m;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function renderAiResult(res, label, range) {
    const body = el("ai-body");
    if (!res || !res.versions || !res.versions.length) {
      body.innerHTML = aiTargetHtml() + '<div class="ai-tip">AI 没有产出内容，换一组关键词或情绪试试</div>';
      return;
    }
    const btn = (label === "润色当前句" || label === "重写全段") ? "替换" : "插入";
    aiKwChips = (res.plan || []).map(x => x.kw);
    const extra = {
      prevHits: res.prevHits || [],
      context: (aiLastCtx && aiLastCtx.context) || "",
      sel: (aiLastCtx && aiLastCtx.sel) || "",
      target: (aiLastCtx && (aiLastCtx.sel || aiLastCtx.target)) || "",
      keywords: aiLastKeywords, kwList: aiKwChips.slice(),
      loreChars: res.loreChars || [], loreSets: res.loreSets || []
    };
    renderVersionsWithMat(body, res.versions, range, btn, res.materials, res.count, extra, false);
    aiResultTexts = res.versions.slice();
    pushAiHistory(res, label, range, "panel");
  }

  // 版本列表 + 目标 + 关键词 + 素材 + 前文命中 + 上下文预览，单次 innerHTML
  // extra: { prevHits, context, sel, target, keywords, kwList, loreChars, loreSets }；hist=true 是历史回看（隐藏「重新生成」）
  function renderVersionsWithMat(body, versions, range, btn, materials, count, extra, hist) {
    aiCurRender = { versions: versions.slice(), range, btn, materials, count, extra: Object.assign({}, extra), hist: !!hist };
    const ex = aiCurRender.extra;
    const targetBlock = (ex && ex.target) ? aiTargetHtml() : "";
    const kwBlock = (ex && ex.kwList && ex.kwList.length)
      ? '<div class="ai-kwbar" data-ai-kwbar>本次关键词：' + ex.kwList.map((k, i) =>
          '<span class="ai-kwchip">' + esc(k) + '<button type="button" class="rel-x" data-ai-kwdel="' + i + '" title="移除关键词">×</button></span>').join("") +
          '<button type="button" class="sec-btn ai-mini" data-ai-kwrun title="按这些关键词重新生成">按这些词重跑</button></div>'
      : "";
    const loreBlock = (ex && (ex.loreChars && ex.loreChars.length) + (ex.loreSets && ex.loreSets.length) > 0)
      ? '<div class="ai-lore-line">注入：<span class="dim">' +
        (ex.loreChars && ex.loreChars.length ? '角色 ' + esc(ex.loreChars.join("、")) : "") +
        ((ex.loreChars && ex.loreChars.length) && (ex.loreSets && ex.loreSets.length) ? " · " : "") +
        (ex.loreSets && ex.loreSets.length ? '设定 ' + esc(ex.loreSets.join("、")) : "") +
        '</span></div>'
      : "";
    const hitBlock = (ex && ex.prevHits && ex.prevHits.length)
      ? '<div class="ai-prev"><button class="ai-mat-toggle" data-ai-prev>' + ex.prevHits.length + ' 段前文命中（点开查看）</button>' +
        '<div class="ai-mat-body">' + ex.prevHits.map(h => {
          const key = h.id + "::" + h.i;
          const pins = (Store.getSettings().libPins || []).map(p => p.id + "::" + p.i);
          const pinned = pins.indexOf(key) >= 0;
          return '<div class="ai-prev-hit"><span class="ai-prev-title">【' + esc(h.title || "未命名") + '】</span>' +
            (h.id != null ? '<span class="ai-prev-ops">' +
              '<button type="button" class="m-ins' + (pinned ? " on" : "") + '" data-ai-pin="' + esc(h.id + "|" + h.i) + '" title="钉住后每次重做强制注入该段">' + (pinned ? "📌已钉" : "📌钉住") + '</button>' +
              '<button type="button" class="m-del" data-ai-block="' + esc(h.id + "|" + h.i) + '" title="以后检索不再返回该段">排除</button>' +
              '<button type="button" class="m-del" data-ai-prev-off="' + esc(h.id) + '" title="该章不再参与前文检索">忽略此章</button>' +
            '</span>' : "") +
            '<div class="ai-prev-text">' + esc(h.text || "") + '</div></div>';
        }).join("") + '</div></div>'
      : "";
    const ctxBlock = (ex && (ex.context || ex.sel))
      ? '<div class="ai-prev"><button class="ai-mat-toggle" data-ai-ctx>' + (ex.sel ? "选区 + 上下文" : "上下文") + '（点开查看本次发给 AI 的内容）</button>' +
        '<div class="ai-mat-body ai-ctx-body"><div class="ai-ctx-label">选区</div><div class="ai-ctx-text">' + esc(ex.sel || "（无选区）") + '</div>' +
        (ex.keywords ? '<div class="ai-ctx-label">关键词</div><div class="ai-ctx-text">' + esc(ex.keywords) + '</div>' : "") +
        '<div class="ai-ctx-label">上下文</div><div class="ai-ctx-text">' + esc(ex.context || "") + '</div></div></div>'
      : "";
    body.innerHTML = targetBlock + kwBlock + (versions.length > 1
      ? '<div class="ai-acts-row"><button type="button" class="sec-btn ai-mini" data-ai-ins-all title="按顺序全部插入到光标处">全部插入</button></div>'
      : "") + versions.map((v, i) =>
      '<div class="ai-item"><span class="ai-text">' + esc(v) + '</span>' +
      '<div class="ai-acts">' +
        '<button class="m-ins" data-ai-ins="' + i + '" data-ai-start="' + (range ? range.start : "") + '" data-ai-end="' + (range ? range.end : "") + '">' + btn + '</button>' +
        '<button class="sec-btn ai-mini" data-ai-copy="' + i + '" title="复制此版">复制</button>' +
        (hist ? "" : '<button class="sec-btn ai-mini" data-ai-regen="' + i + '" title="按同样任务重新生成">重做</button>') +
        '<button class="sec-btn danger ai-mini" data-ai-del="' + i + '" title="删除此版">删</button>' +
      '</div></div>'
    ).join("") +
      (materials
        ? '<div class="ai-mat"><button class="ai-mat-toggle" data-ai-mat>' + (count || 0) + ' 条素材（点开看本次用词）</button>' +
          '<div class="ai-mat-body">' + esc(materials) + '</div></div>'
        : "") + hitBlock + loreBlock + ctxBlock;
  }

  function renderAiKwbar() {
    const bar = document.querySelector("[data-ai-kwbar]");
    if (!bar || !aiCurRender) return;
    const kws = aiCurRender.extra.kwList || [];
    bar.innerHTML = '本次关键词：' + kws.map((k, i) =>
      '<span class="ai-kwchip">' + esc(k) + '<button type="button" class="rel-x" data-ai-kwdel="' + i + '" title="移除关键词">×</button></span>').join("") +
      (kws.length ? '<button type="button" class="sec-btn ai-mini" data-ai-kwrun title="按这些关键词重新生成">按这些词重跑</button>' : "");
  }

  // 删除某个版本（从当前结果 + 最近一条历史同步移除）
  function delAiVersion(i) {
    if (!aiCurRender) return;
    const v = aiCurRender.versions[i];
    if (v == null) return;
    if (!confirm("删除该版本？")) return;
    aiCurRender.versions.splice(i, 1);
    aiResultTexts = aiCurRender.versions.slice();
    if (!aiCurRender.hist && aiHistory.length && aiHistory[0].versions) {
      aiHistory[0].versions = aiHistory[0].versions.slice();
      if (aiHistory[0].versions[i] != null) aiHistory[0].versions.splice(i, 1);
    }
    if (!aiCurRender.versions.length) {
      el("ai-body").innerHTML = '<div class="ai-tip">已删空所有版本，重新选择任务试试</div>';
      return;
    }
    renderVersionsWithMat(el("ai-body"), aiCurRender.versions, aiCurRender.range, aiCurRender.btn, aiCurRender.materials, aiCurRender.count, aiCurRender.extra, aiCurRender.hist);
    saveAiHistory();
    toast("已删除该版本");
  }

  function renderAiHistory() {
    const wrap = el("ai-history");
    if (!wrap) return;
    if (!aiHistory.length) { wrap.innerHTML = '<div class="ai-tip dim">还没有运行记录</div>'; return; }
    // UX-09：任务类型下拉按历史实际出现的 label 动态生成（含自定义 Agent 名）
    const ts = el("ai-hist-type");
    if (ts) {
      const labels = Array.from(new Set(aiHistory.map(h => h.label)));
      if (aiHistType && labels.indexOf(aiHistType) < 0) aiHistType = "";
      ts.innerHTML = '<option value="">全部任务</option>' + labels.map(l => '<option value="' + esc(l) + '"' + (l === aiHistType ? " selected" : "") + '>' + esc(l) + '</option>').join("");
    }
    const kw = aiHistKw.trim();
    const list = aiHistory.filter(h =>
      (!aiHistType || h.label === aiHistType) &&
      (!kw || (h.label + " " + (h.emotion || "") + " " + (h.keywords || "")).indexOf(kw) >= 0)
    );
    if (!list.length) { wrap.innerHTML = '<div class="ai-tip dim">没有匹配的历史</div>'; return; }
    wrap.innerHTML = list.map(h => {
      const idx = aiHistory.indexOf(h);
      return '<div class="ai-hist-item" data-ai-hist="' + idx + '">' +
        '<span class="ai-hist-label">' + esc(h.label) + (h.emotion ? " · " + esc(h.emotion) : "") + '</span>' +
        '<span class="ai-hist-meta dim">' + new Date(h.ts).toLocaleTimeString() + '</span>' +
      '</div>';
    }).join("");
  }
  function setHistType(v) { aiHistType = v || ""; renderAiHistory(); }
  function setHistKw(v) { aiHistKw = v || ""; renderAiHistory(); }

  function viewAiHistory(i) {
    const h = aiHistory[i];
    if (!h) return;
    const body = el("ai-body");
    const btn = (h.label === "润色当前句" || h.label === "重写全段") ? "替换" : "插入";
    const extra = {
      prevHits: h.prevHits || [], context: h.context || "", sel: h.sel || "",
      target: h.sel || "", keywords: h.keywords || "", kwList: h.kwList || [],
      loreChars: h.loreChars || [], loreSets: h.loreSets || []
    };
    renderVersionsWithMat(body, h.versions, h.range, btn, h.materials, h.count, extra, true);
    aiResultTexts = h.versions.slice();
    el("ai-title").textContent = h.label + (h.emotion ? " · " + h.emotion : "") + "（历史）";
    renderAiHistory();
    const items = document.querySelectorAll("#ai-history .ai-hist-item");
    if (items[i]) items[i].classList.add("cur");
  }

  function clearAiHistory() {
    if (aiHistory.length && !confirm("清空全部 AI 历史？")) return;
    aiHistory = [];
    aiResultTexts = [];
    const body = el("ai-body");
    if (body) body.innerHTML = "";
    renderAiHistory();
    saveAiHistory();
    toast("AI 历史已清空");
  }

  function insertVersion(idx, range) {
    const text = aiResultTexts[idx];
    if (text != null) _insertText(text, range || aiRange);
  }
  // F-02：全部版本按顺序插入（第一版替换选区/光标，其余在末尾追加）
  function insertAll() {
    const texts = aiResultTexts;
    if (!texts.length) return;
    const ed = _ta();
    const base = aiLastRun && aiLastRun.range;
    let start, end;
    if (base) { start = base.start; end = base.end; }
    else { start = ed.selectionStart; end = ed.selectionEnd; }
    let cursor = end;
    _insertText(texts[0], { start, end });
    cursor = start + texts[0].length;
    for (let i = 1; i < texts.length; i++) {
      _insertText("\n\n" + texts[i], { start: cursor, end: cursor });
      cursor += 2 + texts[i].length;
    }
    toast("已全部插入 " + texts.length + " 版");
    if (floatingOn) closeFloating();
  }
  function copyVersion(idx) {
    const text = aiResultTexts[idx];
    if (text != null) { copyText(text); toast("已复制第 " + (idx + 1) + " 版"); }
  }
  function kwDel(idx) {
    if (aiCurRender && aiCurRender.extra && aiCurRender.extra.kwList && aiCurRender.extra.kwList[idx] != null) {
      aiCurRender.extra.kwList.splice(idx, 1);
      renderAiKwbar();
    }
  }
  function kwRun() {
    const kws = (aiCurRender && aiCurRender.extra && aiCurRender.extra.kwList) || [];
    if (kws.length && aiLastRun) {
      const n = document.getElementById("ai-keywords");
      if (n) n.value = kws.join(", ");
      const ctx = Object.assign({}, aiLastRun.ctx, { keywords: kws.join(", ") });
      aiLastRun.ctx = ctx;
      aiLastCtx = { context: ctx.context, sel: ctx.sel, target: ctx.sel || "" };
      aiLastKeywords = ctx.keywords;
      startAgent(aiLastRun.task, aiLastRun.label, ctx, aiLastRun.range);
    }
  }

  return {
    openAiTab, closeAiTab, toggleAiTab, renderAiTasks,
    runAiTask, runAiFromSelection, startAgent, readAiKeywords,
    startFloatingAi, closeFloating, isFloating: () => floatingOn,
    regen: () => { if (aiLastRun) startAgent(aiLastRun.task, aiLastRun.label, aiLastRun.ctx, aiLastRun.range); },
    floatAction: floatVersionAction,
    cancelFloat: () => { if (floatingStream) { floatingStream.abort(); floatingStream = null; } },
    openDetail: () => { closeFloating(); openAiTab(); if (aiHistory.length) viewAiHistory(0); },
    insertVersion, copyVersion, kwDel, kwRun, toggleLibPin, toggleLibBlock,
    delAiVersion, viewAiHistory, clearAiHistory, loadAiHistory, syncAiEmo, syncAiCfgFromUI,
    setHistType, setHistKw, insertAll,
    getResultTexts: () => aiResultTexts, getRange: () => aiRange
  };
})();
if (typeof window !== "undefined") window.EditorAi = EditorAi;
if (typeof globalThis !== "undefined") globalThis.EditorAi = EditorAi;
if (typeof module !== "undefined" && module.exports) module.exports = EditorAi;
