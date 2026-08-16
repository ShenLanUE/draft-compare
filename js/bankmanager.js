"use strict";
/* bankmanager.js — 词句库管理（增删改查 + md 编辑 + 导入导出 + 格式说明） */

const BankManager = (function () {

  const el = id => document.getElementById(id);
  const PAGE = 50;
  const GOLDEN_CATS = ["battle", "dialogue", "emotion", "entrance", "environment", "micro-action", "micro-expression", "payoff"];
  const ANTI_LEVELS = ["T1", "T2", "T3", "ctx", "emotionReplace", "pattern"];
  const TAB_LABEL = { lexicon: "词库", golden: "黄金句", anti: "反AI规则", fav: "常用词句" };

  let tab = "lexicon";       // lexicon | golden | anti | fav
  let query = "";
  let catFilter = "";
  let page = 0;
  let listData = [];
  let editType = "lexicon";  // 当前编辑的类型
  let editEntry = null;      // 正在编辑的条目（null=新增）
  let editMode = "form";     // form | md

  /* ================= 打开 / 关闭 ================= */

  function open() {
    reset();
    render();
    el("bank-modal").classList.add("show");
  }
  function close() { el("bank-modal").classList.remove("show"); }
  function reset() { query = ""; catFilter = ""; page = 0; el("bank-search").value = ""; el("bank-cat").value = ""; }

  function onDataChanged() { if (el("bank-modal").classList.contains("show")) render(); }

  /* ================= 数据访问 ================= */

  function storeOf(t) { return t === "lexicon" ? "bank" : t === "golden" ? "golden" : t === "anti" ? "anti" : t; }
  function listOf(t) {
    const s = (window.BankLoader && BankLoader.state) || { lexicon: [], golden: [], anti: [], favs: [], characters: [], settings: [] };
    return s[t === "fav" ? "favs" : t];
  }

  /* ================= 渲染 ================= */

  function render() {
    renderTabs();
    renderCatFilter();
    // 工具栏按 tab 显隐（常用词句用自己的一套编辑；刷新按钮始终显示）
    const isFavTab = tab === "fav";
    ["bank-import-btn", "bank-export-btn", "bank-batch-btn", "bank-cat-btn", "bank-reset-btn"].forEach(id => {
      const n = el(id);
      if (n) n.style.display = isFavTab ? "none" : "";
    });
    const srch = el("bank-search");
    if (srch) srch.style.display = isFavTab ? "none" : "";
    if (tab === "fav") { renderFavBody(); return; }
    const list = filtered();
    listData = list;
    const total = list.length;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    if (page >= pages) page = pages - 1;
    const shown = list.slice(page * PAGE, (page + 1) * PAGE);
    el("bank-count").textContent = "共 " + total + " 条";
    el("bank-page-info").textContent = (pages > 1 ? "第 " + (page + 1) + "/" + pages + " 页 · " : "") + total + " 条";
    el("bank-list").innerHTML = shown.map(rowHtml).join("") || emptyHtml();
    el("bank-prev").disabled = page <= 0;
    el("bank-next").disabled = page >= pages - 1;
  }

  // 常用词句：内联文本框编辑 + 保存/导入/导出 + 列表逐条删
  function renderFavBody() {
    const favs = (BankLoader.state.favs) || [];
    el("bank-count").textContent = "共 " + favs.length + " 条";
    el("bank-page-info").textContent = "";
    el("bank-prev").disabled = true;
    el("bank-next").disabled = true;
    el("bank-list").innerHTML =
      '<div class="fav-edit">' +
        '<textarea id="fav-edit-ta" placeholder="每行一条常用词句或短句，保存后自动参与补全">' + esc(favs.join("\n")) + '</textarea>' +
        '<div class="fav-edit-actions">' +
          '<button class="main-btn" data-bank-fav-save>保存修改</button>' +
          '<button class="sec-btn" data-bank-fav-import>导入 txt</button>' +
          '<button class="sec-btn" data-bank-fav-export>导出 txt</button>' +
        '</div>' +
      '</div>' +
      '<div class="fav-list">' + (favs.length ? favs.map((t, i) =>
        '<div class="bk-item"><span class="bk-main">' + esc(t) + '</span>' +
        '<span class="bk-acts"><button class="m-del" data-bank-fav-del="' + i + '">删除</button></span></div>'
      ).join("") : '<div class="p-empty">还没有常用词句，直接在上方文本框输入即可。</div>') + '</div>';
  }

  function renderTabs() {
    document.querySelectorAll("#bank-tabs button").forEach(b => b.classList.toggle("active", b.getAttribute("data-btab") === tab));
  }
  function renderCatFilter() {
    const sel = el("bank-cat");
    const cur = sel.value;
    let opts;
    if (tab === "lexicon") opts = Banks.categories().map(c => ({ v: c, l: Banks.catLabel(c) }));
    else if (tab === "golden") opts = GOLDEN_CATS.map(c => ({ v: c, l: Banks.catLabel(c) }));
    else opts = [];
    sel.style.display = opts.length ? "" : "none";
    sel.innerHTML = '<option value="">全部分类</option>' + opts.map(o => '<option value="' + o.v + '">' + o.l + '</option>').join("");
    sel.value = cur;
  }

  function filtered() {
    const all = listOf(tab);
    const q = query.trim();
    const out = all.filter(it => {
      if (tab === "fav") { return !q || String(it).includes(q); }
      if (catFilter && it.category !== catFilter) return false;
      if (!q) return true;
      const word = (it.word || it.original || it.emotion || it.name || (it.terms || []).join("") || "");
      const gloss = (it.gloss || it.replacement || "") + (it.example || it.why || "");
      const catName = Banks.catLabel(it.category);   // 支持按「小动作/小神态」等中文分类名搜索
      return String(word).includes(q) || String(gloss).includes(q) || String(catName).includes(q);
    });
    return out;
  }

  function rowHtml(it, i) {
    const isFav = tab === "fav";
    const user = isFav ? true : !!it.user;
    let badge = isFav ? "常用" : user ? "自定义" : "内置";
    let main, sub;
    main = isFav ? String(it) : (it.word || (it.original || "").slice(0, 24) || it.emotion || (it.terms || []).join("、") || (it.name || ""));
    if (sub == null) sub = isFav ? "" : (tab === "lexicon" ? it.gloss : tab === "golden" ? (it.book || "") + " · " + (it.source || "") : it.replacement || it.note || "");
    return '<div class="bk-item" data-idx="' + (page * PAGE + i) + '">' +
      '<span class="bk-badge' + (user ? " user" : "") + '">' + badge + '</span>' +
      '<span class="bk-main">' + esc(main) + '</span>' +
      (sub ? '<span class="bk-sub">' + esc(String(sub).slice(0, 60)) + '</span>' : "") +
      '<span class="bk-acts">' +
        (isFav ? '' : '<button class="m-ins" data-bk-edit="' + (page * PAGE + i) + '">编辑</button>') +
        '<button class="m-del" data-bk-del="' + (page * PAGE + i) + '">删除</button>' +
      '</span></div>';
  }

  function emptyHtml() {
    return '<div class="p-empty">没有条目' + (query ? '，换个关键词试试' : '') +
      '。点右上「＋ 新增」或「导入 md」添加；不知道怎么写的词库格式，点下方「格式说明」。</div>';
  }

  /* ================= 工具栏 ================= */

  function doAdd() {
    if (tab === "fav") {
      const t = el("fav-edit-ta");
      if (t) { t.value = (t.value ? t.value + "\n" : ""); t.focus(); t.scrollTop = t.scrollHeight; }
      return;
    }
    openEditor(tab, null);
  }
  function doEdit(i) { openEditor(tab, listData[i]); }
  async function doDelete(i) {
    const it = listData[i];
    if (tab === "fav") {
      const arr = (BankLoader.state.favs || []).slice();
      arr.splice(i, 1);
      saveFavsArr(arr);
      return;
    }
    if (!confirm("确定删除这条吗？\n「" + (it.word || (it.original || "").slice(0, 16) || it.emotion || "") + "」")) return;
    await Store.remove(storeOf(tab), [it.id]);
    await BankLoader.rebuild();
    toast("已删除");
  }

  /* ---- 常用词句 tab 专用 ---- */
  function bankFavSave() {
    const t = el("fav-edit-ta");
    if (!t) return;
    const lines = t.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
    saveFavsArr(lines);
  }
  function bankFavExport() {
    download(Banks.serializeFav(BankLoader.state.favs || []), "常用词句导出.txt");
    toast("已导出");
  }
  function bankFavImport() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".txt,.md";
    inp.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const t = await readText(f);
      const lines = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      saveFavsArr(lines);
      toast("已导入 " + lines.length + " 条常用词句");
    };
    inp.click();
  }
  function bankFavDel(i) {
    const arr = (BankLoader.state.favs || []).slice();
    arr.splice(i, 1);
    saveFavsArr(arr);
  }

  function doImport() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".md,.txt";
    inp.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const raw = await readText(f);
      const kindMap = { lexicon: "lexicon", golden: "golden", anti: "anti" };
      const n = await BankLoader.importFiles([{ kind: kindMap[tab], raw, file: f }]);
      toast("已导入 " + n + " 条");
    };
    inp.click();
  }

  function doExport() {
    const all = listOf(tab);
    let md, name;
    if (tab === "lexicon") { md = Banks.serializeLexicon(all); name = "词库导出.md"; }
    else if (tab === "golden") { md = Banks.serializeGolden(all); name = "黄金句导出.md"; }
    else if (tab === "anti") { md = Banks.serializeAnti(all); name = "反AI规则导出.md"; }
    else { md = Banks.serializeFav(all); name = "常用词句导出.txt"; }
    download(md, name);
    toast("已导出 " + all.length + " 条");
  }

  async function doReset() {
    if (!confirm("重置为内置词库？\n所有自定义修改和删除都会清除，恢复出厂内置词库。")) return;
    await BankLoader.resetAll();
    toast("已重置为内置词库");
  }

  /* ================= 分类管理 ================= */

  function collectCategories() {
    const counts = {};
    const list = (BankLoader.state.lexicon || []).concat(BankLoader.state.golden || []);
    for (const e of list) { const c = e.category || "custom"; counts[c] = (counts[c] || 0) + 1; }
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(c => ({ slug: c, count: counts[c] }));
  }
  function openCatManage() {
    const cats = collectCategories();
    const catLabels = Store.getSettings().catLabels || {};
    el("cat-list").innerHTML = cats.map(c =>
      '<div class="cat-row">' +
        '<input type="text" class="cat-slug" value="' + esc(c.slug) + '" readonly title="分类键（显示用名在此修改）">' +
        '<input type="text" class="cat-name" value="' + esc(catLabels[c.slug] || Banks.catLabel(c.slug)) + '" placeholder="显示名">' +
        '<span class="cat-count">' + c.count + ' 条</span>' +
      '</div>').join("") || '<div class="p-empty">暂无分类</div>';
    el("cat-modal").classList.add("show");
  }
  function saveCatManage() {
    const map = {};
    el("cat-list").querySelectorAll(".cat-row").forEach(r => {
      const slug = r.querySelector(".cat-slug").value;
      const name = r.querySelector(".cat-name").value.trim();
      if (name && name !== Banks.catLabel(slug)) map[slug] = name;
    });
    Store.updateSettings({ catLabels: map });
    Banks.setCatOverrides(map);
    BankLoader.rebuild();
    el("cat-modal").classList.remove("show");
    toast("分类名已保存");
  }

  /* ================= 批量 md 编辑 ================= */

  function openBatch() {
    el("batch-title").textContent = "批量 md 编辑 · " + TAB_LABEL[tab];
    let md;
    if (tab === "lexicon") md = Banks.serializeLexicon(BankLoader.state.lexicon);
    else if (tab === "golden") md = Banks.serializeGolden(BankLoader.state.golden);
    else if (tab === "anti") md = Banks.serializeAnti(BankLoader.state.anti);
    else md = Banks.serializeFav(BankLoader.state.favs);
    el("batch-md").value = md;
    el("batch-err").hidden = true;
    el("batch-modal").classList.add("show");
  }

  async function saveBatch() {
    // UX-06：保存大库时给"处理中"反馈，避免作者以为卡死
    const saveBtn = document.querySelector("[data-batch-save]");
    const restoreBtn = () => { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "解析并保存"; } };
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "保存中…"; }
    const md = el("batch-md").value;
    let items = [], err = "";
    try {
      if (tab === "lexicon") items = Banks.parseLexicon(md, "custom.md").map(e => ({ ...e, user: true }));
      else if (tab === "golden") items = Banks.parseGolden(md, "custom.md").map(e => ({ ...e, user: true }));
      else if (tab === "anti") items = Banks.parseAntiRules(md).map(r => ({ type: "anti", ...r, user: true }));
      else items = md.split(/\n+/).map(s => s.trim()).filter(Boolean);
    } catch (e) { err = "解析失败：" + e.message; }
    if (!err && tab !== "fav" && !items.length) err = "解析出 0 条，检查格式";
    if (err) { el("batch-err").textContent = err; el("batch-err").hidden = false; restoreBtn(); return; }
    // 整库替换
    const store = tab === "fav" ? null : storeOf(tab);
    if (store) {
      await Store.clear(store);
      await Store.putAll(store, items.map((e, i) => ({ ...e, id: e.id || (tab === "lexicon" ? "L" : tab === "golden" ? "G" : "A") + "B" + i })));
    } else {
      saveFavsArr(items);
    }
    await BankLoader.rebuild();
    el("batch-modal").classList.remove("show");
    toast("已保存 " + items.length + " 条");
    restoreBtn();
  }

  /* ================= 单条编辑（表单 / md） ================= */

  function openEditor(type, entry) {
    editType = type;
    editEntry = entry;
    editMode = "form";
    el("entry-title").textContent = (entry ? "编辑" : "新增") + " · " + TAB_LABEL[type];
    buildForm(type, entry);
    el("entry-form").hidden = false;
    el("entry-mdwrap").hidden = true;
    el("entry-md-err").hidden = true;
    el("entry-mode-tabs").style.display = type === "anti" ? "none" : "";
    setModeTabs();
    el("entry-modal").classList.add("show");
  }

  function buildForm(type, entry) {
    const wrap = el("entry-form");
    const defs = FORM_FIELDS[type];
    const vals = formVals(type, entry);
    wrap.innerHTML = defs.map((f, i) => {
      let input;
      if (f.type === "select") {
        let opts = f.options.slice();
        // 分类下拉：确保当前值在列 + 提供「新建分类」
        if (f.key === "category") {
          if (vals[f.key] && !opts.includes(vals[f.key])) opts.push(vals[f.key]);
          input = '<select data-fk="' + f.key + '">' +
            opts.map(o => '<option value="' + esc(o) + '"' + (vals[f.key] === o ? " selected" : "") + '>' + esc(f.label2(o)) + '</option>').join("") +
            '<option value="__new__">＋ 新建分类…</option></select>' +
            '<input type="text" data-fk="cat-new" placeholder="新分类名（保存后作为分类）" style="display:none">';
        } else {
          input = '<select data-fk="' + f.key + '">' + f.options.map(o => '<option value="' + esc(o) + '"' + (vals[f.key] === o ? " selected" : "") + '>' + esc(f.label2(o)) + '</option>').join("") + '</select>';
        }
      } else if (f.type === "textarea") {
        input = '<textarea data-fk="' + f.key + '" rows="' + (f.rows || 2) + '">' + esc(vals[f.key] || "") + '</textarea>';
      } else {
        input = '<input type="text" data-fk="' + f.key + '" value="' + esc(vals[f.key] || "") + '">';
      }
      return '<label class="ef-row"><span class="ef-label">' + f.label + (f.hint ? '<em>' + f.hint + '</em>' : "") + '</span>' + input + '</label>';
    }).join("");
    // 新建分类输入框显隐
    const catSel = wrap.querySelector('[data-fk="category"]');
    const catNew = wrap.querySelector('[data-fk="cat-new"]');
    if (catSel && catNew) {
      const toggle = () => { catNew.style.display = catSel.value === "__new__" ? "" : "none"; if (catSel.value === "__new__") catNew.focus(); };
      catSel.addEventListener("change", toggle);
      toggle();
    }
  }

  function formVals(type, entry) {
    const e = entry || {};
    const tagStr = (e.tags || []).join(" / ");
    const genreStr = (e.genreTags || []).join(" ");
    if (type === "lexicon") return { word: e.word || "", category: e.category || "micro-action", tags: tagStr, genreTags: genreStr, gloss: e.gloss || "", example: e.example || "", hint: e.hint || "", antiAI: e.antiAI || "" };
    if (type === "golden") return { original: e.original || "", category: e.category || "battle", book: e.book || "", source: e.source || "", tags: tagStr, genreTags: genreStr, why: e.why || "", how: e.how || "", antiAI: e.antiAI || "" };
    if (type === "anti") return {
      level: e.level || "T1",
      terms: (e.terms || []).join("、"),
      threshold: e.thresh ? (e.thresh.op || "≤") + e.thresh.max + "次/" + (e.thresh.per || "章") : (e.note || ""),
      emotion: e.emotion || "",
      replacement: e.replacement || "",
      note: e.note || ""
    };
    return {};
  }

  function readForm(type) {
    const wrap = el("entry-form");
    const get = (k) => {
      const node = wrap.querySelector('[data-fk="' + k + '"]');
      return node ? node.value.trim() : "";
    };
    const tags = get("tags").split(/[/／、|]/).map(s => s.trim()).filter(Boolean);
    const genre = get("genreTags").split(/[\s、，,]+/).map(s => s.trim()).filter(Boolean);
    // 分类：若选了「新建分类」，用新名字
    let cat = get("category");
    if (cat === "__new__") { cat = get("cat-new") || "custom"; }
    const old = editEntry || {};
    if (type === "lexicon") {
      const word = get("word");
      return { ...old, type: "lexicon", user: true, category: cat || "custom", tags, genreTags: genre, word, terms: Banks.splitTerms(word), gloss: get("gloss"), example: get("example"), hint: get("hint"), antiAI: get("antiAI") || null };
    }
    if (type === "golden") {
      return { ...old, type: "golden", user: true, category: cat || "battle", book: get("book"), source: get("source"), tags, genreTags: genre, original: get("original"), why: get("why"), how: get("how"), antiAI: get("antiAI") || null };
    }
    if (type === "anti") {
      const level = get("level");
      const terms = get("terms").split(/[/／、，,；;]/).map(s => s.trim()).filter(Boolean);
      const thText = get("threshold");
      const m = thText.match(/([≤<>=]?)\s*([\d.]+)\s*次?\s*\/?\s*(章|500字|段|场景|千字)?/);
      const thresh = level === "ctx" && m ? { op: m[1] || "≤", max: parseFloat(m[2]), per: m[3] || "章" } : null;
      return { ...old, type: "anti", user: true, level, terms, replacement: get("replacement"), note: thText, thresh, emotion: get("emotion") };
    }
    return old;
  }

  function oneMd(type, entry) {
    if (type === "lexicon") return Banks.entryToMd(entry);
    if (type === "golden") return Banks.goldenToMd(entry);
    return "";
  }

  function setModeTabs() {
    document.querySelectorAll("#entry-mode-tabs button").forEach(b => b.classList.toggle("active", b.getAttribute("data-emode") === editMode));
  }

  function switchMode(m) {
    editMode = m;
    setModeTabs();
    if (m === "md") {
      el("entry-form").hidden = true;
      el("entry-mdwrap").hidden = false;
      el("entry-md-err").hidden = true;
      el("entry-md").value = oneMd(editType, readForm(editType));
    } else {
      el("entry-form").hidden = false;
      el("entry-mdwrap").hidden = true;
      buildForm(editType, readForm(editType));
    }
  }

  async function saveEntry() {
    let entry;
    if (editMode === "md") {
      const md = el("entry-md").value;
      let arr = [];
      try {
        if (editType === "lexicon") arr = Banks.parseLexicon(md, "custom.md");
        else if (editType === "golden") arr = Banks.parseGolden(md, "custom.md");
      }
      catch (e) { el("entry-md-err").textContent = "解析失败：" + e.message; el("entry-md-err").hidden = false; return; }
      if (arr.length !== 1) {
        el("entry-md-err").textContent = "这里需要恰好 1 条，解析出 " + arr.length + " 条。" + (arr.length > 1 ? "多条请用「批量 md 编辑」。" : "");
        el("entry-md-err").hidden = false;
        return;
      }
      entry = { ...arr[0], user: true, id: editEntry ? editEntry.id : undefined };
      if (editEntry && editEntry.type) entry.type = editEntry.type;
    } else {
      entry = readForm(editType);
    }
    if (!entry.id) entry.id = uid("U");
    // 重复检测（词库/黄金句同分类同词）
    if ((editType === "lexicon" || editType === "golden") && entry.terms && entry.terms.length) {
      const list = editType === "lexicon" ? BankLoader.state.lexicon : BankLoader.state.golden;
      const dup = list.find(o => o.id !== entry.id && o.category === entry.category && (o.terms || []).some(t => entry.terms.includes(t)));
      if (dup) {
        if (!confirm("该分类下已有「" + dup.word + "」，仍要保存吗？")) return;
      }
    }
    await Store.putAll(storeOf(editType), [entry]);
    await BankLoader.rebuild();
    el("entry-modal").classList.remove("show");
    // 新增后定位到新词条
    if (!editEntry) {
      query = (entry.word || entry.original || entry.name || (entry.terms || [])[0] || entry.emotion || "").slice(0, 12);
      page = 0;
      el("bank-search").value = query;
    }
    render();
    if (!listData.length && query) { query = ""; catFilter = ""; el("bank-search").value = ""; el("bank-cat").value = ""; render(); }
    toast(editEntry ? "已更新" : "已新增");
  }

  /* ================= 格式说明 ================= */

  function openHelp() {
    el("help-body").innerHTML = helpHtml();
    el("help-modal").classList.add("show");
  }

  function helpHtml() {
    const path = location.href.replace(/[^/]*$/, "");
    return '<h3>一、词句库放哪里</h3>' +
      '<pre class="help-code">' + esc(
        (path || "扩展目录/") + "\n" +
        "  banks\\\n" +
        "    lexicon\\*.md          ← 词库（外貌/情绪/小动作/小神态…）\n" +
        "    golden-sentences\\*.md ← 黄金例句库\n" +
        "    anti-ai\\*.md          ← 反AI规则库\n" +
        "  js\\banks-data.js         ← 打包时自动生成的预解析数据（别手改）"
      ) + '</pre>' +
      '<p>词库文件放进对应子目录后：<b>打包时自动重新生成</b>（node pack.js）。当前界面里改的话存浏览器本地，点「重置内置」恢复这份。</p>' +
      '<h3>二、词库格式（lexicon）</h3>' +
      '<pre class="help-code">' + esc(
        "# 小动作库\n" +
        "## 紧张\n" +
        "- **攥衣角** — 桌下那只手捏成拳，紧张/忍怒。[通用]\n" +
        "  例句：桌下那只手早捏成了拳头，面上却还在笑。\n" +
        "  提示：桌下藏手是关键。\n" +
        "  ⚠ 反AI：避免连用套路。\n" +
        "\n" +
        "说明：**词** — 释义 [通用/古风/都市]；缩进行可写 例句：/ 提示：/ ⚠ 反AI：/ 分类："
      ) + '</pre>' +
      '<h3>三、黄金句格式（golden-sentences）</h3>' +
      '<pre class="help-code">' + esc(
        "## 书名 [都市]\n" +
        "### 紧张 / 心虚\n" +
        "**原句**：关门的手停住了，她看着酒瓶下意识咽了咽口水。\n" +
        "> 来源：《书名》·第X章 [都市]\n" +
        "**好在哪里**：三个动作递进，零心理描写。\n" +
        "**怎么用**：给角色找一扇\"门\"。"
      ) + '</pre>' +
      '<h3>四、反AI规则格式（anti-ai）</h3>' +
      '<pre class="help-code">' + esc(
        "## 一级禁用词（出现即替换）\n" +
        "| 词 | 替换策略 |\n" +
        "|----|---------|\n" +
        "| 仿佛、犹如 | 删除或白描 |\n" +
        "\n" +
        "## 语境敏感类\n" +
        "| 词 | 阈值 | 替换策略 |\n" +
        "|----|------|---------|\n" +
        "| 突然、忽然 | ≤4次/章 | 红线段落从宽 |"
      ) + '</pre>' +
      '<h3>五、角色卡格式（character）</h3>' +
      '<pre class="help-code">' + esc(
        "# 角色卡\n" +
        "## 林晚\n" +
        "- **别名**：晚晚 / 阿晚\n" +
        "- **性别**：女\n" +
        "- **外貌**：黑长直，左眼角泪痣，常穿月白长裙\n" +
        "- **性格**：外冷内热，嘴硬心软\n" +
        "- **口头禅/习惯**：咬指甲；爱说\"随你\"\n" +
        "- **关系**：李恪的青梅；与苏瑶不合\n" +
        "- **当前状态**：中毒昏迷，被李恪所救\n" +
        "- **关键钩子**：十年前的失火真相未明\n" +
        "- **开场白**：*她抬眼，泪痣在烛火下一闪。*\"醒了？\"\n" +
        "- **示例对话**：\n" +
        "  > \"随你。\"她别过脸，指尖轻轻扣着桌沿。\n" +
        "  > 见他不说话，她又补一句：\"…汤要凉了。\""
      ) + '</pre>' +
      '<p>AI 深度辅助写作时会<b>全量注入</b>角色卡：外貌/性格/称呼/关系/当前状态必须与卡一致。</p>' +
      '<h3>六、设定词条格式（setting）</h3>' +
      '<pre class="help-code">' + esc(
        "# 设定\n" +
        "## 青云宗\n" +
        "- **类别**：门派\n" +
        "- **设定**：北境第一大修仙宗门，掌九峰，以剑修闻名\n" +
        "- **相关**：林晚、李恪\n" +
        "- **规则/禁忌**：外门弟子禁入后山禁地"
      ) + '</pre>' +
      '<p>设定词条同样全量注入，专有名词/世界观按此定义沿用，不得更改。</p>' +
      '<h3>七、三种维护方式</h3>' +
      '<ol class="help-list">' +
        '<li><b>界面里改</b>（推荐日常）：本弹窗直接增删改查，即时生效，存浏览器本地。</li>' +
        '<li><b>自己写 md</b>：按上面的格式写文件 → 「导入 md」或拖进窗口，自动识别。</li>' +
        '<li><b>写进目录重打包</b>：把 md 放进 banks\\ 对应目录 → node pack.js 自动重建 + 出包，适合分享给别人。</li>' +
      '</ol>' +
      '<h3>八、快捷键</h3>' +
      '<ul class="help-list">' +
        '<li><b>@</b> — 弹出词库全局搜索（Esc/点外部关闭）</li>' +
        '<li><b>Ctrl+Enter</b> — 补全（常用词句 + 情绪候选 + 上下文）</li>' +
        '<li><b>Ctrl+Shift+Enter</b> — 换一种说法（选中文字）</li>' +
        '<li><b>Esc</b> — 关闭候选/弹窗</li>' +
        '<li><b>Ctrl+↑ / Ctrl+↓</b> — 对比区差异跳转</li>' +
      '</ul>' +
      '<p>导出：当前类型点「导出 md」下载规范格式文件，能再导回来（完全往返）。</p>';
  }

  /* ================= 小工具 ================= */

  const readText = U.readText;
  const download = U.download;
  const esc = U.esc;
  const toast = U.toast;
  const uid = (p) => U.uid(p || "U");
  function saveFavsArr(arr) {
    Store.saveFavs(arr).then(() => {
      Suggest.setFavs(arr);
      if (window.Editor && Editor.saveFavsArray) Editor.saveFavsArray(arr);
      BankLoader.rebuild();
      if (el("bank-modal").classList.contains("show")) render();
      toast("常用词句已保存");
    });
  }

  /* ================= 表单字段定义 ================= */

  const catOpts = (cats) => ({ type: "select", options: cats, label2: (o) => Banks.catLabel(o) });
  const FORM_FIELDS = {
    lexicon: [
      { key: "word", label: "词 / 词组", type: "text" },
      Object.assign({ key: "category", label: "分类" }, catOpts(Banks.categories().concat(["custom"]))),
      { key: "tags", label: "情绪 / 标签", type: "text", hint: "用 / 分隔" },
      { key: "genreTags", label: "题材标签", type: "text", hint: "通用 / 古风 / 都市" },
      { key: "gloss", label: "释义", type: "textarea", rows: 2 },
      { key: "example", label: "例句", type: "textarea", rows: 2 },
      { key: "hint", label: "提示", type: "textarea", rows: 2 },
      { key: "antiAI", label: "⚠ 反AI", type: "textarea", rows: 2 }
    ],
    golden: [
      { key: "original", label: "原句", type: "textarea", rows: 3 },
      Object.assign({ key: "category", label: "分类" }, catOpts(GOLDEN_CATS.concat(["custom"]))),
      { key: "book", label: "书名", type: "text" },
      { key: "source", label: "来源", type: "text", hint: "《书名》·第X章" },
      { key: "tags", label: "情绪 / 标签", type: "text" },
      { key: "genreTags", label: "题材标签", type: "text" },
      { key: "why", label: "好在哪里", type: "textarea", rows: 2 },
      { key: "how", label: "怎么用", type: "textarea", rows: 2 },
      { key: "antiAI", label: "⚠ 反AI", type: "textarea", rows: 2 }
    ],
    anti: [
      { key: "level", label: "等级", type: "select", options: ANTI_LEVELS, label2: (o) => ({ T1: "T1 出现即换", T2: "T2 同段聚集", T3: "T3 全文密度", ctx: "语境敏感阈值", emotionReplace: "情绪外化", pattern: "句式模板" })[o] || o },
      { key: "terms", label: "词（用、分隔）", type: "text" },
      { key: "threshold", label: "阈值", type: "text", hint: "语境敏感填 ≤4次/章" },
      { key: "emotion", label: "情绪词", type: "text", hint: "情绪外化填 紧张/愤怒…" },
      { key: "replacement", label: "替换策略", type: "textarea", rows: 2 },
      { key: "note", label: "备注", type: "text" }
    ]
  };

  /* ================= 事件绑定 ================= */

  function bind() {
    el("bank-mask").addEventListener("click", close);
    document.addEventListener("click", e => {
      if (e.target.closest("[data-bank-add]")) doAdd();
      else if (e.target.closest("[data-bank-import]")) doImport();
      else if (e.target.closest("[data-bank-export]")) doExport();
      else if (e.target.closest("[data-bank-batch]")) openBatch();
      else if (e.target.closest("[data-bank-reset]")) doReset();
      else if (e.target.closest("[data-bank-format]")) openHelp();
      else if (e.target.closest("[data-bank-prev]")) { page--; render(); }
      else if (e.target.closest("[data-bank-next]")) { page++; render(); }
      else if (e.target.closest("[data-bank-close]")) close();
      else if (e.target.closest("[data-bank-refresh]")) { BankLoader.rebuild().then(() => toast("已刷新")); }
      else if (e.target.closest("[data-bank-cat]")) openCatManage();
      else if (e.target.closest("[data-bk-edit]")) doEdit(+e.target.closest("[data-bk-edit]").getAttribute("data-bk-edit"));
      else if (e.target.closest("[data-bk-del]")) doDelete(+e.target.closest("[data-bk-del]").getAttribute("data-bk-del"));
      else if (e.target.closest("[data-bank-fav-save]")) bankFavSave();
      else if (e.target.closest("[data-bank-fav-import]")) bankFavImport();
      else if (e.target.closest("[data-bank-fav-export]")) bankFavExport();
      else if (e.target.closest("[data-bank-fav-del]")) bankFavDel(+e.target.closest("[data-bank-fav-del]").getAttribute("data-bank-fav-del"));
      else if (e.target.closest("[data-entry-cancel]")) el("entry-modal").classList.remove("show");
      else if (e.target.closest("[data-entry-save]")) saveEntry();
      else if (e.target.closest("[data-batch-cancel]")) el("batch-modal").classList.remove("show");
      else if (e.target.closest("[data-batch-save]")) saveBatch();
      else if (e.target.closest("[data-help-close]")) el("help-modal").classList.remove("show");
      else if (e.target.closest("[data-cat-cancel]")) el("cat-modal").classList.remove("show");
      else if (e.target.closest("[data-cat-save]")) saveCatManage();
    });
    document.querySelectorAll("#bank-tabs button").forEach(b => {
      b.addEventListener("click", () => { tab = b.getAttribute("data-btab"); page = 0; query = ""; catFilter = ""; el("bank-search").value = ""; render(); });
    });
    // 搜索防抖
    let bankSearchTimer = null;
    el("bank-search").addEventListener("input", e => {
      query = e.target.value; page = 0;
      clearTimeout(bankSearchTimer);
      bankSearchTimer = setTimeout(() => render(), 150);
    });
    el("bank-cat").addEventListener("change", e => { catFilter = e.target.value; page = 0; render(); });
    document.querySelectorAll("#entry-mode-tabs button").forEach(b => {
      b.addEventListener("click", () => switchMode(b.getAttribute("data-emode")));
    });
    el("entry-mask").addEventListener("click", () => el("entry-modal").classList.remove("show"));
    el("batch-mask").addEventListener("click", () => el("batch-modal").classList.remove("show"));
    el("help-mask").addEventListener("click", () => el("help-modal").classList.remove("show"));
    el("cat-mask").addEventListener("click", () => el("cat-modal").classList.remove("show"));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        ["bank-modal", "entry-modal", "batch-modal", "help-modal", "cat-modal"].forEach(id => el(id).classList.remove("show"));
      }
    });
  }

  bind();

  return { open, close, onDataChanged, openHelp };
})();

window.BankManager = BankManager;
