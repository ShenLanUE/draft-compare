"use strict";
/* banks.js — 词库 / 黄金句 / 反AI规则 的 markdown 解析器。
   输出结构化数据，供 suggest / lint / 素材台使用。
   兼容浏览器与 node（验证脚本）。 */

const Banks = (function () {

  function clean(s) {
    return String(s == null ? "" : s).replace(/[\u3000\s]+/g, " ").trim();
  }
  function stripBold(s) {
    return String(s).replace(/\*\*/g, "").replace(/`/g, "").trim();
  }
  function splitTerms(word) {
    return String(word).split(/[/／、]/).map(s => clean(s)).filter(Boolean);
  }
  // 从一行文本里提取 [通用]/[都市]/（古风） 这类题材标签
  function genreTagsOf(text) {
    const tags = [];
    const re = /[\[【（(]([^\]】）)]+)[\]】）)]/g;
    let m;
    while ((m = re.exec(String(text)))) {
      const t = clean(m[1]);
      if (t && /^(通用|古风|都市|玄幻|仙侠|历史|悬疑|科幻|末世|西幻|现实|衍生|女频|男频)$/.test(t) && !tags.includes(t)) tags.push(t);
    }
    return tags;
  }

  /* ================= 词库 ================= */

  // 解析一份词库 md（appearance / emotion / micro-action / …）
  function parseLexicon(md, fileName) {
    const category = (fileName || "").replace(/\.md$/i, "").trim();
    const lines = String(md).split(/\r?\n/);
    const entries = [];
    let sectionPath = [];
    let bookSec = false, emoSec = false;   // 标题层级判定：情绪 vs 书名
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const h = line.match(/^(#{2,3})\s+(.*)$/);
      if (h) {
        const depth = h[1].length;
        const text = stripBold(h[2]);
        if (depth === 2) {
          sectionPath = [text];
          bookSec = /[\[【（(](都市|古风|通用|玄幻|仙侠|历史|悬疑|科幻|末世|西幻|现实|衍生)[\]】）)]/.test(text);
          emoSec = !bookSec;
        } else {
          sectionPath = [sectionPath[0] || "", text].filter(Boolean);
          emoSec = !/[\[【（(][^\]】）)]+[\]】）)]/.test(text);
        }
        i++;
        continue;
      }
      if (/^-\s*\*\*/.test(line)) {
        const e = {
          type: "lexicon", category,
          tags: sectionPath.slice(),
          genreTags: genreTagsOf(sectionPath.join(" ")),
          isEmo: emoSec,
          terms: [], word: "", gloss: "", example: "", hint: "", antiAI: null,
          src: fileName
        };
        let rest = line.replace(/^-\s*\*\*/, "");
        const wEnd = rest.indexOf("**");
        if (wEnd > 0) {
          e.word = clean(rest.slice(0, wEnd));
          rest = rest.slice(wEnd + 2);
        } else {
          e.word = clean(rest);
          rest = "";
        }
        e.terms = splitTerms(e.word);
        // 维护备注（**去重方式**：… / **条数**：… / **反AI**：…）不是词条 → 跳过
        if (/^[：:]/.test(rest.trim())) { i++; continue; }
        let tagTail = "";
        const tm = rest.match(/[\[【（(][^\]】）)]+[\]】）)]\s*$/);
        if (tm) { tagTail = tm[0]; rest = rest.slice(0, tm.index); }
        if (tagTail) e.genreTags.push(...genreTagsOf(tagTail));
        e.gloss = stripBold(clean(rest.replace(/^[\s—–-]+/, "")));

        i++;
        while (i < lines.length) {
          const d = lines[i];
          const t = d.trim();
          if (t === "") { i++; continue; }
          // 非缩进的非空行 = 新的标题/词条（详情行总是缩进的）
          if (!/^\s/.test(d)) break;
          if (/^(例句|例)[：:]\s*/.test(t)) { e.example = clean(t.replace(/^(例句|例)[：:]\s*/, "")); }
          else if (/^(提示|用法|注意|写法)[：:]\s*/.test(t)) { e.hint = clean(t.replace(/^(提示|用法|注意|写法)[：:]\s*/, "")); }
          else if (/^⚠/.test(t)) {
            e.antiAI = clean(t.replace(/^⚠[^：:]{0,4}[：:]\s*/, ""));
          } else if (/^分类[：:]\s*/.test(t)) {
            const c = clean(t.replace(/^分类[：:]\s*/, ""));
            if (c) e.category = c;
          } else if (e.example && !e.hint) {
            // 例句续行
          }
          i++;
        }
        entries.push(e);
        continue;
      }
      i++;
    }
    return entries;
  }

  /* ================= 黄金句 ================= */

  function parseGolden(md, fileName) {
    const category = (fileName || "").replace(/\.md$/i, "").trim();
    const lines = String(md).split(/\r?\n/);
    const entries = [];
    let cur = null;
    let sectionPath = [];
    let lastField = "";
    // 字段名支持带 ** 或纯文本，可带 > / + / - 前缀（历史合并格式）
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.match(/^(#{2,3})\s+(.*)$/);
      if (h) {
        if (cur) { entries.push(cur); cur = null; lastField = ""; }
        const depth = h[1].length;
        const text = stripBold(h[2]);
        if (depth === 2) sectionPath = [text];
        else sectionPath = [sectionPath[0] || "", text].filter(Boolean);
        continue;
      }
      const t = line.trim();
      if (t === "") {
        if (cur && cur.original) { entries.push(cur); cur = null; lastField = ""; }
        continue;
      }
      // 编号小标题（**20. 拍腿示意**）→ 结束当前条目
      if (/^\*\*\d+\.[^*]+\*\*$/.test(t)) {
        if (cur) { entries.push(cur); cur = null; lastField = ""; }
        continue;
      }
      // 字段识别：剥掉 > / + / - 前缀，字段名可带 ** 或纯文本
      const norm = t.replace(/^(?:>\s*|\+\s*|\-\s*)+/, "");
      const fm = norm.match(/^(?:\*\*)?(原句|来源|分类|好在哪里|怎么用|为什么好|如何使用)(?:\*\*)?[：:]\s*([\s\S]*)/);
      if (fm) {
        const key = fm[1];
        const val = clean(fm[2]);
        if (key === "原句") {
          if (cur) entries.push(cur);
          cur = {
            type: "golden", category,
            tags: sectionPath.slice(),
            genreTags: genreTagsOf(sectionPath.join(" ")),
            book: sectionPath[0] ? stripBold(sectionPath[0]).replace(/[\[【（(][^\]】）)]+[\]】）)]$/g, "").trim() : "",
            original: val, source: "", why: "", how: "", antiAI: null,
            src: fileName
          };
          lastField = "original";
          continue;
        }
        if (!cur) continue;
        if (key === "来源") { cur.source = val; lastField = "source"; continue; }
        if (key === "分类") { if (val) cur.category = val; lastField = "category"; continue; }
        if (key === "好在哪里" || key === "为什么好") { cur.why = val; lastField = "why"; continue; }
        if (key === "怎么用" || key === "如何使用") { cur.how = val; lastField = "how"; continue; }
      }
      if (!cur) continue;
      // **⚠ 反AI**：…（带 ** 的 ⚠ 行）也要识别
      const warnT = t.replace(/^\s*\*+/, "").trim();
      if (/^⚠/.test(warnT)) {
        cur.antiAI = clean(warnT.replace(/^⚠[^：:]{0,4}[：:]\s*/, ""));
        lastField = "antiAI";
        continue;
      }
      // 维护备注（**统计**：… / **题材适配**：…）不作为字段
      if (/^\*\*[^*]+\*\*\s*[：:]/.test(t)) {
        if (cur) { entries.push(cur); cur = null; lastField = ""; }
        continue;
      }
      // 续行：追加到当前字段
      if (lastField === "why" || lastField === "how" || lastField === "original") {
        if (cur[lastField]) cur[lastField] += t;
      }
    }
    if (cur) entries.push(cur);
    return entries;
  }

  /* ================= 反AI规则 ================= */

  const HEADER_CELLS = ["词", "句式", "模式", "检测项", "情绪词", "类型", "规则", "写法", "档位", "处理"];
  const GENRE_HEADER_RE = /^(通用|古风|都市|玄幻|仙侠|历史|悬疑|科幻|末世|西幻|现实|衍生|女频|男频)[：:]/;

  function parseAntiRules(md) {
    const lines = String(md).split(/\r?\n/);
    const rules = [];
    const headings = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const h = line.match(/^(#{2,5})\s+(.*)$/);
      if (h) {
        headings.push(stripBold(h[2]));
        i++;
        continue;
      }
      if (line.trim().startsWith("|")) {
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          const t = lines[i].trim().replace(/^\||\|$/g, "");
          const cells = t.split("|").map(c => stripBold(c).trim());
          const isSep = cells.length === 1 && /^[-—:]+$/.test(cells[0] || "");
          if (!isSep) rows.push(cells);
          i++;
        }
        const ctx = headings[headings.length - 1] || "";   // 只认紧邻表上方的标题，避免跨节污染
        const tableRules = interpretTable(rows, ctx);
        if (tableRules) rules.push(...tableRules);
        continue;
      }
      i++;
    }
    return rules;
  }

  function isHeaderRow(cells) {
    const c0 = clean(cells[0] || "");
    return HEADER_CELLS.includes(c0) || /^[-—:]+$/.test(c0) || GENRE_HEADER_RE.test(c0);
  }

  function parseThresh(text) {
    // "≤4次/章" / ">3次/章" / "≤3次/500字" / "平均每段>2.5个"
    const m = String(text).match(/([≤<>=])\s*([\d.]+)\s*次?\s*(\/\s*(章|500字|段|场景|千字))?/);
    if (!m) return null;
    return {
      op: m[1], max: parseFloat(m[2]),
      per: m[3] ? m[3].replace("/", "").trim() : ""
    };
  }

  function termsOf(cell) {
    return String(cell).split(/[/／、，,；;]/).map(s => clean(s).replace(/^["“]|["”]$/g, "")).filter(s => s.length >= 1 && s.length <= 40);
  }

  function interpretTable(rows, ctx) {
    const data = rows.filter(r => r.length >= 2 && !isHeaderRow(r));
    if (!data.length) return null;
    if (ctx.includes("一级禁用词") || /情态类|动作类|表情类|心理类|判断类|形容类|书面腔/.test(ctx)) {
      // T1 出现即换：两列 词 | 替换策略
      return data.map(r => ({ level: "T1", terms: termsOf(r[0]), replacement: r[r.length - 1] || "", src: "common-rules" }));
    }
    if (ctx.includes("T2") || /同段/.test(ctx)) {
      return data.map(r => ({ level: "T2", terms: termsOf(r[0]), replacement: r[r.length - 1] || "", src: "common-rules" }));
    }
    if (ctx.includes("T3") || /密度/.test(ctx)) {
      return data.map(r => ({
        level: "T3", name: clean(r[0]), threshold: r[1] || "",
        replacement: r[2] || r[r.length - 1] || "", src: "common-rules"
      }));
    }
    if (/语境敏感/.test(ctx)) {
      return data.map(r => {
        const th = parseThresh(r[1] || "");
        return { level: "ctx", terms: termsOf(r[0]), thresh: th, note: r[1] || "", replacement: r[2] || "", src: "common-rules" };
      });
    }
    if (/情绪外化|替换策略速查/.test(ctx)) {
      return data.map(r => ({ level: "emotionReplace", emotion: clean(r[0]), replacement: r[1] || "", src: "common-rules" }));
    }
    if (/句式模板|比喻类|结构类|标点类|反问|升华|总结句式|排比句式/.test(ctx)) {
      return data.map(r => ({ level: "pattern", name: clean(r[0]), note: r[1] || "", replacement: r[r.length - 1] || "", src: "common-rules" }));
    }
    return null;
  }

  /* ================= ⚠ 频率规则提取 ================= */

  // 从词条 ⚠ 反AI / 提示 文本里提取"单章≤N次 / 全书高频 / ≥N次就腻"这类频率约束
  function freqRule(text) {
    if (!text) return null;
    const t = clean(text);
    let max = null;
    const m = t.match(/单章\s*[≤<>=]?\s*(\d+)\s*次|≤\s*(\d+)\s*次[/／]?\s*章|\*\*(\d+)\s*次\*\*|\s(\d+)\s*次\s*[以回]/);
    if (m) {
      const n = m[1] || m[2] || m[3] || m[4];
      if (n) max = parseInt(n, 10);
    } else {
      const m2 = t.match(/(\d+)\s*次/);
      if (m2) max = parseInt(m2[1], 10);
    }
    const wholeFreq = /全书高频|章章|别章章|每章|全书|密度高|不连用|别老用/.test(t);
    const note = t;
    if (max === null && !wholeFreq) return null;
    return { max, note, whole: wholeFreq };
  }

  // 从 ⚠ 文本里提取被禁用的具体词（禁"X"/禁用"X"）
  function bannedPhrasesOf(text) {
    const out = [];
    if (!text) return out;
    const re = /(?:禁|禁用|别|不要|不用|避免)[:：]?\s*["“『「]([^"”』」]+)["”』」]/g;
    let m;
    while ((m = re.exec(text))) out.push(clean(m[1]));
    // 也抓 "X"+"Y" 连用套路中的 X / Y
    const re2 = /["“『「]([^"”』」]{1,12})["”』」]/g;
    while ((m = re2.exec(text))) {
      const p = clean(m[1]);
      if (p && p.length <= 8 && !out.includes(p) && !/次|章/.test(p)) out.push(p);
    }
    return out;
  }

  /* ================= 角色卡 ================= */

  const CHAR_FIELDS = {
    "别名": "aliases", "性别": "gender", "外貌": "appearance", "性格": "personality",
    "口头禅": "habits", "习惯": "habits", "口头禅/习惯": "habits", "口头禅/习惯小动作": "habits",
    "背景": "background", "关系": "relationships", "当前状态": "state", "状态": "state",
    "关键钩子": "hooks", "钩子": "hooks", "开场白": "opening", "示例对话": "examples",
    "备注": "notes", "补充": "notes"
  };
  const CHAR_MULTI = { examples: 1, notes: 1 };

  // 解析角色卡 md：## 姓名 + - **字段**：值；示例对话用 > 续行；未知标签进 extra
  function parseCharacters(md, fileName) {
    const lines = String(md).split(/\r?\n/);
    const entries = [];
    let cur = null, lastField = "", lastExtra = "";
    const blank = () => ({ type: "character", name: "", aliases: "", gender: "", appearance: "", personality: "", habits: "", background: "", relationships: "", state: "", hooks: "", opening: "", examples: "", notes: "", extra: {}, src: fileName });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.match(/^(#{2})\s+(.*)$/);
      if (h) {
        if (cur) entries.push(cur);
        cur = blank();
        cur.name = stripBold(h[2]);
        lastField = ""; lastExtra = "";
        continue;
      }
      if (!cur) continue;
      const fm = line.match(/^-\s*\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/);
      if (fm) {
        const label = fm[1].trim();
        const key = CHAR_FIELDS[label];
        const val = fm[2].trim();
        if (key) { cur[key] = val; lastField = CHAR_MULTI[key] ? key : ""; lastExtra = ""; }
        else { cur.extra[label] = val; lastField = "extra"; lastExtra = label; }
        continue;
      }
      const t = line.trim();
      if (t === "") continue;
      if (/^\*\*[^*]+\*\*\s*[：:]/.test(t)) continue;   // 维护备注
      if (lastField === "extra" && lastExtra) cur.extra[lastExtra] = (cur.extra[lastExtra] || "") + "\n" + t;
      else if (lastField === "examples") cur.examples = (cur.examples ? cur.examples + "\n" : "") + t.replace(/^>\s*/, "");
      else if (lastField === "notes") cur.notes = (cur.notes ? cur.notes + "\n" : "") + t.replace(/^>\s*/, "");
    }
    if (cur) entries.push(cur);
    return entries.filter(e => e.name);
  }

  function charToMd(e) {
    const L = [];
    L.push("## " + (e.name || "未命名"));
    const rows = [
      ["别名", e.aliases], ["性别", e.gender], ["外貌", e.appearance], ["性格", e.personality],
      ["口头禅/习惯", e.habits], ["背景", e.background], ["关系", e.relationships],
      ["当前状态", e.state], ["关键钩子", e.hooks], ["开场白", e.opening], ["备注", e.notes]
    ];
    for (const [k, v] of rows) if (v) L.push("- **" + k + "**：" + v);
    if (e.examples) {
      L.push("- **示例对话**：");
      for (const ln of String(e.examples).split("\n")) L.push("  > " + ln);
    }
    for (const [k, v] of Object.entries(e.extra || {})) if (v) L.push("- **" + k + "**：" + v);
    return L.join("\n");
  }
  function serializeCharacters(entries) {
    const lines = ["# 角色卡（导出）", ""];
    for (const e of entries || []) lines.push(charToMd(e), "");
    return lines.join("\n");
  }

  /* ================= 设定词条 ================= */

  // 分类专属字段模板：主描述统一用 description 键（旧数据兼容）；type: text|textarea|chip
  const CAT_FIELDS = {
    "地点": [
      { key: "description", label: "地貌 / 环境", type: "textarea" },
      { key: "location", label: "位置 / 范围", type: "text" },
      { key: "notable", label: "重要区域", type: "textarea" },
      { key: "customs", label: "风土 / 特产", type: "textarea" }
    ],
    "门派": [
      { key: "description", label: "宗旨 / 作风", type: "textarea" },
      { key: "founded", label: "开派时间", type: "text" },
      { key: "hierarchy", label: "等级 / 职务", type: "textarea" },
      { key: "members", label: "主要成员", type: "chip" },
      { key: "factions", label: "敌对 / 联盟", type: "textarea" }
    ],
    "势力": [
      { key: "description", label: "宗旨 / 目的", type: "textarea" },
      { key: "territory", label: "地盘 / 范围", type: "text" },
      { key: "structure", label: "架构 / 成员", type: "textarea" },
      { key: "factions", label: "敌对 / 联盟", type: "textarea" }
    ],
    "组织": [
      { key: "description", label: "宗旨 / 性质", type: "textarea" },
      { key: "founded", label: "成立时间", type: "text" },
      { key: "structure", label: "结构 / 成员", type: "textarea" },
      { key: "activity", label: "活动 / 日常", type: "textarea" }
    ],
    "物品": [
      { key: "description", label: "功能 / 效果", type: "textarea" },
      { key: "appearance", label: "外观", type: "textarea" },
      { key: "material", label: "材质", type: "text" },
      { key: "origin", label: "来历", type: "textarea" },
      { key: "limit", label: "限制 / 副作用", type: "textarea" }
    ],
    "功法": [
      { key: "description", label: "修炼方式 / 效果", type: "textarea" },
      { key: "level", label: "品阶", type: "text" },
      { key: "method", label: "施展 / 催动", type: "textarea" },
      { key: "cost", label: "代价 / 限制", type: "textarea" },
      { key: "obtain", label: "获得方式", type: "textarea" }
    ],
    "法术": [
      { key: "description", label: "施展方式 / 效果", type: "textarea" },
      { key: "level", label: "品阶", type: "text" },
      { key: "cost", label: "代价 / 限制", type: "textarea" },
      { key: "obtain", label: "获得方式", type: "textarea" }
    ],
    "灵兽": [
      { key: "description", label: "性情 / 习性", type: "textarea" },
      { key: "appearance", label: "外观", type: "textarea" },
      { key: "ability", label: "能力 / 本领", type: "textarea" },
      { key: "contract", label: "契约 / 驯服", type: "textarea" }
    ],
    "种族": [
      { key: "description", label: "文化 / 习俗", type: "textarea" },
      { key: "appearance", label: "外形", type: "textarea" },
      { key: "origin", label: "起源 / 历史", type: "textarea" },
      { key: "ability", label: "能力", type: "textarea" }
    ],
    "事件": [
      { key: "description", label: "经过", type: "textarea" },
      { key: "time", label: "时间", type: "text" },
      { key: "place", label: "地点", type: "text" },
      { key: "figures", label: "人物", type: "chip" },
      { key: "impact", label: "影响 / 结果", type: "textarea" }
    ],
    "历史": [
      { key: "description", label: "大事记", type: "textarea" },
      { key: "period", label: "时期", type: "text" },
      { key: "figures", label: "关键人物", type: "chip" }
    ],
    "风俗": [
      { key: "description", label: "习俗内容", type: "textarea" },
      { key: "occasion", label: "场合 / 对象", type: "text" },
      { key: "taboo", label: "禁忌", type: "textarea" }
    ],
    "制度": [
      { key: "description", label: "内容 / 条款", type: "textarea" },
      { key: "scope", label: "适用范围", type: "text" },
      { key: "enforce", label: "执行 / 惩罚", type: "textarea" }
    ],
    "其他": [
      { key: "description", label: "设定描述", type: "textarea" }
    ]
  };
  function catFields(cat) { return CAT_FIELDS[cat] || CAT_FIELDS["其他"] || []; }
  // 全局 key → 默认标签（分类变更/跨模板时兜底序列化，防丢数据）
  const GLOBAL_LABELS = {};
  for (const tpl of Object.values(CAT_FIELDS)) for (const f of tpl) if (!GLOBAL_LABELS[f.key]) GLOBAL_LABELS[f.key] = f.label;
  // 支持续行的字段（textarea / 备注 / 规则 / extra）
  const BLOCK_KEYS = ["description", "rules", "notes", "notable", "customs", "hierarchy", "factions", "structure", "activity", "appearance", "origin", "limit", "method", "cost", "obtain", "ability", "contract", "impact", "taboo", "enforce"];

  const SET_FIELDS = {
    "类别": "category", "类型": "category", "设定": "description", "设定描述": "description",
    "描述": "description", "相关": "related", "相关角色": "related", "相关词条": "related",
    "规则": "rules", "禁忌": "rules", "规则/禁忌": "rules", "备注": "notes", "补充": "notes",
    "位置": "location", "位置/范围": "location", "范围": "location",
    "重要区域": "notable", "风土/特产": "customs",
    "宗旨/作风": "description", "宗旨/目的": "description", "宗旨/性质": "description",
    "开派时间": "founded", "成立时间": "founded", "等级/职务": "hierarchy",
    "主要成员": "members", "敌对/联盟": "factions", "地盘/范围": "territory",
    "架构/成员": "structure", "结构/成员": "structure", "活动/日常": "activity",
    "功能/效果": "description", "外观": "appearance", "材质": "material", "来历": "origin", "限制/副作用": "limit",
    "修炼方式/效果": "description", "品阶": "level", "施展/催动": "method", "代价/限制": "cost", "获得方式": "obtain",
    "施展方式/效果": "description", "性情/习性": "description", "能力/本领": "ability", "契约/驯服": "contract",
    "文化/习俗": "description", "起源/历史": "origin", "能力": "ability",
    "经过": "description", "时间": "time", "地点": "place", "人物": "figures", "影响/结果": "impact",
    "大事记": "description", "时期": "period", "关键人物": "figures",
    "习俗内容": "description", "场合/对象": "occasion", "禁忌": "taboo",
    "内容/条款": "description", "适用范围": "scope", "执行/惩罚": "enforce"
  };

  function parseSettings(md, fileName) {
    const lines = String(md).split(/\r?\n/);
    const entries = [];
    let cur = null, lastField = "", lastExtra = "";
    const blank = () => ({ type: "setting", name: "", category: "", description: "", related: "", rules: "", notes: "", extra: {}, src: fileName });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.match(/^(#{2})\s+(.*)$/);
      if (h) {
        if (cur) entries.push(cur);
        cur = blank();
        cur.name = stripBold(h[2]);
        lastField = ""; lastExtra = "";
        continue;
      }
      if (!cur) continue;
      const fm = line.match(/^-\s*\*\*([^*]+)\*\*\s*[：:]\s*(.*)$/);
      if (fm) {
        const label = fm[1].trim();
        // 模板标签带空格（如 "功能 / 效果"），解析时归一化匹配 SET_FIELDS（"功能/效果"）
        const key = SET_FIELDS[label] || SET_FIELDS[label.replace(/\s*\/\s*/g, "/")];
        const val = fm[2].trim();
        if (key) {
          if (cur[key] && typeof cur[key] === "string" && cur[key] !== "") {
            // 已知标签但该键已填 → 进 extra 防覆盖（自定义字段撞内置标签）
            cur.extra[label] = val;
            lastField = "extra"; lastExtra = label;
          } else {
            cur[key] = val;
            lastField = BLOCK_KEYS.includes(key) ? key : "";
            lastExtra = "";
          }
        } else {
          cur.extra[label] = val;
          lastField = "extra"; lastExtra = label;
        }
        continue;
      }
      const t = line.trim();
      if (t === "") continue;
      if (/^\*\*[^*]+\*\*\s*[：:]/.test(t)) continue;
      if (lastField === "extra" && lastExtra) {
        cur.extra[lastExtra] = (cur.extra[lastExtra] || "") + "\n" + t;
      } else if (BLOCK_KEYS.includes(lastField)) {
        const add = lastField === "notes" ? t.replace(/^>\s*/, "") : t;
        cur[lastField] = (cur[lastField] ? cur[lastField] + "\n" : "") + add;
      }
    }
    if (cur) entries.push(cur);
    return entries.filter(e => e.name);
  }

  function settingToMd(e) {
    const L = [];
    L.push("## " + (e.name || "未命名"));
    const tpl = catFields(e.category);
    const rows = [["类别", e.category]];
    const used = new Set(["category", "name", "related", "rules", "notes", "extra", "id", "type", "user", "src"]);
    for (const f of tpl) { used.add(f.key); if (e[f.key]) rows.push([f.label, e[f.key]]); }
    if (e.related) rows.push(["相关", e.related]);
    if (e.rules) rows.push(["规则/禁忌", e.rules]);
    if (e.notes) rows.push(["备注", e.notes]);
    // 其它已知字段（跨模板/分类变更兜底，防丢）
    for (const k of Object.keys(e)) {
      if (used.has(k) || typeof e[k] !== "string" || !e[k]) continue;
      const label = GLOBAL_LABELS[k] || k;
      rows.push([label, e[k]]);
    }
    // 自定义字段（extra，保留插入顺序）
    for (const [k, v] of Object.entries(e.extra || {})) if (v) rows.push([k, v]);
    for (const [k, v] of rows) if (v) L.push("- **" + k + "**：" + v);
    return L.join("\n");
  }
  function serializeSettings(entries) {
    const lines = ["# 设定（导出）", ""];
    for (const e of entries || []) lines.push(settingToMd(e), "");
    return lines.join("\n");
  }

  /* ================= 文件识别（合并导入用） ================= */

  // 返回 "lexicon" | "golden" | "anti" | "character" | "setting" | null
  function detectBank(md, fileName) {
    const head = String(md).slice(0, 600);
    const name = (fileName || "").toLowerCase();
    if (/^(小动作库|小神态库)/.test(head)) return "lexicon";
    if (/^#\s*黄金例句库/.test(head) || /\*\*原句\*\*[：:]/.test(head) || /\*\*好在哪里\*\*/.test(head)) return "golden";
    if (/^#\s*反AI/.test(head) || /分级禁用|禁用表|反 ?AI/.test(head)) return "anti";
    if (/^#\s*(角色卡|角色|人物卡|人物设定)/.test(head)) return "character";
    if (/^#\s*(设定|世界观|世界设定|设定集)/.test(head)) return "setting";
    if (/^#\s*.{0,12}(词库|描写|神态库|词汇)/.test(head)) return "lexicon";
    if (/-\s*\*\*[^*]+\*\*\s*[—\-–]/.test(head) && /例句[：:]/.test(head)) return "lexicon";
    // 文件名兜底
    if (name.includes("golden") || name.includes("黄金")) return "golden";
    if (name.includes("lexicon") || name.includes("词库") || name.includes("小动作") || name.includes("小神态")) return "lexicon";
    if (name.includes("character") || name.includes("角色") || name.includes("人物卡")) return "character";
    if (name.includes("setting") || name.includes("设定") || name.includes("世界观")) return "setting";
    if (name.includes("anti-ai") || name.includes("反ai") || name.includes("禁用")) return "anti";
    return null;
  }

  /* ================= 序列化（导出 md，与解析器往返） ================= */

  const CAT_LABEL = {
    "micro-action": "小动作", "micro-expression": "小神态", "action-body": "动作",
    "emotion": "情绪", "romance": "恋爱", "appearance": "外貌", "attire": "服饰",
    "dialogue": "对话", "battle": "战斗", "xianxia": "修炼", "system-flow": "系统流",
    "environment": "景物", "realm-world": "异界", "expression": "神态", "figure-posture": "身姿",
    "entrance": "登场", "payoff": "爽点"
  };
  let CAT_OVERRIDES = {};   // 用户自定义分类显示名 { slug: 名 }
  function setCatOverrides(map) { CAT_OVERRIDES = Object.assign({}, map || {}); }
  function catLabel(c) { return CAT_OVERRIDES[c] || CAT_LABEL[c] || c || "自定义"; }

  function genreMd(e) {
    const g = (e.genreTags || []).filter(Boolean);
    return g.length ? "。" + g.map(x => "[" + x + "]").join("") : "";
  }

  // 单条词库 → md 块（含 分类： 行，可被 parseLexicon 读回）
  function entryToMd(e) {
    const L = [];
    L.push("- **" + (e.word || "") + "**" + (e.gloss ? " — " + e.gloss : "") + genreMd(e));
    if (e.category) L.push("  分类：" + e.category);
    if (e.example) L.push("  例句：" + e.example);
    if (e.hint) L.push("  提示：" + e.hint);
    if (e.antiAI) L.push("  ⚠ 反AI：" + e.antiAI);
    return L.join("\n");
  }

  function serializeLexicon(entries) {
    const lines = ["# 词库（导出）", ""];
    const byCat = {};
    for (const e of entries) { const c = e.category || "custom"; (byCat[c] = byCat[c] || []).push(e); }
    for (const cat of Object.keys(byCat)) {
      lines.push("## " + (CAT_LABEL[cat] || cat), "");
      const byTag = {};
      for (const e of byCat[cat]) { const t = (e.tags && e.tags[e.tags.length - 1]) || ""; (byTag[t] = byTag[t] || []).push(e); }
      for (const t of Object.keys(byTag)) {
        if (t) lines.push("### " + t, "");
        for (const e of byTag[t]) lines.push(entryToMd(e), "");
      }
    }
    return lines.join("\n");
  }

  function goldenToMd(e) {
    const L = [];
    const book = e.book || "";
    const g = (e.genreTags || [])[0];
    L.push((book || "未命名") + (g ? " [" + g + "]" : ""));
    L.push("**原句**：" + (e.original || ""));
    if (e.source) L.push("> 来源：" + e.source);
    if (e.category) L.push("> 分类：" + e.category);
    if (e.why) L.push("**好在哪里**：" + e.why);
    if (e.how) L.push("**怎么用**：" + e.how);
    if (e.antiAI) L.push("⚠ 反AI：" + e.antiAI);
    return L.join("\n");
  }

  function serializeGolden(entries) {
    const lines = ["# 黄金例句库（导出）", ""];
    const byCat = {};
    for (const e of entries) { const c = e.category || "custom"; (byCat[c] = byCat[c] || []).push(e); }
    for (const cat of Object.keys(byCat)) {
      const byBook = {};
      for (const e of byCat[cat]) { const b = e.book || "未命名"; (byBook[b] = byBook[b] || []).push(e); }
      for (const b of Object.keys(byBook)) {
        lines.push("## " + b + (byBook[b][0].genreTags && byBook[b][0].genreTags[0] ? " [" + byBook[b][0].genreTags[0] + "]" : ""), "");
        for (const e of byBook[b]) {
          const tag = e.tags && e.tags[e.tags.length - 1];
          if (tag && tag !== b) lines.push("### " + tag);
          lines.push(goldenToMd(e), "");
        }
      }
    }
    return lines.join("\n");
  }

  function serializeAnti(rules) {
    const lines = ["# 反AI规则（导出）", ""];
    const grp = { T1: [], T2: [], T3: [], ctx: [], emotionReplace: [], pattern: [] };
    for (const r of rules || []) { if (grp[r.level]) grp[r.level].push(r); }
    if (grp.T1.length) {
      lines.push("## 一级禁用词（出现即替换）", "", "| 词 | 替换策略 |", "|----|---------|");
      for (const r of grp.T1) lines.push("| " + (r.terms || []).join("、") + " | " + (r.replacement || "") + " |");
      lines.push("");
    }
    if (grp.T2.length) {
      lines.push("## T2 同段聚集（同段 ≥2 次）", "", "| 词 | 替换策略 |", "|----|---------|");
      for (const r of grp.T2) lines.push("| " + (r.terms || []).join("、") + " | " + (r.replacement || "") + " |");
      lines.push("");
    }
    if (grp.T3.length) {
      lines.push("## T3 全文密度", "", "| 检测项 | 超标线 | 处理 |", "|----|-------|------|");
      for (const r of grp.T3) lines.push("| " + (r.name || "") + " | " + (r.threshold || "") + " | " + (r.replacement || "") + " |");
      lines.push("");
    }
    if (grp.ctx.length) {
      lines.push("## 语境敏感类", "", "| 词 | 阈值 | 替换策略 |", "|----|------|---------|");
      for (const r of grp.ctx) {
        const th = r.thresh ? (r.thresh.op || "≤") + r.thresh.max + "次/" + (r.thresh.per || "章") : (r.note || "");
        lines.push("| " + (r.terms || []).join("、") + " | " + th + " | " + (r.replacement || "") + " |");
      }
      lines.push("");
    }
    if (grp.emotionReplace.length) {
      lines.push("## 情绪外化替换", "", "| 情绪词 | 替换为 |", "|--------|--------|");
      for (const r of grp.emotionReplace) lines.push("| " + (r.emotion || "") + " | " + (r.replacement || "") + " |");
      lines.push("");
    }
    if (grp.pattern.length) {
      lines.push("## 句式模板", "", "| 句式 | 处理 |", "|------|------|");
      for (const r of grp.pattern) lines.push("| " + (r.name || "") + " | " + (r.replacement || r.note || "") + " |");
      lines.push("");
    }
    return lines.join("\n");
  }

  function serializeFav(lines) {
    return "# 常用词句（每行一条）\n\n" + (lines || []).join("\n");
  }

  return {
    clean, stripBold, splitTerms, genreTagsOf,
    parseLexicon, parseGolden, parseAntiRules,
    parseCharacters, parseSettings, charToMd, settingToMd,
    serializeLexicon, serializeGolden, serializeAnti, serializeFav,
    serializeCharacters, serializeSettings,
    freqRule, bannedPhrasesOf, detectBank,
    catLabel, categories: () => Object.keys(CAT_LABEL), setCatOverrides,
    entryToMd, goldenToMd,
    CAT_FIELDS, catFields, BLOCK_KEYS
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Banks;
if (typeof globalThis !== "undefined") globalThis.Banks = Banks;
