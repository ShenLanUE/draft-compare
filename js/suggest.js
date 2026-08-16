"use strict";
/* suggest.js — 建议引擎。
   对已载入的词库/黄金句/常用词句做检索：
   - searchAll(q)        @ 全局搜索
   - byEmotion(emo,cfg)  情绪筛选候选
   - replacements(sel)   选区「换一种说法」
   - emotionOptions()    情绪选择器选项（从词库标签动态生成） */

const Suggest = (function () {

  let lex = [];     // lexicon entries
  let gold = [];    // golden entries
  let anti = [];    // anti rules (emotionReplace 用)
  let favs = [];    // 常用词句（纯文本行）
  let emotionList = [];
  let built = false;
  let bigramIndex = null;   // 二元词组倒排索引：bigram → Set(词库/黄金句条目)，加速 @ 与 agent 检索

  function reset() { lex = []; gold = []; anti = []; favs = []; emotionList = []; bigramIndex = null; built = false; }
  function setData(l, g, a, f) { lex = l || []; gold = g || []; anti = a || []; favs = (f || []).map(x => ({ text: x, tag: "fav" })); built = true; rebuildEmotions(); rebuildIndex(); }
  function setFavs(f) { favs = (f || []).map(x => ({ text: x, tag: "fav" })); }
  function getCounts() { return { lex: lex.length, gold: gold.length, anti: anti.length, fav: favs.length }; }
  function hasData() { return built; }

  /* ---------- 检索索引（二元组倒排，支持子串命中） ---------- */

  function rebuildIndex() {
    bigramIndex = new Map();
    const add = (e, text) => {
      const s = String(text || "").replace(/\s+/g, "");
      if (s.length < 2) return;
      for (let i = 0; i < s.length - 1; i++) {
        const bg = s.slice(i, i + 2);
        let set = bigramIndex.get(bg);
        if (!set) { set = new Set(); bigramIndex.set(bg, set); }
        set.add(e);
      }
    };
    for (const e of lex) { if (e.word) add(e, e.word); for (const t of (e.terms || [])) add(e, t); }
    for (const g of gold) add(g, g.original);
  }
  // 取查询词覆盖的候选集（选命中条目最少的二元组，缩小扫描范围）；查询 <2 字或未建索引返回 null → 全量扫描
  function candidatesFor(q) {
    if (!bigramIndex || q.length < 2) return null;
    const s = q.trim();
    let best = null;
    for (let i = 0; i < s.length - 1; i++) {
      const set = bigramIndex.get(s.slice(i, i + 2));
      if (set && (!best || set.size < best.size)) best = set;
    }
    return best;
  }

  /* ---------- 情绪选项 ---------- */

  const EMO_FILES = /micro-action|micro-expression|emotion|romance|action-body/;
  const EMO_REJECT = /模拟|末日|破烂|核弹|儒仙|仙桃|灰太狼|部落|法师|仙族|种族|恋爱|词典|辞典|补充|通用|对话|场景|系统|——|提炼|补强|质量|判断|扩充|词汇池|去重|附录|部分|分类|语态|语气|神态|动作|心理|思考|斗法|修真|景物|设定|机制|建设|发展|权谋|身形|气质|面容|发型|称呼|示例|参考|正反|大纲|序列|概况|库$|化$|式$|^[一二三四五六七八九十]+[、. ]/;
  function normEmo(t) {
    let s = String(t).replace(/[（(][^）)]*[）)]/g, "").trim();
    s = s.replace(/^[#>\s]+/, "").replace(/\[[^\]]*\]/g, "").trim();
    s = s.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]+\s*/, "").trim();
    s = s.replace(/^\d+\s*/, "").trim();
    s = s.replace(/[·•｜|、].*$/, "").trim();
    return s;
  }
  function rebuildEmotions() {
    const count = {};
    for (const e of lex) {
      if (!e.isEmo || !EMO_FILES.test(e.category)) continue;
      const last = e.tags[e.tags.length - 1];
      if (!last) continue;
      const n = normEmo(last);
      if (!n || n.length > 4 || n.length < 2 || EMO_REJECT.test(n)) continue;
      count[n] = (count[n] || 0) + 1;
    }
    emotionList = Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, 40);
  }
  function emotionOptions() {
    if (!emotionList.length) rebuildEmotions();
    return emotionList;
  }

  // 条目是否命中某情绪（标签包含 或 释义/例句含）
  function emoHit(e, emo) {
    if (!emo) return true;
    for (const t of e.tags) {
      const n = normEmo(t);
      if (n === emo) return true;
      if (n && (n.includes(emo) || emo.includes(n))) return true;
    }
    if (e.gloss && e.gloss.includes(emo)) return true;
    return false;
  }

  /* ---------- 类型过滤 ---------- */

  function typeMatches(e, type) {
    if (!type) return true;
    const cat = e.category || "";
    if (type === "action") return /micro-action|action-body|figure-posture/.test(cat);
    if (type === "expression") return /micro-expression|expression/.test(cat);
    if (type === "emotion") return /emotion|romance/.test(cat);
    if (type === "appearance") return /appearance|attire/.test(cat);
    if (type === "scene") return /environment/.test(cat);
    if (type === "fight") return /battle|xianxia|system-flow/.test(cat);
    if (type === "dialogue") return /dialogue|romance/.test(cat);
    return true;
  }

  /* ---------- 关键词命中 ---------- */

  function kwHit(e, q) {
    if (!q) return true;
    for (const t of (e.terms || [])) if (t.includes(q) || q.includes(t)) return true;
    if (e.word && (e.word.includes(q) || q.includes(e.word))) return true;
    if (e.gloss && e.gloss.includes(q)) return true;
    if (e.example && e.example.includes(q)) return true;
    if (e.hint && e.hint.includes(q)) return true;
    if (Banks.catLabel(e.category) && Banks.catLabel(e.category).includes(q)) return true;  // 按分类中文名（小动作/小神态…）搜
    if (e.category && e.category.includes(q)) return true;
    return false;
  }

  /* ---------- 排序 ---------- */

  function score(e, q, emo, type) {
    let s = 0;
    if (emo && emoHit(e, emo)) s += 8;
    if (type && typeMatches(e, type)) s += 4;
    if (q) {
      for (const t of (e.terms || [])) {
        if (t === q) { s += 30; break; }
        if (t.startsWith(q)) { s += 20; break; }
        if (t.includes(q)) { s += 12; break; }
      }
      if (e.word && e.word.includes(q)) s += 6;
      if (e.gloss && e.gloss.includes(q)) s += 3;
      if (e.hint && e.hint.includes(q)) s += 1;
      if (e.type === "golden" && e.original && e.original.includes(q)) s += 5;
      // 按分类中文名命中（小动作/小神态…）给较高权重
      if (Banks.catLabel(e.category) && Banks.catLabel(e.category).includes(q)) s += 10;
      else if (e.category && e.category.includes(q)) s += 8;
    }
    // 常用词句始终加权；黄金句仅在有关键词时加权（否则会挤掉可插入的词条）
    if (e.type === "golden" && q) s += 2;
    if (e.tag === "fav") s += 5;
    return s;
  }

  /* ---------- 对外查询 ---------- */

  // @ 全局搜索：词库 + 黄金句 + 常用词句
  function searchAll(q, opts) {
    opts = opts || {};
    const res = [];
    const emo = opts.emotion || "";
    const type = opts.type || "";
    const cands = candidatesFor(q);   // 二元组倒排候选集（词库+黄金句混合）；无则全量扫描
    const lexPool = cands ? Array.from(cands).filter(e => e.type !== "golden") : lex;
    for (const e of lexPool) {
      if (!kwHit(e, q)) continue;
      if (emo && !emoHit(e, emo)) continue;
      if (type && !typeMatches(e, type)) continue;
      res.push({ e, s: score(e, q, emo, type) });
    }
    for (const f of favs) {
      if (!q || f.text.includes(q) || q.includes(f.text)) {
        res.push({ e: { type: "fav", tag: "fav", word: f.text, terms: [f.text], gloss: "我的常用词句", category: "fav" }, s: 20 + (f.text.includes(q) ? 5 : 0) });
      }
    }
    const goldPool = cands ? Array.from(cands).filter(e => e.type === "golden") : gold;
    for (const g of goldPool) {
      if (q && !(g.original && g.original.includes(q)) && !(g.why && g.why.includes(q))) continue;
      if (emo && !emoHit(g, emo)) continue;
      if (type && !typeMatches(g, type)) continue;
      res.push({ e: g, s: score(g, q, emo, type) });
    }
    res.sort((a, b) => b.s - a.s);
    return res.slice(0, opts.limit || 50).map(r => r.e);
  }

  // 情绪候选（「接下来可接」）：小动作/小神态/词汇
  function byEmotion(emo, opts) {
    opts = opts || {};
    const res = [];
    for (const e of lex) {
      if (!emoHit(e, emo)) continue;
      if (opts.type && !typeMatches(e, opts.type)) continue;
      res.push({ e, s: score(e, "", emo, opts.type) });
    }
    res.sort((a, b) => b.s - a.s);
    return res.slice(0, opts.limit || 30).map(r => r.e);
  }

  // 选区「换一种说法」
  function replacements(sel, opts) {
    opts = opts || {};
    const q = String(sel || "").trim();
    const out = [];
    if (!q) return out;
    // 1) 反AI情绪外化表：命中情绪词 → 直接给替换
    for (const r of anti) {
      if (r.level === "emotionReplace" && r.emotion && (q.includes(r.emotion) || r.emotion.includes(q) || q === r.emotion)) {
        out.push({ text: r.replacement, kind: "replacement", src: "反AI情绪外化" });
      }
    }
    // 2) 词库相似检索（复用 diff 相似度）
    const seen = new Set();
    for (const e of lex) {
      const cands = [e.word, e.example, e.gloss].filter(Boolean);
      for (const c of cands) {
        if (c.length < 2 || c === q) continue;
        const sim = Diff.similarity(q, c.slice(0, Math.min(c.length, q.length + 12)));
        if (sim >= (opts.threshold || 0.28) && !seen.has(e.word)) {
          seen.add(e.word);
          out.push({ text: e.word, example: e.example, gloss: e.gloss, hint: e.hint, kind: "lexicon", category: e.category });
          break;
        }
      }
      if (out.length >= 12) break;
    }
    return out.slice(0, opts.limit || 12);
  }

  return {
    reset, setData, setFavs, getCounts, hasData,
    emotionOptions, byEmotion, searchAll, replacements, emoHit
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Suggest;
if (typeof globalThis !== "undefined") globalThis.Suggest = Suggest;
