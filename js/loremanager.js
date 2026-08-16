"use strict";
/* loremanager.js — 设定管理：角色卡 + 世界观设定卡，按分类组织（角色是其中一类）。
   数据仍存 character / setting 表，BankLoader.rebuild() 照常刷新，AI 全量注入不受影响。 */

const LoreManager = (function () {

  const el = id => document.getElementById(id);
  const LORE_CATS = ["角色", "地点", "门派", "势力", "组织", "物品", "功法", "法术", "灵兽", "种族", "事件", "历史", "风俗", "制度", "其他"];

  let cat = "角色";
  let query = "";
  let editType = "character";   // character | setting
  let editEntry = null;
  let editMode = "form";        // form | md
  let loreGlobal = false;       // 全局跨分类搜索
  let extraRows = [];           // 条目级自定义字段 [{label, value}]
  // chip 检索选择组件（泛化：related/relationships/aliases/members/figures 共用）
  const CHIP_FIELDS = {
    related:       { sources: ["char", "setting"], lex: true,  hint: "搜索角色 / 词条… 或直接输入后回车" },
    relationships: { sources: ["char"],             lex: false, hint: "搜索角色… 或直接输入后回车" },
    aliases:       { sources: [],                   lex: false, hint: "输入后回车添加别名" },
    members:       { sources: ["char"],             lex: false, hint: "搜索角色… 或直接输入后回车" },
    figures:       { sources: ["char"],             lex: false, hint: "搜索角色… 或直接输入后回车" }
  };
  let chips = {};               // { [key]: [{ name, kind, label, id }] }
  let relSel = 0;               // 下拉选中下标
  let relQuery = "";            // 当前搜索词
  let relField = "";            // 当前激活字段
  let relLexOn = false;         // related 含词库开关（全局，settings 持久化）

  function typeOf(c) { return c === "角色" ? "character" : "setting"; }
  function storeOf(t) { return t === "character" ? "character" : "setting"; }
  // 分类列表（settings.loreCats 自定义，空 = 内置默认）
  function catList() {
    const s = (window.Store && Store.getSettings()) || {};
    const arr = (Array.isArray(s.loreCats) && s.loreCats.length) ? s.loreCats : LORE_CATS;
    return arr.filter(Boolean);
  }
  function catCount(catName) {
    if (catName === "角色") return (listOf("character") || []).length;
    return (listOf("setting") || []).filter(s => s.category === catName).length;
  }
  function listOf(t) {
    const s = (window.BankLoader && BankLoader.state) || { characters: [], settings: [] };
    return t === "character" ? s.characters || [] : s.settings || [];
  }
  function lexList() {
    return (window.BankLoader && BankLoader.state && BankLoader.state.lexicon) || [];
  }
  // 当前分类下的条目
  function catItems() {
    const t = typeOf(cat);
    const all = listOf(t);
    return t === "character" ? all : all.filter(it => it.category === cat);
  }

  /* ================= chip 检索选择组件（搜索其他角色/词条） ================= */

  const REL_SEP = /[\/、，,]/;
  function splitRel(str) {
    return String(str || "").split(REL_SEP).map(s => s.trim()).filter(Boolean);
  }
  function charNames(c) {
    return [c.name].concat(String(c.aliases || "").split(REL_SEP).map(s => s.trim()).filter(Boolean)).filter(Boolean);
  }
  function chipsOf(key) {
    if (!chips[key]) chips[key] = [];
    return chips[key];
  }
  function lexChip(name) {
    for (const e of lexList()) {
      const terms = (e.terms && e.terms.length) ? e.terms : [e.word];
      if (terms.includes(name)) return { name, kind: "lex", id: null, label: Banks.catLabel(e.category) || e.category || "词库" };
    }
    return null;
  }
  // chip 解析：按字段搜索源解析现有条目 → {kind,id,label}；否则 raw（灰色警示）
  function classifyChip(key, name) {
    const cfg = CHIP_FIELDS[key] || {};
    if (cfg.sources.includes("char")) {
      for (const c of listOf("character")) if (charNames(c).includes(name)) return { name, kind: "char", id: c.id, label: "角色" };
    }
    if (cfg.sources.includes("setting")) {
      for (const st of listOf("setting")) if (st.name === name) return { name, kind: "setting", id: st.id, label: st.category || "设定" };
    }
    if (cfg.lex && relLexOn) { const l = lexChip(name); if (l) return l; }
    return { name, kind: "raw", label: "" };
  }
  function searchRel(key, q) {
    const cfg = CHIP_FIELDS[key] || {};
    const res = [], seen = new Set();
    const push = (name, kind, label, sc) => {
      if (!name || seen.has(name) || chipsOf(key).some(c => c.name === name)) return;
      seen.add(name);
      if (sc) res.push({ name, kind, label, sc });
    };
    for (const c of listOf("character")) for (const n of charNames(c)) push(n, "char", "角色", n.startsWith(q) ? 10 : n.includes(q) ? 5 : 0);
    for (const st of listOf("setting")) push(st.name, "setting", st.category || "设定", st.name.startsWith(q) ? 10 : st.name.includes(q) ? 5 : 0);
    if (cfg.lex && relLexOn) {
      for (const e of lexList()) {
        const terms = (e.terms && e.terms.length) ? e.terms : [e.word];
        for (const t of terms) { if (!t) continue; push(t, "lex", Banks.catLabel(e.category) || e.category || "词库", t.startsWith(q) ? 10 : t.includes(q) ? 5 : 0); }
        if (res.length >= 24) break;
      }
    }
    res.sort((a, b) => b.sc - a.sc);
    return res.slice(0, 8);
  }
  function chipHtml(c) {
    const raw = c.kind === "raw";
    const lex = c.kind === "lex";
    return '<span class="rel-chip' + (raw ? " rel-chip-raw" : "") + '">' +
      (raw
        ? '<em class="rel-chip-badge rel-chip-warn" title="未匹配到现有角色/词条">⚠</em>'
        : '<em class="rel-chip-badge' + (lex ? " rel-chip-lex" : "") + '">' + esc(c.label || "") + '</em>') +
      '<span class="rel-chip-name"' + ((raw || lex) ? "" : ' data-rel-open="' + esc(c.name) + '" title="点击打开该卡"') + '>' + esc(c.name) + '</span>' +
      '<button type="button" class="rel-x" data-rel-x="' + esc(c.name) + '" title="移除">×</button></span>';
  }
  function renderRelChips(key) {
    const wrap = document.querySelector('[data-rel-chips="' + key + '"]');
    if (wrap) wrap.innerHTML = chipsOf(key).map(chipHtml).join("");
  }
  function addRel(key, name, kind, label) {
    if (!name) return;
    let c;
    if (kind === "char") c = { name, kind, label: label || "角色" };
    else if (kind === "setting") c = { name, kind, label: label || "设定" };
    else if (kind === "lex") c = { name, kind, label: label || "词库" };
    else c = classifyChip(key, name);
    if (chipsOf(key).some(x => x.name === c.name)) return;
    chipsOf(key).push(c);
    renderRelChips(key);
  }
  function removeRel(key, name) {
    const arr = chipsOf(key);
    const i = arr.findIndex(x => x.name === name);
    if (i >= 0) { arr.splice(i, 1); renderRelChips(key); }
  }
  function relDrop() { return document.querySelector("[data-rel-drop]"); }
  function onRelInput(key, inp) {
    const q = inp.value.trim();
    relQuery = q; relField = key;
    const drop = relDrop();
    if (!drop) return;
    relSel = 0;
    const cfg = CHIP_FIELDS[key] || {};
    if (!q || (!cfg.sources.length && !(cfg.lex && relLexOn))) { drop.hidden = true; drop.innerHTML = ""; return; }
    const items = searchRel(key, q);
    if (!items.length) {
      drop.hidden = false;
      drop.innerHTML = '<div class="rel-opt rel-opt-none">无匹配条目，回车用「' + esc(q) + '」作为自定义词条</div>';
      return;
    }
    drop.innerHTML = items.map((it, i) =>
      '<div class="rel-opt' + (i === relSel ? " sel" : "") + '" data-rel-pick="' + esc(it.name) + '" data-rel-kind="' + it.kind + '" data-rel-label="' + esc(it.label) + '" data-rel-key="' + key + '">' +
        '<em class="rel-chip-badge' + (it.kind === "lex" ? " rel-chip-lex" : "") + '">' + esc(it.label) + '</em><span>' + esc(it.name) + '</span></div>').join("");
    drop.hidden = false;
  }
  function moveRelSel(d) {
    const drop = relDrop();
    if (!drop || drop.hidden) return;
    const opts = drop.querySelectorAll("[data-rel-pick]");
    if (!opts.length) return;
    relSel = (relSel + d + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("sel", i === relSel));
    const cur = opts[relSel];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function commitRel(key, inp) {
    const drop = relDrop();
    if (!drop || drop.hidden) { if (relQuery && inp) { addRel(key, relQuery, "", ""); inp.value = ""; relQuery = ""; } return; }
    const opts = drop.querySelectorAll("[data-rel-pick]");
    if (opts[relSel]) {
      const o = opts[relSel];
      addRel(o.getAttribute("data-rel-key") || key, o.getAttribute("data-rel-pick"), o.getAttribute("data-rel-kind"), o.getAttribute("data-rel-label"));
    } else if (relQuery) {
      addRel(key, relQuery, "", "");
    }
    if (inp) inp.value = "";
    relQuery = "";
    if (drop) drop.hidden = true;
    if (inp) inp.focus();
  }
  function openRelEntry(key, name) {
    const c = chipsOf(key).find(x => x.name === name);
    if (!c || c.kind === "raw" || !c.id) return;
    if (c.kind === "char") cat = "角色";
    else {
      const st = listOf("setting").find(x => x.id === c.id);
      cat = (st && st.category) || "其他";
    }
    renderCats();
    openEdit(c.id);
  }
  // 删除保护 + 反向引用：统计哪些条目在 related / relationships 里引用它
  function referencedBy(it) {
    const names = new Set([it.name].concat(String(it.aliases || "").split(REL_SEP).map(x => x.trim()).filter(Boolean)));
    const list = [];
    for (const st of listOf("setting")) {
      if (st.id === it.id) continue;
      if (splitRel(st.related).some(r => names.has(r))) list.push(st.name);
    }
    for (const c of listOf("character")) {
      if (c.id === it.id) continue;
      if (splitRel(c.relationships).some(r => names.has(r))) list.push(c.name);
    }
    return list;
  }

  /* ================= 开关 ================= */

  function open() {
    renderCats();
    render();
    el("lore-modal").classList.add("show");
  }
  function close() { el("lore-modal").classList.remove("show"); }

  /* ================= 渲染 ================= */

  function renderCats() {
    const wrap = el("lore-cats");
    if (!wrap) return;
    wrap.innerHTML = catList().map(c =>
      '<button type="button" class="lore-cat' + (c === cat ? " active" : "") + '" data-lore-cat="' + esc(c) + '">' + esc(c) +
      '<em class="lore-cat-n">' + catCount(c) + '</em></button>').join("");
  }

  // 搜索：跨全部文本字段；全局模式跨角色+设定
  function matchEntry(it, q) {
    const ql = q.toLowerCase();
    const hit = (s) => String(s == null ? "" : s).toLowerCase().includes(ql);
    if (hit(it.name) || hit(it.aliases) || hit(it.category) || hit(it.description)) return true;
    for (const [k, v] of Object.entries(it)) {
      if (["id", "type", "user", "src"].includes(k)) continue;
      if (typeof v === "string" && hit(v)) return true;
      if (k === "extra" && v && typeof v === "object") {
        for (const val of Object.values(v)) if (typeof val === "string" && hit(val)) return true;
      }
    }
    return false;
  }

  function render() {
    const q = query.trim();
    let items;
    if (loreGlobal) {
      items = (listOf("character") || []).concat(listOf("setting") || []);
    } else {
      items = catItems();
    }
    items = items.filter(it => !q || matchEntry(it, q));
    el("lore-count").textContent = (loreGlobal ? "全库" : cat) + " · " + items.length + " 张";
    el("lore-list").innerHTML = items.map(rowHtml).join("") ||
      '<div class="p-empty">' + (q ? '没有命中「' + esc(q) + '」' : "这个分类还没有设定卡。点「＋ 新增」或「导入 md」添加。") + '</div>';
  }

  function subTextOf(it) {
    if (typeOf(cat) === "character" && !loreGlobal) return (it.appearance || it.personality || "");
    if (it.description) return it.description;
    if (it.appearance || it.personality) return (it.appearance || "") + (it.personality || "");
    return "";
  }
  function rowHtml(it) {
    const sub = subTextOf(it);
    const badge = loreGlobal ? '<em class="lore-badge">' + esc(it.type === "character" ? "角色" : (it.category || "设定")) + '</em>' : "";
    const subH = query.trim() ? markHit(String(sub).slice(0, 60), query.trim()) : esc(String(sub).slice(0, 60));
    return '<div class="lore-item">' + badge +
      '<span class="lore-main">' + markHit(it.name || "未命名", query.trim()) + '</span>' +
      (sub ? '<span class="lore-sub dim">' + subH + '</span>' : "") +
      '<span class="lore-acts">' +
        '<button class="m-ins" data-lore-edit="' + esc(it.id) + '">编辑</button>' +
        '<button class="m-ins" data-lore-dup="' + esc(it.id) + '" title="复制为副本">复制</button>' +
        '<button class="m-del" data-lore-del="' + esc(it.id) + '">删除</button>' +
      '</span></div>';
  }
  function markHit(text, q) {
    text = String(text == null ? "" : text);
    const ql = q.toLowerCase();
    if (!q || !text.toLowerCase().includes(ql)) return esc(text);
    const out = [];
    let prev = 0, pos = 0;
    while (true) {
      const rel = text.toLowerCase().indexOf(ql, pos);
      if (rel === -1) break;
      out.push(esc(text.slice(prev, rel)));
      out.push("<mark>" + esc(text.slice(rel, rel + q.length)) + "</mark>");
      pos = rel + q.length; prev = pos;
    }
    out.push(esc(text.slice(prev)));
    return out.join("");
  }

  /* ================= 单条编辑 ================= */

  const CHAR_FIELDS = [
    { key: "name", label: "姓名", type: "text" },
    { key: "aliases", label: "别名 / 称呼", type: "text" },
    { key: "gender", label: "性别", type: "select", options: ["", "女", "男", "其他"], label2: o => o || "未设置" },
    { key: "appearance", label: "外貌", type: "textarea", rows: 2 },
    { key: "personality", label: "性格", type: "textarea", rows: 2 },
    { key: "habits", label: "口头禅 / 习惯", type: "textarea", rows: 2 },
    { key: "background", label: "背景", type: "textarea", rows: 2 },
    { key: "relationships", label: "关系", type: "textarea", rows: 2 },
    { key: "state", label: "当前状态", type: "textarea", rows: 2 },
    { key: "hooks", label: "关键钩子 / 伏笔", type: "textarea", rows: 2 },
    { key: "opening", label: "开场白（风格示范）", type: "textarea", rows: 2 },
    { key: "examples", label: "示例对话（每行一句）", type: "textarea", rows: 3 },
    { key: "notes", label: "备注", type: "textarea", rows: 2 }
  ];
  const SET_TAIL = [
    { key: "related", label: "相关角色 / 词条", type: "text" },
    { key: "rules", label: "规则 / 禁忌", type: "textarea", rows: 2 },
    { key: "notes", label: "备注", type: "textarea", rows: 2 }
  ];

  function openEdit(id) {
    const t = typeOf(cat);
    editType = t;
    const items = catItems();
    editEntry = id ? items.find(x => x.id === id) : null;
    editMode = "form";
    relLexOn = !!(window.Store && Store.getSettings().relIncludeLex);
    relQuery = ""; relSel = 0; relField = "";
    chips = {};
    extraRows = [];
    const e = editEntry || {};
    const ex = (e && e.extra) || {};
    if (editType === "character") {
      chips.aliases = splitRel(e.aliases).map(n => classifyChip("aliases", n));
      chips.relationships = splitRel(e.relationships).map(n => classifyChip("relationships", n));
      extraRows = Object.keys(ex).map(k => ({ label: k, value: ex[k] }));
      for (const f of catExtraOf("角色")) if (!(f.label in ex)) extraRows.push({ label: f.label, value: "" });
    } else {
      chips.related = splitRel(e.related).map(n => classifyChip("related", n));
      for (const f of Banks.catFields(cat)) if (f.type === "chip") chips[f.key] = splitRel(e[f.key]).map(n => classifyChip(f.key, n));
      extraRows = Object.keys(ex).map(k => ({ label: k, value: ex[k] }));
      for (const f of catExtraOf(cat)) if (!(f.label in ex)) extraRows.push({ label: f.label, value: "" });
    }
    el("lore-edit-title").textContent = (editEntry ? "编辑" : "新增") + " · " + cat;
    buildForm();
    el("lore-edit-form").hidden = false;
    el("lore-edit-mdwrap").hidden = true;
    el("lore-edit-md-err").hidden = true;
    setModeTabs();
    const delBtn = document.querySelector("[data-lore-del]");
    if (delBtn) delBtn.style.display = editEntry ? "" : "none";
    el("lore-edit-modal").classList.add("show");
  }

  // 分类级自定义模板字段（settings.catExtra）
  function catExtraOf(c) {
    const s = (window.Store && Store.getSettings()) || {};
    const m = (s.catExtra && s.catExtra[c]) || [];
    return Array.isArray(m) ? m : [];
  }

  function formVals() {
    const e = editEntry || {};
    if (editType === "character") return {
      name: e.name || "", aliases: e.aliases || "", gender: e.gender || "",
      appearance: e.appearance || "", personality: e.personality || "", habits: e.habits || "",
      background: e.background || "", relationships: e.relationships || "", state: e.state || "",
      hooks: e.hooks || "", opening: e.opening || "", examples: e.examples || "", notes: e.notes || ""
    };
    const vals = { name: e.name || "", related: e.related || "", rules: e.rules || "", notes: e.notes || "" };
    for (const f of Banks.catFields(cat)) vals[f.key] = e[f.key] || "";
    return vals;
  }

  function renderField(f, vals) {
    let input;
    if (CHIP_FIELDS[f.key]) {
      const cfg = CHIP_FIELDS[f.key];
      input = '<div class="rel-wrap" data-rel-picker="' + f.key + '">' +
        '<div class="rel-chips" data-rel-chips="' + f.key + '">' + chipsOf(f.key).map(chipHtml).join("") + '</div>' +
        '<div class="rel-search-row"><input type="text" class="rel-search" data-rel-search="' + f.key + '" placeholder="' + esc(cfg.hint) + '" autocomplete="off">' +
        (cfg.lex ? '<label class="rel-lex" title="搜索时也纳入词句库词汇"><input type="checkbox" data-rel-lex' + (relLexOn ? " checked" : "") + '><span>含词库</span></label>' : "") +
        '</div>' +
        '<div class="rel-drop" data-rel-drop hidden></div>' +
      '</div>';
    } else if (f.type === "select") {
      input = '<select data-lk="' + f.key + '">' + f.options.map(o =>
        '<option value="' + esc(o) + '"' + (vals[f.key] === o ? " selected" : "") + '>' + esc(f.label2(o)) + '</option>').join("") + '</select>';
    } else if (f.type === "textarea") {
      input = '<textarea data-lk="' + f.key + '" rows="' + (f.rows || 2) + '">' + esc(vals[f.key] || "") + '</textarea>';
    } else {
      input = '<input type="text" data-lk="' + f.key + '" value="' + esc(vals[f.key] || "") + '">';
    }
    return '<label class="ef-row"><span class="ef-label">' + f.label + (f.hint ? '<em>' + f.hint + '</em>' : "") + '</span>' + input + '</label>';
  }

  function extraRowHtml(r, i) {
    return '<div class="ef-row ef-extra-row"><span class="ef-label">自定义字段</span>' +
      '<div class="extra-row">' +
      '<input type="text" data-extra-label="' + i + '" placeholder="字段名" value="' + esc(r.label) + '">' +
      '<textarea data-extra-val="' + i + '" rows="1" placeholder="内容">' + esc(r.value) + '</textarea>' +
      '<button type="button" class="m-del" data-extra-rm="' + i + '" title="移除该字段">×</button>' +
      '</div></div>';
  }
  function syncExtraFromDom() {
    const wrap = el("lore-edit-form");
    const rows = [];
    wrap.querySelectorAll("[data-extra-label]").forEach(n => {
      const idx = n.getAttribute("data-extra-label");
      const v = wrap.querySelector('[data-extra-val="' + idx + '"]');
      rows.push({ label: n.value, value: v ? v.value : "" });
    });
    extraRows = rows;
  }

  function buildForm() {
    const wrap = el("lore-edit-form");
    const vals = formVals();
    const refInfo = editEntry
      ? (function () { const r = referencedBy(editEntry); return r.length ? '<div class="rel-ref-info">🔗 被 ' + r.length + ' 条引用：' + esc(r.join("、")) + '</div>' : ""; })()
      : "";
    let html = refInfo;
    if (editType === "setting") {
      html += '<label class="ef-row"><span class="ef-label">类别</span><input type="text" value="' + esc(cat) + '" readonly></label>';
    }
    const fields = editType === "character"
      ? CHAR_FIELDS
      : [{ key: "name", label: "名称", type: "text" }].concat(Banks.catFields(cat), SET_TAIL);
    html += fields.map(f => renderField(f, vals)).join("");
    html += extraRows.map(extraRowHtml).join("");
    html += '<div class="ef-row"><button type="button" class="sec-btn" data-extra-add>＋ 添加自定义字段</button></div>';
    wrap.innerHTML = html;
  }

  function readExtra() {
    const wrap = el("lore-edit-form");
    const out = {};
    wrap.querySelectorAll("[data-extra-label]").forEach(n => {
      const label = n.value.trim();
      if (!label) return;
      const idx = n.getAttribute("data-extra-label");
      const v = wrap.querySelector('[data-extra-val="' + idx + '"]');
      out[label] = v ? v.value.trim() : "";
    });
    return out;
  }

  function readForm() {
    const wrap = el("lore-edit-form");
    const get = (k) => { const n = wrap.querySelector('[data-lk="' + k + '"]'); return n ? n.value.trim() : ""; };
    const old = editEntry || {};
    if (editType === "character") {
      const out = {
        ...old, type: "character", user: true, name: get("name"),
        aliases: chipsOf("aliases").map(c => c.name).join("/"), gender: get("gender"),
        appearance: get("appearance"), personality: get("personality"), habits: get("habits"), background: get("background"),
        relationships: chipsOf("relationships").map(c => c.name).join("/"), state: get("state"), hooks: get("hooks"),
        opening: get("opening"), examples: get("examples"), notes: get("notes")
      };
      out.extra = readExtra();
      return out;
    }
    const out = { ...old, type: "setting", user: true, name: get("name"), category: cat };
    for (const f of Banks.catFields(cat)) {
      if (CHIP_FIELDS[f.key]) out[f.key] = chipsOf(f.key).map(c => c.name).join("/");
      else out[f.key] = get(f.key);
    }
    out.related = chipsOf("related").map(c => c.name).join("/");
    out.rules = get("rules"); out.notes = get("notes");
    out.extra = readExtra();
    return out;
  }

  function oneMd(entry) {
    if (editType === "character") return Banks.charToMd(entry);
    return Banks.settingToMd(entry);
  }

  function setModeTabs() {
    const mw = el("lore-edit-mode");
    if (mw) mw.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.getAttribute("data-lemode") === editMode));
  }

  function switchMode(m) {
    editMode = m;
    setModeTabs();
    if (m === "md") {
      el("lore-edit-form").hidden = true;
      el("lore-edit-mdwrap").hidden = false;
      el("lore-edit-md-err").hidden = true;
      el("lore-edit-md").value = oneMd(readForm());
    } else {
      el("lore-edit-form").hidden = false;
      el("lore-edit-mdwrap").hidden = true;
      buildForm();
    }
  }

  async function saveEdit() {
    let entry;
    if (editMode === "md") {
      const md = el("lore-edit-md").value;
      let arr = [];
      try {
        arr = editType === "character" ? Banks.parseCharacters(md, "custom.md") : Banks.parseSettings(md, "custom.md");
      } catch (e) {
        el("lore-edit-md-err").textContent = "解析失败：" + e.message; el("lore-edit-md-err").hidden = false; return;
      }
      if (arr.length !== 1) {
        el("lore-edit-md-err").textContent = "这里需要恰好 1 条，解析出 " + arr.length + " 条。" + (arr.length > 1 ? "多条请用「批量 md 编辑」。" : "");
        el("lore-edit-md-err").hidden = false;
        return;
      }
      entry = { ...arr[0], user: true, id: editEntry ? editEntry.id : undefined };
      if (editType === "setting") entry.category = cat;
      if (editEntry && editEntry.type) entry.type = editEntry.type;
    } else {
      entry = readForm();
    }
    if (!entry.id) entry.id = uid(editType === "character" ? "C" : "S");
    // 同名检测
    const dup = listOf(editType).find(o => o.id !== entry.id && o.name === entry.name);
    if (dup && !confirm("已存在同名「" + dup.name + "」，仍要保存吗？")) return;
    await Store.putAll(storeOf(editType), [entry]);
    await BankLoader.rebuild();
    el("lore-edit-modal").classList.remove("show");
    render();
    toast(editEntry ? "已更新" : "已新增");
  }

  async function doDel(id) {
    const it = catItems().find(x => x.id === id);
    if (!it) return;
    const refs = referencedBy(it);
    if (refs.length && !confirm("「" + (it.name || "未命名") + "」被以下条目引用：" + refs.join("、") + "，仍要删除？")) return;
    if (!confirm("删除「" + (it.name || "未命名") + "」？")) return;
    await Store.remove(storeOf(typeOf(cat)), [it.id]);
    await BankLoader.rebuild();
    el("lore-edit-modal").classList.remove("show");
    render();
    toast("已删除");
  }

  async function deleteEditEntry() {
    if (!editEntry) return;
    await doDel(editEntry.id);
  }

  /* ================= 复制条目 ================= */

  async function dupEntry(id) {
    const t = typeOf(cat);
    const it = catItems().find(x => x.id === id);
    if (!it) return;
    const copy = JSON.parse(JSON.stringify(it));
    copy.id = uid(t === "character" ? "C" : "S");
    copy.name = (copy.name || "未命名") + "·副本";
    delete copy.src;
    await Store.putAll(storeOf(t), [copy]);
    await BankLoader.rebuild();
    render();
    toast("已复制为「" + copy.name + "」");
  }

  /* ================= 导入去重（三选一弹窗，复用 UI.choice） ================= */

  function choiceDialog(title, msg) {
    return UI.choice({
      title, msg,
      options: [
        { value: "skip", label: "跳过重复" },
        { value: "overwrite", label: "覆盖为导入内容" },
        { value: "dup", label: "存为副本" }
      ],
      default: "skip"
    });
  }

  async function importParsed(t, items, label) {
    const existing = listOf(t);
    const byName = {};
    for (const x of existing) byName[x.name] = x;
    const dups = items.filter(x => byName[x.name]);
    let mode = "skip";
    if (dups.length) mode = await choiceDialog("发现 " + dups.length + " 条同名条目", "「" + dups[0].name + "」等已存在，如何处理？");
    if (mode === "skip") items = items.filter(x => !byName[x.name]);
    else if (mode === "dup") items = items.map(x => byName[x.name] ? { ...x, name: x.name + "·副本" } : x);
    else if (mode === "overwrite") {
      const names = new Set(dups.map(x => x.name));
      await Store.remove(storeOf(t), existing.filter(x => names.has(x.name)).map(x => x.id));
    }
    if (!items.length) { toast("没有新增条目（已全部跳过）"); return; }
    await Store.putAll(storeOf(t), items.map(e => ({ ...e, id: e.id || uid(t === "character" ? "C" : "S") })));
    await BankLoader.rebuild();
    render();
    toast("已导入 " + items.length + " 条" + (label ? "到「" + label + "」" : "") + (dups.length ? "，跳过/处理重复 " + dups.length + " 条" : ""));
  }

  /* ================= 分类管理（loreCats + catExtra） ================= */

  let catRows = [];
  function renderCatManage() {
    const list = el("lore-cat-list");
    if (!list) return;
    list.innerHTML = catRows.map((r, i) =>
      '<div class="catm-row"><div class="catm-head">' +
      '<input type="text" class="catm-name" data-catm-name="' + i + '" value="' + esc(r.name) + '">' +
      '<button class="m-ins" data-catm-up="' + i + '" title="上移">↑</button>' +
      '<button class="m-ins" data-catm-down="' + i + '" title="下移">↓</button>' +
      '<button class="m-del" data-catm-del="' + i + '" title="删除分类（条目归入其他）">×</button></div>' +
      '<div class="catm-fields">' + r.fields.map((f, fi) =>
        '<div class="catm-field"><input type="text" data-catm-flabel="' + i + '|' + fi + '" value="' + esc(f.label) + '" placeholder="模板字段名">' +
        '<select data-catm-ftype="' + i + '|' + fi + '"><option value="text"' + (f.type === "text" ? " selected" : "") + '>单行</option><option value="textarea"' + (f.type === "textarea" ? " selected" : "") + '>多行</option></select>' +
        '<button class="m-del" data-catm-fdel="' + i + '|' + fi + '" title="移除字段">×</button></div>'
      ).join("") +
      '<button class="sec-btn" data-catm-fadd="' + i + '">＋ 模板字段</button></div></div>'
    ).join("") +
      '<div class="catm-addcat"><button class="sec-btn" data-catm-addcat>＋ 新增分类</button></div>';
  }
  function openCatManage() {
    const s = Store.getSettings();
    const cats = catList();
    const ce = s.catExtra || {};
    catRows = cats.map(name => ({ name, orig: name, fields: (ce[name] || []).slice() }));
    renderCatManage();
    el("lore-cat-modal").classList.add("show");
  }
  function catm(i, act, key) {
    if (act === "addcat") { catRows.push({ name: "新分类", orig: "", fields: [] }); renderCatManage(); return; }
    if (act === "up") { if (i > 0) { const t = catRows[i]; catRows[i] = catRows[i - 1]; catRows[i - 1] = t; } renderCatManage(); return; }
    if (act === "down") { if (i < catRows.length - 1) { const t = catRows[i]; catRows[i] = catRows[i + 1]; catRows[i + 1] = t; } renderCatManage(); return; }
    if (act === "del") {
      const r = catRows[i];
      const affected = listOf("setting").filter(s => s.category === r.name).length;
      if (!confirm((affected ? "该分类下有 " + affected + " 条设定，删除后归入「其他」。\n" : "") + "删除分类「" + r.name + "」？")) return;
      if (affected) {
        Store.putAll("setting", listOf("setting").filter(s => s.category === r.name).map(s => ({ ...s, category: "其他" }))).then(() => BankLoader.rebuild());
      }
      catRows.splice(i, 1); renderCatManage(); return;
    }
    if (act === "fadd") { catRows[i].fields.push({ label: "", type: "textarea" }); renderCatManage(); return; }
    if (act === "fdel") { const sp = key.split("|"); catRows[+sp[0]].fields.splice(+sp[1], 1); renderCatManage(); return; }
  }
  async function saveCatManage() {
    const cats = [], catExtra = {};
    for (let i = 0; i < catRows.length; i++) {
      const r = catRows[i];
      const nameEl = document.querySelector('[data-catm-name="' + i + '"]');
      const name = (nameEl && nameEl.value || "").trim();
      if (!name) continue;
      cats.push(name);
      const fields = [];
      document.querySelectorAll('[data-catm-flabel^="' + i + '|"]').forEach(n => {
        const label = n.value.trim();
        if (!label) return;
        const key = n.getAttribute("data-catm-flabel");
        const ftype = document.querySelector('[data-catm-ftype="' + key + '"]');
        fields.push({ label, type: (ftype && ftype.value === "text") ? "text" : "textarea" });
      });
      catExtra[name] = fields;
      // 改名同步条目
      if (r.orig && r.orig !== name) {
        const affected = listOf("setting").filter(s => s.category === r.orig);
        if (affected.length && confirm("「" + r.orig + "」下有 " + affected.length + " 条设定，同步改到「" + name + "」？")) {
          await Store.putAll("setting", affected.map(s => ({ ...s, category: name })));
        }
      }
    }
    Store.updateSettings({ loreCats: cats, catExtra });
    if (!cats.includes(cat) && cats.length) cat = cats[0];
    await BankLoader.rebuild();
    el("lore-cat-modal").classList.remove("show");
    renderCats();
    render();
    toast("分类已保存");
  }

  /* ================= 导入 / 导出 / 批量 ================= */

  async function doImport() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".md,.txt";
    inp.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const raw = await readText(f);
      const t = typeOf(cat);
      let items = [];
      try {
        items = t === "character" ? Banks.parseCharacters(raw, f.name) : Banks.parseSettings(raw, f.name).map(e => ({ ...e, category: cat }));
      } catch (err) { toast("解析失败：" + err.message); return; }
      if (!items.length) { toast("没解析到条目，检查格式"); return; }
      await importParsed(t, items, cat);
    };
    inp.click();
  }

  function doExport() {
    const t = typeOf(cat);
    const items = t === "character" ? listOf("character") : listOf("setting").filter(s => s.category === cat);
    const md = t === "character" ? Banks.serializeCharacters(items) : Banks.serializeSettings(items);
    download(md, t === "character" ? "角色卡导出.md" : ("设定-" + cat + ".md"));
    toast("已导出 " + items.length + " 条");
  }

  function openBatch() {
    el("lore-batch-title").textContent = "批量 md 编辑 · " + cat;
    const t = typeOf(cat);
    const md = t === "character" ? Banks.serializeCharacters(listOf("character")) : Banks.serializeSettings(listOf("setting").filter(s => s.category === cat));
    el("lore-batch-md").value = md;
    el("lore-batch-err").hidden = true;
    el("lore-batch-modal").classList.add("show");
  }

  async function saveBatch() {
    // UX-06：保存大库时给"处理中"反馈
    const saveBtn = document.querySelector("[data-lore-batch-save]");
    const restoreBtn = () => { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "解析并保存"; } };
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    const md = el("lore-batch-md").value;
    const t = typeOf(cat);
    let items = [], err = "";
    try {
      items = t === "character" ? Banks.parseCharacters(md, "custom.md") : Banks.parseSettings(md, "custom.md").map(e => ({ ...e, category: cat }));
    } catch (e) { err = "解析失败：" + e.message; }
    if (!err && !items.length) err = "解析出 0 条，检查格式";
    if (err) { el("lore-batch-err").textContent = err; el("lore-batch-err").hidden = false; restoreBtn(); return; }
    if (t === "character") {
      // 整表替换角色卡
      await Store.clear("character");
      await Store.putAll("character", items.map((e, i) => ({ ...e, id: e.id || "CB" + i })));
    } else {
      // 只替换本分类的设定卡，其它分类保留
      const others = listOf("setting").filter(s => s.category !== cat);
      await Store.clear("setting");
      await Store.putAll("setting", others.concat(items.map((e, i) => ({ ...e, id: e.id || "SB" + i }))));
    }
    await BankLoader.rebuild();
    el("lore-batch-modal").classList.remove("show");
    render();
    toast("已保存 " + items.length + " 条");
    restoreBtn();
  }

  /* ================= 小工具 ================= */

  const readText = U.readText;
  const download = U.download;
  const esc = U.esc;
  const toast = U.toast;
  const uid = (p) => U.uid(p || "S");

  /* ================= 事件 ================= */

  function bind() {
    document.addEventListener("click", e => {
      // related 检索选择器：点外部关闭下拉
      const picker = e.target.closest("[data-rel-picker]");
      if (!picker) { const rd = relDrop(); if (rd) rd.hidden = true; }
      if (e.target.closest("[data-rel-x]")) {
        const p = e.target.closest("[data-rel-picker]");
        if (p) removeRel(p.getAttribute("data-rel-picker"), e.target.closest("[data-rel-x]").getAttribute("data-rel-x"));
      }
      else if (e.target.closest("[data-rel-open]")) {
        const p = e.target.closest("[data-rel-picker]");
        if (p) openRelEntry(p.getAttribute("data-rel-picker"), e.target.closest("[data-rel-open]").getAttribute("data-rel-open"));
      }
      else if (e.target.closest("[data-rel-pick]")) {
        const o = e.target.closest("[data-rel-pick]");
        addRel(o.getAttribute("data-rel-key") || "", o.getAttribute("data-rel-pick"), o.getAttribute("data-rel-kind"), o.getAttribute("data-rel-label"));
        const rd = relDrop();
        if (rd) { rd.hidden = true; rd.innerHTML = ""; }
        const k = o.getAttribute("data-rel-key") || "";
        const si = document.querySelector('[data-rel-search="' + k + '"]');
        if (si) { si.value = ""; relQuery = ""; si.focus(); }
      }
      else if (e.target.closest("[data-lore-open]")) open();
      else if (e.target.closest("[data-lore-cat]")) {
        cat = e.target.closest("[data-lore-cat]").getAttribute("data-lore-cat");
        query = "";
        el("lore-search").value = "";
        renderCats();
        render();
      }
      else if (e.target.closest("[data-lore-add]")) openEdit(null);
      else if (e.target.closest("[data-lore-edit]")) openEdit(e.target.closest("[data-lore-edit]").getAttribute("data-lore-edit"));
      else if (e.target.closest("[data-lore-del]")) {
        const b = e.target.closest("[data-lore-del]");
        const raw = b.getAttribute("data-lore-del");
        if (raw) doDel(raw);
        else deleteEditEntry();
      }
      else if (e.target.closest("[data-lore-import]")) doImport();
      else if (e.target.closest("[data-lore-export]")) doExport();
      else if (e.target.closest("[data-lore-batch]")) openBatch();
      else if (e.target.closest("[data-lore-batch-save]")) saveBatch();
      else if (e.target.closest("[data-lore-batch-cancel]") || e.target.closest("[data-lore-batch-mask]")) el("lore-batch-modal").classList.remove("show");
      else if (e.target.closest("[data-lore-refresh]")) BankLoader.rebuild().then(() => { render(); toast("已刷新"); });
      else if (e.target.closest("[data-lore-close]") || e.target.closest("[data-lore-mask]")) close();
      else if (e.target.closest("[data-lore-edit-save]")) saveEdit();
      else if (e.target.closest("[data-lore-edit-cancel]") || e.target.closest("[data-lore-edit-mask]")) el("lore-edit-modal").classList.remove("show");
      else if (e.target.closest("[data-lemode]")) {
        const b = e.target.closest("[data-lemode]");
        if (editType !== typeOf(cat)) { editType = typeOf(cat); editEntry = null; }
        switchMode(b.getAttribute("data-lemode"));
      }
      else if (e.target.closest("[data-lore-dup]")) dupEntry(e.target.closest("[data-lore-dup]").getAttribute("data-lore-dup"));
      else if (e.target.closest("[data-lore-catm]")) openCatManage();
      else if (e.target.closest("[data-lore-catm-save]")) saveCatManage();
      else if (e.target.closest("[data-lore-catm-cancel]") || e.target.closest("[data-lore-catm-mask]")) el("lore-cat-modal").classList.remove("show");
      else if (e.target.closest("[data-catm-addcat]")) catm(0, "addcat");
      else if (e.target.closest("[data-catm-up]")) catm(+e.target.closest("[data-catm-up]").getAttribute("data-catm-up"), "up");
      else if (e.target.closest("[data-catm-down]")) catm(+e.target.closest("[data-catm-down]").getAttribute("data-catm-down"), "down");
      else if (e.target.closest("[data-catm-del]")) catm(+e.target.closest("[data-catm-del]").getAttribute("data-catm-del"), "del");
      else if (e.target.closest("[data-catm-fadd]")) catm(+e.target.closest("[data-catm-fadd]").getAttribute("data-catm-fadd"), "fadd");
      else if (e.target.closest("[data-catm-fdel]")) {
        const sp = e.target.closest("[data-catm-fdel]").getAttribute("data-catm-fdel");
        catm(+sp.split("|")[0], "fdel", sp);
      }
      else if (e.target.closest("[data-extra-add]")) { syncExtraFromDom(); extraRows.push({ label: "", value: "" }); buildForm(); }
      else if (e.target.closest("[data-extra-rm]")) {
        syncExtraFromDom();
        const i = +e.target.closest("[data-extra-rm]").getAttribute("data-extra-rm");
        if (extraRows[i]) extraRows.splice(i, 1);
        buildForm();
      }
    });
    const srch = el("lore-search");
    if (srch) {
      let t = null;
      srch.addEventListener("input", e => { query = e.target.value; clearTimeout(t); t = setTimeout(render, 150); });
    }
    // related 检索选择器：输入即搜（委托绑定，表单动态生成）
    document.addEventListener("input", e => {
      if (e.target && e.target.matches && e.target.matches("[data-rel-search]")) onRelInput(e.target.getAttribute("data-rel-search"), e.target);
    });
    document.addEventListener("keydown", e => {
      const inp = e.target;
      if (!inp || !inp.matches || !inp.matches("[data-rel-search]")) return;
      const k = inp.getAttribute("data-rel-search");
      if (e.key === "Enter") { e.preventDefault(); commitRel(k, inp); }
      else if (e.key === "ArrowDown") { e.preventDefault(); moveRelSel(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveRelSel(-1); }
      else if (e.key === "Escape") { const d = relDrop(); if (d) d.hidden = true; inp.blur(); }
      else if (e.key === "Backspace" && !inp.value && chipsOf(k).length) removeRel(k, chipsOf(k)[chipsOf(k).length - 1].name);
    });
    // 含词库开关（全局持久化）
    document.addEventListener("change", e => {
      if (e.target && e.target.matches && e.target.matches("[data-rel-lex]")) {
        relLexOn = e.target.checked;
        if (window.Store) Store.updateSettings({ relIncludeLex: relLexOn });
      }
      if (e.target && e.target.matches && e.target.matches("#lore-global")) {
        loreGlobal = e.target.checked;
        render();
      }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        el("lore-modal").classList.remove("show");
        el("lore-edit-modal").classList.remove("show");
        el("lore-batch-modal").classList.remove("show");
        UI.close("lore-cat-modal");
        UI.close("ui-choice-modal");
      }
    });
  }

  bind();

  return { open, close };
})();

window.LoreManager = LoreManager;
