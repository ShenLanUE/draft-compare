"use strict";
/* lint.js — 反AI实时检查 + 重复用词。
   规则来源：
   - 反AI规则库（T1/T2/T3/语境敏感/情绪外化）——数据驱动，改 md 重导入即生效
   - 词库 ⚠ 频率规则（单章≤N 次等）——自动提取
   - 结构化句式正则（PATTERNS）——人工维护的小量配置（见文件底部） */

const Lint = (function () {

  // 最毒句式 → error 级；其余 T1 → warn 级（避免"感到/似乎"刷屏）
  const TOXIC = [
    "仿佛", "犹如", "宛若", "如同", "瞳孔一缩", "身体一僵", "倒吸一口凉气", "呼吸一滞",
    "嘴角勾起一抹", "眼中闪过一丝", "与此同时", "不禁", "不由得", "不由自主",
    "总而言之", "综上所述", "毫无疑问", "显而易见", "不容置疑", "毋庸置疑",
    "内心深处", "此时的他还不知道", "故事还在继续"
  ];

  let compiled = null;

  function compile(antiRules, freqRules) {
    const t1 = [], t2 = [], ctx = [], emoRep = [], pats = [];
    const t1Seen = new Set();
    for (const r of antiRules || []) {
      if (r.level === "T1") {
        for (const t of r.terms || []) {
          if (!t || t1Seen.has(t)) continue;
          t1Seen.add(t);
          t1.push({ term: t, replacement: r.replacement || "" });
        }
      } else if (r.level === "T2") {
        for (const t of r.terms || []) {
          if (t) t2.push({ term: t });
        }
      } else if (r.level === "ctx") {
        ctx.push(r);
      } else if (r.level === "emotionReplace") {
        emoRep.push(r);
      } else if (r.level === "pattern") {
        // 表驱动句式暂不转正则，保留文本备用
      }
    }
    // 词库 ⚠ 频率规则 + 禁词
    const freq = [];
    const banned = [];
    for (const f of freqRules || []) {
      if (f.terms && f.terms.length) freq.push(f);
      for (const bp of f.bannedPhrases || []) {
        if (!t1Seen.has(bp)) { t1Seen.add(bp); banned.push({ term: bp, replacement: "参考词库⚠说明改写" }); }
      }
    }
    compiled = { t1, t2, ctx, emoRep, pats, freq, banned };
    return compiled;
  }

  function offsetsOf(text) {
    const lines = [];
    let off = 0;
    for (const seg of text.split("\n")) {
      lines.push({ off, len: seg.length });
      off += seg.length + 1;
    }
    return lines;
  }
  function lineCol(lines, off) {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid].off <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: off - lines[lo].off + 1 };
  }

  function parasOf(text) {
    // 段落 = 空行分隔；单段内再按句切分
    const out = [];
    let cur = "", curStart = 0, idx = 0;
    for (const seg of text.split("\n")) {
      if (seg.trim() === "") { if (cur.trim()) out.push({ text: cur, start: curStart }); cur = ""; }
      else { if (!cur) curStart = idx; cur += seg; }
      idx += seg.length + 1;
    }
    if (cur.trim()) out.push({ text: cur, start: curStart });
    return out;
  }

  function findOffsets(text, term, from) {
    const res = [];
    let i = from || 0;
    while ((i = text.indexOf(term, i)) !== -1) { res.push(i); i += term.length; }
    return res;
  }

  function scan(text) {
    if (!compiled) return [];
    const doc = String(text || "");
    if (!doc.trim()) return [];
    const lines = offsetsOf(doc);
    const paras = parasOf(doc);
    const diag = [];
    const push = (start, end, severity, message, fix, cat) => {
      if (start < 0 || end > doc.length || end <= start) return;
      const lc = lineCol(lines, start);
      diag.push({ start, end, line: lc.line, col: lc.col, severity, message, fix, cat });
    };

    /* ---- T1 + 词库禁词：出现即标 ---- */
    for (const r of compiled.t1.concat(compiled.banned)) {
      if (r.term.length < 2) continue;
      const sev = TOXIC.includes(r.term) ? "error" : "warn";
      for (const off of findOffsets(doc, r.term)) {
        push(off, off + r.term.length, sev, `禁用词「${r.term}」`, r.replacement || "换成具体动作/白描", "t1");
      }
    }

    /* ---- T2：同段聚集 ≥2 ---- */
    for (const r of compiled.t2) {
      if (r.term.length < 2) continue;
      for (const p of paras) {
        let n = 0, first = -1;
        for (let i = 0; i < p.text.length;) {
          const j = p.text.indexOf(r.term, i);
          if (j === -1) break;
          if (n === 0) first = p.start + j;
          n++; i = j + r.term.length;
        }
        if (n >= 2) push(first, first + r.term.length, "warn", `「${r.term}」同段出现 ${n} 次`, "只保留最贴切的一个", "t2");
      }
    }

    /* ---- 语境敏感阈值 ---- */
    for (const r of compiled.ctx) {
      for (const term of r.terms || []) {
        if (!term) continue;
        const n = findOffsets(doc, term).length;
        if (!n) continue;
        const max = r.thresh ? r.thresh.max : null;
        const per = r.thresh ? r.thresh.per : "";
        let scale = 1;
        if (per === "500字") scale = Math.max(1, Math.round(doc.length / 500));
        if (max != null && n / scale > max) {
          const off = doc.indexOf(term);
          push(off, off + term.length, "warn", `「${term}」全文 ${n} 次（阈值 ≤${max}${per ? "/" + per : ""}）`, r.replacement || "删减或换词", "ctx");
        }
      }
    }

    /* ---- 词库 ⚠ 频率规则：重复用词 ---- */
    for (const f of compiled.freq) {
      const word = f.word || (f.terms && f.terms[0]) || "";
      if (!word || !f.terms || !f.terms.length) continue;
      let n = 0;
      for (const t of f.terms) n += findOffsets(doc, t).length;
      if (f.max != null && n >= f.max) {
        const off = doc.indexOf(f.terms[0]);
        push(off, off + f.terms[0].length, "warn", `「${word}」已用 ${n} 次（词库建议 ≤${f.max}）`, "换用其他表达", "freq");
      } else if (f.whole && n >= 3) {
        const off = doc.indexOf(f.terms[0]);
        push(off, off + f.terms[0].length, "info", `「${word}」全书高频表达，注意密度`, "控制使用频率", "freq");
      }
    }

    /* ---- 密度统计 ---- */
    const pCount = paras.length;
    if (pCount) {
      let totalLe = 0;
      for (const p of paras) {
        let c = 0; for (let i = 0; i < p.text.length; i++) if (p.text[i] === "了") c++;
        totalLe += c;
        if (c >= 5) push(p.start, p.start + 6, "info", `本段「了」${c} 个，偏密`, "保留关键「了」，删冗余", "t3");
      }
      if (totalLe / pCount > 2.5) {
        push(0, 1, "info", `全文平均每段「了」${(totalLe / pCount).toFixed(1)} 个（建议 ≤2.5）`, "精简「了」字", "t3");
      }
    }
    // 连续句号 ≥10
    const sentences = doc.split(/[。！？]/).length - 1;
    // 基础词密度
    for (const w of ["重要", "关键", "核心"]) {
      const n = findOffsets(doc, w).length;
      if (n > 3) {
        const off = doc.indexOf(w);
        push(off, off + w.length, "info", `「${w}」${n} 次（建议 ≤3/章）`, "换具体描述", "t3");
      }
    }
    // 情绪词重复
    for (const w of ["紧张", "生气", "愤怒", "开心", "难过", "害怕", "担心"]) {
      const n = findOffsets(doc, w).length;
      if (n > 3) {
        const off = doc.indexOf(w);
        push(off, off + w.length, "warn", `情绪词「${w}」${n} 次（建议 ≤3/章）`, "用身体反应/动作外化", "t3");
      }
    }

    /* ---- 结构化句式 ---- */
    for (const pat of PATTERN_RX) {
      const re = pat.rx;
      re.lastIndex = 0;   // 预编译全局正则跨调用复用，必须重置游标
      let m;
      while ((m = re.exec(doc))) {
        push(m.index, m.index + m[0].length, pat.sev || "warn", pat.msg, pat.fix, "pattern");
      }
    }

    // 排序 + 去重（同位置同消息只留一条）+ 上限
    diag.sort((a, b) => a.start - b.start);
    const seen = new Set();
    const out = [];
    for (const d of diag) {
      const k = d.start + "|" + d.message;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
      if (out.length >= 120) break;
    }
    return out;
  }

  function summary(diags) {
    let err = 0, warn = 0, info = 0;
    for (const d of diags) { if (d.severity === "error") err++; else if (d.severity === "warn") warn++; else info++; }
    return { err, warn, info };
  }

  /* ---- 结构化句式配置（人工维护） ---- */
  const PATTERNS = [
    { re: "不是[^，。！？]{1,12}，?(?:而|而是)[^，。！？]{1,12}", msg: "「不是A而是B」句式", fix: "直接写 B", sev: "warn" },
    { re: "(?:仿佛|犹如|宛若)[^，。！？]{1,12}(?:一般|一样|似的)", msg: "万能比喻（仿佛/犹如…一般）", fix: "删除或白描", sev: "error" },
    { re: "(?:让|令|使).{0,8}(?:想起|觉得|感到|意识到)", msg: "「让/令/使」句式", fix: "删「让」，主语直接行动", sev: "warn" },
    { re: "(?:当|在).{0,10}(?:的时候|之时)", msg: "「当…的时候」句式", fix: "拆成独立动作句", sev: "warn" },
    { re: "(?:他|她|他们?)意识到|(?:他|她|他们?)感到|(?:他|她|他们?)注意到", msg: "认知动词前置", fix: "删掉，直接写事实", sev: "warn" },
    { re: "(?:心中|心里|内心|心底)(?:涌起|泛起|升起)", msg: "「心中涌起/泛起」抽象情绪", fix: "用身体反应替代", sev: "warn" },
    { re: "(?:深深地|缓缓地|慢慢地|紧紧地|静静地|轻轻地|淡淡地|怔怔地|默默地)", msg: "AABB式副词修饰", fix: "删掉或换具体速度/状态", sev: "info" },
    { re: "(?:一丝|一抹|些许|几分|一股|一阵)(?:[^，。！？]{0,8})?(?:的|地)?(?:笑意|怒气|悲伤|紧张|恐慌|凉意|暖意|恐惧|不安|尴尬|苦涩)", msg: "模糊量词+抽象情绪", fix: "具体量词或删掉", sev: "warn" },
    { re: "(?:这一夜|从这一刻起|此时此刻|在这一刻)", msg: "升华/定格句式", fix: "删除，停在具体画面上", sev: "warn" },
    { re: "(?:也许是.{0,14}也许是.{0,14}也许是|不是[^，。]{1,10}不是[^，。]{1,10}而是|既.{0,6}又.{0,6}但)", msg: "排比/对称填充", fix: "只保留最具体一条", sev: "warn" },
    { re: "(?:他|她|他们?)不知道的是|此刻.{0,6}不知道", msg: "上帝视角透底", fix: "删掉", sev: "warn" }
  ];
  // 预编译正则，避免每次 scan 都 new RegExp
  const PATTERN_RX = PATTERNS.map(p => Object.assign({}, p, { rx: new RegExp(p.re, "g") }));

  return { compile, scan, summary };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Lint;
if (typeof globalThis !== "undefined") globalThis.Lint = Lint;
