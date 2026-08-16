"use strict";
/* agent.js — AI 深度辅助写作编排（主 Agent + 多子 Agent 架构）。
   主 Agent（编排 orchestrator）决定流程与重试；子 Agent 各自独立调用、模型跟随 Agent（Trae 式）：
     planner(规划)  → searcher(检索，本地) → material(素材整理，本地/LLM辅助) → writer(写作，流式) → reviewer(审校，可选)
   每个子 Agent 的模型在设置里单独绑定（agentModels），未绑定则跟随当前默认；自定义 Agent 由用户新建（customAgents）。 */

const Agent = (function () {

  const TYPE_MAP = { "小动作": "action", "小神态": "expression", "情绪": "emotion", "动作": "action", "神态": "expression", "词汇": "" };
  const ALLOW_TYPE = ["小动作", "小神态", "情绪", "词汇"];
  const MAX_MATERIAL = 5000;   // 检索素材预算（字符）
  const RAW_MAX = 12000;       // 素材整理 LLM 模式的候选预算（字符）
  const MAX_WRITE_TOKENS = 1200;   // 写作阶段输出上限（规划/改写用默认 400）
  const MAX_LORE = 4000;       // 角色卡+设定 全量注入预算（字符）
  const MAX_PREV = 3200;       // 前文情节预算（字符）
  const COMBINED_MAX = 11000;  // 角色/设定 + 素材 + 前文 合并预算；超限按优先级砍（前文 → 素材 → 角色/设定）
  const PER_WORD = 18, PER_GLOSS = 48, PER_EX = 56, PER_ANTI = 36, PER_GOLDEN = 72;

  // 内置 Agent 定义
  const AGENT_DEFS = {
    planner:  { name: "规划", desc: "分析任务与上下文，决定检索关键词与写作要点" },
    material: { name: "素材整理", desc: "去重 / 排序 / 精选素材（本地或 LLM 辅助）" },
    writer:   { name: "写作", desc: "结合素材 / 设定 / 前文，自主选材产出正文" },
    reviewer: { name: "审校", desc: "复核正文：去 AI 味 / 连贯 / 与设定一致" }
  };

  function cut(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function wordOf(e) {
    if (e.tag === "fav") return e.text || "";
    return e.word || (e.terms && e.terms[0]) || "";
  }
  // 共享状态读取（AppState 由 library/BankLoader 写入；Node 测试下可为 null 兜底）
  function appState() {
    const st = (typeof globalThis !== "undefined" && globalThis.AppState) || null;
    return st ? st.get() : null;
  }
  // buildLore 全字段打分缓存（角色/设定数据在 lore:changed 时才变化；按对象身份缓存，避免每轮全字段扫描）
  let loreFieldCache = new WeakMap();
  function fieldStringsOf(it) {
    let c = loreFieldCache.get(it);
    if (!c) {
      const texts = [];
      const skip = new Set(["id", "type", "user", "src", "name", "category", "extra"]);
      for (const [k, v] of Object.entries(it || {})) {
        if (skip.has(k)) continue;
        if (typeof v === "string" && v) texts.push(v);
      }
      for (const v of Object.values((it && it.extra) || {})) if (typeof v === "string" && v) texts.push(v);
      c = { texts };
      loreFieldCache.set(it, c);
    }
    return c.texts;
  }
  if (typeof globalThis !== "undefined" && globalThis.Bus) {
    Bus.on("lore:changed", () => { loreFieldCache = new WeakMap(); });
  }

  /* ---------- 模型跟随 Agent ---------- */

  // 某子 Agent 的模型 conf：绑定优先，否则 null（跟随当前默认）
  function agentConf(agentId) {
    const s = Store.getSettings();
    const am = (s && s.agentModels) || {};
    const b = am[agentId];
    if (b && b.providerId && Store.getProviders && Store.getProviders()[b.providerId]) {
      return { providerId: b.providerId, model: b.model || "" };
    }
    return null;
  }
  function materialMode() {
    const s = Store.getSettings();
    const m = (s && s.agentModels && s.agentModels.material) || {};
    return m.mode === "llm" ? "llm" : "local";
  }
  function reviewerEnabled() {
    const s = Store.getSettings();
    const r = (s && s.agentModels && s.agentModels.reviewer) || {};
    return !!r.enabled;
  }
  // 自定义 Agent
  function customAgents() {
    const s = Store.getSettings();
    return (s && s.customAgents) || [];
  }
  function customAgentById(id) {
    return customAgents().find(a => a.id === id && a.enabled !== false) || null;
  }

  /* ---------- 素材格式化 ---------- */

  function fmtEntry(e) {
    if (e.type === "golden") {
      return "[黄金句·" + cut(e.book || "风格参考", 8) + "] " + cut(e.original, PER_GOLDEN);
    }
    if (e.tag === "fav") return "[常用] " + cut(e.text, 40);
    const tag = Banks.catLabel(e.category) || e.category || "词库";
    let line = "[" + tag + "] " + cut(wordOf(e), PER_WORD);
    if (e.gloss) line += " — " + cut(e.gloss, PER_GLOSS);
    if (e.example) line += "（例：" + cut(e.example, PER_EX) + "）";
    if (e.antiAI) line += " ⚠" + cut(e.antiAI, PER_ANTI);
    return line;
  }

  // 检索一个关键词（词库 + 常用词句，黄金句作风格参考），按类型/情绪过滤
  function searchOne(kw, type, emotion, limit) {
    const out = [];
    const seen = new Set();
    const push = (e) => {
      const w = e.type === "golden" ? e.original : wordOf(e);
      if (!w || seen.has(w)) return;
      seen.add(w);
      out.push(e);
    };
    const stype = TYPE_MAP[type] || "";
    for (const e of Suggest.searchAll(kw, { limit: limit || 8, type: stype })) push(e);
    if (emotion) {
      for (const e of Suggest.byEmotion(emotion, { limit: limit || 8, type: stype })) push(e);
    }
    return out.slice(0, limit || 10);
  }

  // 按计划逐词检索 + 去重 + 预算截断；返回 { text, raw, log, count }
  function buildMaterial(plan, emotion) {
    const lines = [];
    const log = [];
    const used = new Set();
    let count = 0;
    for (const item of plan || []) {
      const entries = searchOne(item.kw, item.type, emotion, 8).filter(e => {
        const w = e.type === "golden" ? e.original : wordOf(e);
        if (!w || used.has(w)) return false;
        used.add(w);
        return true;
      });
      if (entries.length) {
        log.push("🔍 搜索「" + item.kw + "」" + (item.type ? "（" + item.type + "）" : "") + " 命中 " + entries.length + " 条");
        for (const e of entries) lines.push(fmtEntry(e));
        count += entries.length;
      } else {
        log.push("🔍 搜索「" + item.kw + "」 无结果");
      }
    }
    let text = "";
    for (const l of lines) {
      if (text.length + l.length + 1 > MAX_MATERIAL) break;
      text += l + "\n";
    }
    // 未截断的候选（供素材整理 LLM 模式精选）
    let raw = "";
    for (const l of lines) {
      if (raw.length + l.length + 1 > RAW_MAX) break;
      raw += l + "\n";
    }
    return { text: text.trim(), raw: raw.trim(), log, count };
  }

  // 素材整理 LLM 模式：把候选素材 + 任务/上下文/情绪 交给 LLM 精选排序
  async function materialLlmSelect(mat, label, context, emotion, conf, opts) {
    if (!mat.raw) return mat;
    const sys = "你是素材整理助手。根据任务、上下文与当前情绪，从候选素材里挑选最贴合、最多样化的词条，保持原文格式原样输出，不要改写、不要加解释、不要序号。";
    const user = "任务：" + label +
      "\n上下文：\n" + cut(context, 1500) +
      "\n当前情绪：" + (emotion || "无指定") +
      "\n\n候选素材（每行一条）：\n" + mat.raw +
      "\n\n只输出选中的素材行，每行一条，保持原格式；都不合适就输出（无）。";
    let out = "";
    try {
      out = await LLM.chat([
        { role: "system", content: sys },
        { role: "user", content: user }
      ], { temperature: 0.2, signal: opts.signal, timeout: opts.timeout, max_tokens: 800 }, conf);
    } catch (e) {
      return Object.assign({}, mat, { log: [].concat(mat.log, ["⚠ 素材整理 LLM 失败，回退本地结果"]) });
    }
    const lines = String(out || "").split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== "（无）");
    if (!lines.length) return Object.assign({}, mat, { log: [].concat(mat.log, ["⚠ 素材整理 LLM 未返回有效素材，用本地结果"]) });
    return {
      text: lines.join("\n"), raw: mat.raw,
      log: [].concat(mat.log, ["已用 LLM 精选素材 " + lines.length + " 条"]),
      count: lines.length
    };
  }

  /* ---------- 规划解析 ---------- */

  function parsePlan(text) {
    const t = String(text || "");
    let arr = null;
    const m = t.match(/\[[\s\S]*?\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch (e) { arr = null; } }
    if (!arr || !Array.isArray(arr)) {
      // 行式兜底：剥前缀后按分隔符拆词
      arr = t.split(/\r?\n/).map(line => {
        const l = String(line || "").replace(/^(?:关键词|词条|搜索)[：:]?\s*/, "").trim();
        if (!l) return [];
        return l.split(/[、，,;；\s]+/).map(s => s.trim())
          .filter(s => s.length >= 2 && s.length <= 12)
          .map(s => ({ kw: s.slice(0, 20), type: "" }));
      }).flat();
    }
    return arr
      .filter(x => x && typeof x.kw === "string" && x.kw.trim() && x.kw.trim().length <= 20)
      .slice(0, 5)
      .map(x => ({ kw: x.kw.trim(), type: ALLOW_TYPE.includes(String(x.type || "").trim()) ? String(x.type).trim() : "" }));
  }

  // 规划解析失败时的兜底：情绪 + 上下文尾部
  function autoPlan(context, emotion) {
    const kws = [];
    if (emotion) kws.push({ kw: emotion, type: "情绪" });
    const tail = String(context || "").replace(/\s+/g, "").slice(-30)
      .replace(/[。！？，、,.;；:：""''「」『』（）()]/g, " ");
    for (const s of tail.split(/\s+/).map(x => x.trim()).filter(x => x.length >= 2).slice(-3)) {
      kws.push({ kw: s.slice(0, 8), type: "" });
    }
    if (!kws.length) kws.push({ kw: "紧张", type: "情绪" });
    return kws.slice(0, 4);
  }

  /* ---------- 角色卡 + 设定（按相关度选卡注入） ---------- */

  // 按关键词/上下文给每张卡打分：名字/别名精确匹配权重高，字段内容包含加分，名字出现在上下文中额外加分。
  // 返回 { text, charCount, setCount, trimmed, charNames, setNames }，charNames/setNames 是实际注入的卡名（供面板展示信任依据）。
  function buildLore(prevPlan, context) {
    const bd = appState() || { characters: [], settings: [] };
    const chars = (bd.characters || []).filter(Boolean);
    const sets = (bd.settings || []).filter(Boolean);
    const kws = (prevPlan || []).map(x => String((x && x.kw) || "").replace(/\s+/g, "")).filter(k => k.length >= 2);
    const text = String(context || "").replace(/\s+/g, "");
    const splitNames = (s) => String(s || "").split(/[\/、，,]/).map(x => x.trim()).filter(Boolean);
    const fieldStrings = fieldStringsOf;   // 缓存版全字段（含 extra）

    const scoreText = (fields, kw) => (fields || []).some(f => f && f.includes(kw));
    const scoreChar = (c) => {
      let s = 0;
      const names = [c.name].concat(splitNames(c.aliases));
      for (const kw of kws) {
        if (c.name === kw) s += 30;
        else if (c.name && c.name.includes(kw)) s += 16;
        if (names.some(n => n === kw)) s += 22;
        else if (names.some(n => n.includes(kw))) s += 10;
        if (fieldStrings(c).some(f => f.includes(kw))) s += 3;
      }
      if (c.name && text.includes(c.name)) s += 20;
      if (names.some(n => n.length >= 2 && text.includes(n))) s += 12;
      return s;
    };
    const scoreSet = (st) => {
      let s = 0;
      for (const kw of kws) {
        if (st.name === kw) s += 30;
        else if (st.name && st.name.includes(kw)) s += 16;
        if (fieldStrings(st).some(f => f.includes(kw))) s += 3;
      }
      if (st.name && text.includes(st.name)) s += 20;
      return s;
    };

    const charsScored = chars.map(c => ({ e: c, s: scoreChar(c) }));
    const setsScored = sets.map(st => ({ e: st, s: scoreSet(st) }));
    // 排序：得分>0 优先（按分），得分 0 的保底（按原顺序）——保证无匹配时仍全量注入
    const ranked = (arr) => arr.filter(x => x.s > 0).sort((a, b) => b.s - a.s)
      .concat(arr.filter(x => x.s === 0));

    let charLines = [];
    const charNamesIn = [];
    for (const { e: c } of ranked(charsScored)) {
      const bits = [];
      if (c.aliases) bits.push("别名：" + cut(c.aliases, 40));
      if (c.gender) bits.push(c.gender);
      if (c.appearance) bits.push("外貌：" + cut(c.appearance, 60));
      if (c.personality) bits.push("性格：" + cut(c.personality, 50));
      if (c.habits) bits.push("习惯：" + cut(c.habits, 40));
      if (c.relationships) bits.push("关系：" + cut(c.relationships, 50));
      if (c.state) bits.push("当前：" + cut(c.state, 40));
      if (c.hooks) bits.push("钩子：" + cut(c.hooks, 40));
      charLines.push("■ " + (c.name || "未命名") + (bits.length ? "｜" + bits.join("｜") : ""));
      if (c.extra) {
        for (const val of Object.values(c.extra)) if (typeof val === "string" && val) bits.push(cut(val, 40));
        charLines[charLines.length - 1] = "■ " + (c.name || "未命名") + (bits.length ? "｜" + bits.join("｜") : "");
      }
      charNamesIn.push(c.name || "未命名");
    }
    let setLines = [];
    const setNamesIn = [];
    const SET_SKIP = new Set(["id", "type", "user", "src", "name", "category", "description", "related", "rules", "notes", "extra"]);
    for (const { e: st } of ranked(setsScored)) {
      const bits = [];
      if (st.description) bits.push(cut(st.description, 90));
      if (st.related) bits.push("相关：" + cut(st.related, 40));
      if (st.rules) bits.push("规则：" + cut(st.rules, 50));
      for (const [k, v] of Object.entries(st)) {
        if (SET_SKIP.has(k) || typeof v !== "string" || !v) continue;
        bits.push(cut(v, 60));
      }
      for (const v of Object.values(st.extra || {})) if (typeof v === "string" && v) bits.push(cut(v, 50));
      setLines.push("■ " + (st.name || "未命名") + (st.category ? "（" + st.category + "）" : "") + (bits.length ? "：" + bits.join("；") : ""));
      setNamesIn.push(st.name || "未命名");
    }
    const header = "【本作角色卡】（人物设定为权威：外貌/性格/称呼/关系/当前状态必须与此一致，禁止另造矛盾设定）";
    const sheader = "【本作设定词条】（专有名词/世界观按此定义沿用，不得更改）";
    const charPart = charLines.length ? header + "\n" + charLines.join("\n") : "";
    const setPart = setLines.length ? sheader + "\n" + setLines.join("\n") : "";
    const combined = [charPart, setPart].filter(Boolean).join("\n\n");
    let text2 = combined;
    let trimmed = false;
    let finalCharNames = charNamesIn;
    let finalSetNames = setNamesIn;
    if (combined.length > MAX_LORE) {
      trimmed = true;
      if (charPart.length <= MAX_LORE) {
        // 角色卡可全留：砍掉设定部分
        text2 = charPart;
        finalSetNames = [];
      } else {
        // 角色卡也超预算：按行裁到预算内，设定整块砍掉
        const keep = [];
        const keptNames = [];
        let len = header.length;
        for (let i = 0; i < charLines.length; i++) {
          const ln = charLines[i];
          if (len + ln.length + 1 > MAX_LORE) break;
          keep.push(ln); len += ln.length + 1;
          keptNames.push(charNamesIn[i]);
        }
        text2 = header + "\n" + keep.join("\n");
        finalCharNames = keptNames;
        finalSetNames = [];
      }
    }
    return {
      text: text2, charCount: finalCharNames.length, setCount: finalSetNames.length, trimmed,
      charNames: finalCharNames, setNames: finalSetNames
    };
  }

  /* ---------- 前文（跨章节检索） ---------- */

  // 从关键词（plan）在 window.LibIndex 里做候选定位（稀有 bigram 并集），只对候选段打分。
  // opts.pins / opts.blocks = [{id,i}] 章id+段下标：pins 强制注入（优先占额度）、blocks 过滤。
  // 无索引时回退全量扫描（与旧逻辑一致，测试/直开模式兼容）。返回 hits 供面板展示与「忽略此章」。
  function buildPrev(plan, context, limit, opts) {
    opts = opts || {};
    const bd = appState() || { chapters: [], index: null };
    const chapters = (bd.chapters || []).filter(c => c && c.text);
    if (!chapters.length || !limit) return { text: "", used: 0, log: null, hits: [] };
    const segKey = (s) => s.id + "::" + s.i;
    const pins = new Set((opts.pins || []).map(p => p.id + "::" + p.i));
    const blocks = new Set((opts.blocks || []).map(b => b.id + "::" + b.i));
    const idx = bd.index || null;
    const ctxTail = String(context || "").replace(/\s+/g, "").slice(-80);
    const ctxClean = ctxTail.replace(/[。！？，、,.;；:：""''「」『』（）()]/g, "").slice(-20);

    let segs;
    if (idx && idx.segs && idx.segs.length) {
      segs = idx.segs;
    } else {
      segs = [];
      for (const ch of chapters) {
        const paras = String(ch.text || "").split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length >= 10);
        paras.forEach((p, i) => segs.push({ id: ch.id, title: ch.title || "未命名", active: ch.active !== false, i, text: p }));
      }
    }

    // 候选定位：各关键词（及上下文尾部）取最稀有 bigram 的条目集合并集 → 只扫这些段
    let pool = null;
    if (idx) {
      const cands = new Set();
      const kwList = (plan || []).map(x => String((x && x.kw) || "").replace(/\s+/g, "")).filter(k => k.length >= 2);
      const rarest = (s) => {
        let best = null;
        for (let i = 0; i < s.length - 1; i++) {
          const set = idx.bigram.get(s.slice(i, i + 2));
          if (set && (!best || set.size < best.size)) best = set;
        }
        return best;
      };
      for (const k of kwList) { const b = rarest(k); if (b) for (const v of b) cands.add(v); }
      if (ctxClean.length >= 2) { const b = rarest(ctxClean); if (b) for (const v of b) cands.add(v); }
      if (cands.size) {
        pool = [];
        for (const i of cands) { const s = segs[i]; if (s && s.active !== false) pool.push(s); }
      }
    }
    if (!pool) pool = segs.filter(s => s.active !== false);

    const scored = pool.map(sg => {
      let score = 0;
      const clean = sg.text.replace(/\s+/g, "");
      for (const item of plan || []) {
        const k = String((item && item.kw) || "").replace(/\s+/g, "");
        if (!k) continue;
        if (clean.includes(k)) score += 4;
        else {
          let hit = 0;
          for (let i = 0; i < k.length - 1; i++) if (clean.includes(k.slice(i, i + 2))) hit++;
          score += hit * 0.5;
        }
      }
      if (ctxTail) score += Diff.similarity(ctxTail, clean.slice(0, 120)) * 5;
      return { sg, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // 钉选段（未被排除）优先注入，按钉选顺序；其余按得分取满 limit
    const pinned = [];
    for (const s of segs) {
      const k = segKey(s);
      if (pins.has(k) && !blocks.has(k) && s.active !== false) { pinned.push(s); }
    }
    const picked = [];
    const used = new Set();
    for (const s of pinned) { used.add(segKey(s)); picked.push(s); if (picked.length >= limit) break; }
    if (picked.length < limit) {
      for (const { sg, score } of scored) {
        if (score <= 0) continue;
        const k = segKey(sg);
        if (used.has(k) || blocks.has(k)) continue;
        used.add(k); picked.push(sg);
        if (picked.length >= limit) break;
      }
    }
    const text = picked.map(x => "【" + x.title + "】" + cut(x.text, 260)).join("\n");
    return {
      text,
      used: picked.length,
      hits: picked.map(x => ({ id: x.id, i: x.i, title: x.title, text: cut(x.text, 260) })),
      log: picked.length ? "已从前文库检索到 " + picked.length + " 段相关前文情节" : "前文检索无命中"
    };
  }

  // 手动关键词：逗号 / 顿号 / 空格 分隔
  function parseKeywords(s) {
    return String(s || "").split(/[、，,;；\s]+/).map(x => x.trim())
      .filter(x => x.length >= 2 && x.length <= 20).slice(0, 8)
      .map(kw => ({ kw: kw.slice(0, 20), type: "" }));
  }

  // 设定名当关键词：把上下文/选区中出现的角色名（含别名）与设定名并入前文检索词；
  // 命中设定时，其「相关角色/词条」引用名也一并并入（跨章节线索）。
  function enrichPlanWithLore(plan, context, sel) {
    const out = (plan || []).slice();
    const have = new Set(out.map(x => x.kw));
    const bd = appState() || { characters: [], settings: [] };
    const chars = (bd.characters || []).filter(Boolean);
    const sets = (bd.settings || []).filter(Boolean);
    const text = String(context || "") + "\n" + String(sel || "");
    const add = (kw) => {
      const k = String(kw || "").replace(/\s+/g, "").trim();
      if (!k || k.length < 2 || have.has(k)) return;
      have.add(k);
      out.push({ kw: k.slice(0, 20), type: "" });
    };
    const seenInText = [];
    for (const c of chars) {
      const names = [c.name].concat(String(c.aliases || "").split(/[\/、，,]/).map(s => s.trim()).filter(Boolean)).filter(Boolean);
      for (const n of names) if (n.length >= 2 && text.includes(n)) seenInText.push(n);
    }
    for (const s of sets) { if (s.name && s.name.length >= 2 && text.includes(s.name)) seenInText.push(s.name); }
    for (const n of seenInText) add(n);
    // 命中设定 → 其 related 引用名无条件并入（只要长度达标）
    const nameOf = {};
    for (const c of chars) { const names = [c.name].concat(String(c.aliases || "").split(/[\/、，,]/).map(s => s.trim()).filter(Boolean)); for (const n of names) nameOf[n] = "char"; }
    for (const s of sets) nameOf[s.name] = "setting";
    for (const item of out.slice()) {
      if (nameOf[item.kw] !== "setting") continue;
      const s = sets.find(x => x.name === item.kw);
      if (!s) continue;
      // 相关词条 + 模板 chip 字段（主要成员/人物/关键人物）一起作为跨章节线索
      const refs = [s.related, s.members, s.figures].filter(Boolean).join("/");
      for (const r of String(refs).split(/[\/、，,]/).map(x => x.trim()).filter(x => x.length >= 2)) add(r);
    }
    return out.slice(0, 10);
  }

  // 按预算行级截断（用于合并预算降级，砍的是低优先级块）
  function fitBlock(text, budget) {
    const lines = String(text || "").split("\n");
    const keep = [];
    let len = 0;
    for (const l of lines) {
      if (len + l.length + 1 > budget) break;
      keep.push(l); len += l.length + 1;
    }
    return keep.join("\n");
  }

  const TASK_LABEL = { polish: "润色当前句", continue: "续写下一段", expand: "扩写当前段", rewrite: "重写全段" };

  function baseSys() {
    const note = (Store.getSettings().agentCfg && Store.getSettings().agentCfg.systemNote) || "";
    return "你是资深网文写作助手，服务于反AI写作工作台。你写真实、有画面、有人味的小说正文：多写身体反应、小动作、具体景物与对话，少用抽象情绪词和 AI 套话。词句库素材来自真实网文提炼，是可信素材，优先选用。" +
      (note ? "\n\n用户写作偏好 / 额外要求（必须遵守）：\n" + note : "");
  }
  // 自定义 Agent 的系统提示词：用户角色定义 + 全局偏好
  function customSys(custom) {
    const note = (Store.getSettings().agentCfg && Store.getSettings().agentCfg.systemNote) || "";
    return (custom.systemPrompt || "你是资深网文写作助手。") +
      (note ? "\n\n用户写作偏好 / 额外要求（必须遵守）：\n" + note : "");
  }
  function planPrompt(task, context, emotion, kind, extra) {
    return "任务：" + task +
      "\n上下文（光标/选中处之前的内容）：\n" + context +
      "\n当前情绪：" + (emotion || "无指定") +
      "\n写作类型：" + (kind || "全部") +
      (extra ? "\n\n注意：" + extra : "") +
      "\n\n请判断写好这段最需要哪些词句库素材，输出 2-4 个搜索关键词及其目标类型。只输出一个 JSON 数组，不要任何其他文字。格式：[{\"kw\":\"眼眶发酸\",\"type\":\"小神态\"},{\"kw\":\"僵住\",\"type\":\"小动作\"}]。type 只允许：小动作 / 小神态 / 情绪 / 词汇（不确定就填词汇）。";
  }
  function writePrompt(taskKey, label, context, emotion, kind, material, sel, lore, prev, taskNote) {
    return "任务：" + label +
      "\n上下文：\n" + context +
      (sel ? "\n要改写/扩写的目标：\n" + sel : "") +
      "\n当前情绪：" + (emotion || "无指定") +
      "\n写作类型：" + (kind || "全部") +
      (lore ? "\n\n" + lore + "\n" : "") +
      (prev ? "\n\n【前文情节】（来自前文章节，注意回调/伏笔/已建立事实，保持情节连续一致）\n" + prev : "") +
      "\n\n已检索到的词句库素材（真实词库，请自主选材）：\n" + (material || "（未检索到合适素材，请凭写作功底完成，不要编造词库词条）") +
      "\n\n要求：\n" +
      "1. 自主选材：从素材中挑选最贴合当前情绪/情节的词条自然融入正文，宁缺毋滥，不要罗列堆砌。\n" +
      "2. 标注 ⚠ 的词条是反AI禁用表达，必须先改写去掉 AI 味再用。\n" +
      "3. 【黄金句】仅供风格参考，不得整句照搬。\n" +
      "4. 用身体反应/小动作/白描替代抽象情绪词，避免“仿佛/不禁/与此同时/心中涌起”等 AI 套话。\n" +
      "5. 只输出正文。" +
      (taskNote ? "\n\n本任务额外要求：\n" + taskNote : "") +
      ((taskKey === "polish" || taskKey === "rewrite")
        ? "给出 2-3 个改写版本，版本之间用空行分隔，不加序号。"
        : "给出 1-2 段可直接接续的正文，段落间用空行分隔。");
  }
  function reviewMsgs(full, label, emotion) {
    return [
      { role: "system", content: "你是审校编辑。复核下面的正文：去掉 AI 味（“仿佛/不禁/与此同时/心中涌起”等套话）、补足身体反应与白描、检查与前文设定一致性。直接输出修订后的正文全文；若无须改动则原样输出正文。不要加任何评论、标题或版本序号。" },
      { role: "user", content: "任务：" + label + "\n当前情绪：" + (emotion || "无指定") + "\n\n正文：\n" + cut(full, 4000) }
    ];
  }

  /* ---------- 主入口 ---------- */

  async function run(task, ctx, opts) {
    opts = opts || {};
    const context = (ctx && ctx.context) || "";
    const emotion = (ctx && ctx.emotion) || "";
    const kind = (ctx && ctx.kind) || "";
    const sel = (ctx && ctx.sel) || "";
    const log = [];
    const logLine = (m) => { log.push(m); if (opts.onLog) opts.onLog(m); };
    const s = Store.getSettings();
    const agentCfg = s.agentCfg || {};
    const custom = customAgentById(task);
    const isCustom = !!custom;
    const tLabel = custom ? (custom.name || "自定义 Agent") : (TASK_LABEL[task] || task);

    // 目标 Provider/模型：legacy 路由覆盖优先 → 自定义 Agent 自身绑定 → 子 Agent 绑定 → 跟随默认
    const routeOverride = (opts.route && opts.route.providerId) ? { providerId: opts.route.providerId, model: opts.route.model || "" } : null;
    const customConf = (isCustom && custom.providerId && Store.getProviders() && Store.getProviders()[custom.providerId])
      ? { providerId: custom.providerId, model: custom.model || "" }
      : null;
    const phaseConf = (agentId) => routeOverride || customConf || agentConf(agentId);
    if (!LLM.enabled() && !(routeOverride && LLM.confEnabled(LLM.providerById(routeOverride.providerId, routeOverride.model)))) {
      throw new Error("AI 未开启：请先在设置里配置");
    }

    // 行为开关：自定义 Agent 用自身定义，否则用全局 agentCfg
    const useMaterial = isCustom ? custom.useMaterial !== false : agentCfg.useMaterial;
    const useLore = isCustom ? custom.useLore !== false : (agentCfg.useLore !== false);
    const usePrev = isCustom ? custom.usePrev !== false : (agentCfg.usePrev !== false);
    const useReview = reviewerEnabled();

    // Phase 1+2：规划 + 检索（手动关键词直接跳过规划；直接写模式跳过规划，用上下文自动提取）
    const manualKw = (ctx && ctx.keywords) ? String(ctx.keywords).trim() : "";
    let plan = [], mat = { text: "", raw: "", log: [], count: 0 };
    if (useMaterial || usePrev) {
      if (manualKw) {
        plan = parseKeywords(manualKw);
        if (plan.length) logLine("使用手动关键词：" + plan.map(x => x.kw).join("、"));
        else { plan = autoPlan(context, emotion); logLine("手动关键词无效，改用上下文自动提取"); }
      } else if (isCustom && custom.pipeline === false) {
        plan = autoPlan(context, emotion);
        logLine("直接写模式：从上下文自动提取关键词");
      } else {
        const rounds = (useMaterial && agentCfg.autoResearch !== false) ? 2 : 1;
        for (let round = 0; round < rounds; round++) {
          logLine("思考需要哪些素材…");
          const planMsg = await LLM.chat([
            { role: "system", content: isCustom ? customSys(custom) : baseSys() },
            { role: "user", content: planPrompt(tLabel, context, emotion, kind, round === 1 ? "上一轮检索到的素材偏少，请换一批更精准的关键词。" : "") }
          ], { temperature: 0.3, signal: opts.signal, timeout: opts.timeout }, phaseConf("planner"));
          plan = parsePlan(planMsg);
          if (!plan.length) {
            logLine("未识别到关键词，改用上下文自动提取");
            plan = autoPlan(context, emotion);
          }
          if (useMaterial) {
            mat = buildMaterial(plan, emotion);
            mat.log.forEach(logLine);
            if (mat.count >= 3) break;
            logLine("素材偏少，补充一轮搜索…");
          }
        }
      }
      // 素材整理 LLM 模式（可选）：本地检索后再让 LLM 精选
      if (useMaterial && materialMode() === "llm" && mat.raw) {
        mat = await materialLlmSelect(mat, tLabel, context, emotion, phaseConf("material"), opts);
        mat.log.forEach(logLine);
      }
    }

    // 前文检索关键词增强：并入上下文中出现的角色名/设定名及命中设定的 related 引用
    const prevPlan = enrichPlanWithLore(plan, context, sel);
    if (prevPlan.length > plan.length) {
      logLine("已并入设定/角色名关键词 " + (prevPlan.length - plan.length) + " 个");
    }

    // 角色卡/设定按相关度注入
    let lore = { text: "", charCount: 0, setCount: 0, charNames: [], setNames: [] };
    if (useLore) {
      lore = buildLore(prevPlan, context);
      if (lore.text) logLine("已注入角色卡 " + lore.charCount + " 条 · 设定 " + lore.setCount + " 条" + (lore.trimmed ? "（超预算已裁减）" : ""));
    }
    // 前文跨章节检索
    const libSegs = (usePrev === false) ? 0 : Math.max(0, Math.min(10, parseInt(s.libSegs, 10) || 0));
    let prev = { text: "", used: 0, hits: [] };
    if (libSegs > 0) {
      prev = buildPrev(prevPlan, context, libSegs, { pins: s.libPins || [], blocks: s.libBlocks || [] });
      if (prev.log) logLine(prev.log);
      if (prev.text.length > MAX_PREV) { prev.text = fitBlock(prev.text, MAX_PREV); }
    }
    // 合并预算降级：角色/设定 > 素材 > 前文
    let combined = (lore.text || "").length + (mat.text || "").length + (prev.text || "").length;
    if (combined > COMBINED_MAX && prev.text) {
      prev.text = fitBlock(prev.text, Math.max(0, COMBINED_MAX - (lore.text || "").length - (mat.text || "").length));
      logLine("总预算超限，已裁减前文情节");
    }
    logLine("结合素材写作…");
    const temp = isCustom ? (custom.temperature != null ? custom.temperature : 0.7) : (agentCfg.temperature != null ? agentCfg.temperature : 0.7);
    const mwt = isCustom ? (custom.maxTokens || MAX_WRITE_TOKENS) : (agentCfg.maxWriteTokens || MAX_WRITE_TOKENS);
    const taskNote = (isCustom || !agentCfg.taskNotes) ? "" : (agentCfg.taskNotes[task] || "");
    const writeConf = phaseConf("writer");
    const msgs = [
      { role: "system", content: isCustom ? customSys(custom) : baseSys() },
      { role: "user", content: writePrompt(task, tLabel, context, emotion, kind, mat.text, sel, lore.text, prev.text, taskNote) }
    ];
    let full;
    if (opts.stream) {
      full = await LLM.streamChat(msgs, { signal: opts.signal, onDelta: opts.onDelta, timeout: opts.timeout, max_tokens: mwt, temperature: temp }, writeConf);
    } else {
      full = await LLM.chat(msgs, { signal: opts.signal, timeout: opts.timeout, max_tokens: mwt, temperature: temp }, writeConf);
    }

    // 审校（可选）：复核出稿
    if (useReview && full) {
      logLine("审校复核…");
      const revConf = phaseConf("reviewer");
      try {
        const rev = await LLM.chat(reviewMsgs(full, tLabel, emotion), {
          signal: opts.signal, timeout: opts.timeout, max_tokens: mwt, temperature: 0.4
        }, revConf);
        if (rev && String(rev).trim()) full = String(rev).trim();
        logLine("审校完成");
      } catch (e) {
        logLine("⚠ 审校失败，沿用写作结果：" + (e && e.message || e));
      }
    }

    if (!full || !String(full).trim()) logLine("⚠ AI 返回为空：请检查 Provider 的流式设置 / 模型 / 额度");

    return {
      text: full, versions: LLM.splitVersions(full), log, plan, materials: mat.text, count: mat.count,
      prevHits: prev.hits || [],
      loreChars: lore.charNames || [], loreSets: lore.setNames || []
    };
  }

  return {
    run, parsePlan, parseKeywords, buildMaterial, autoPlan, fmtEntry, searchOne,
    buildPrev, buildLore, enrichPlanWithLore,
    agentConf, customAgents, customAgentById, materialMode, reviewerEnabled,
    AGENT_DEFS, TASK_LABEL
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Agent;
if (typeof globalThis !== "undefined") globalThis.Agent = Agent;
