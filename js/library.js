"use strict";
/* library.js — 前文库（前文章节参考库）。独立面板：导入 / 新建 / 编辑 / 删除 / 搜索 / 清空。
   agent 通过 window.LibData 读取章节做跨章节检索，保持回调/伏笔/已建立事实连续一致。 */

const LibManager = (function () {
  const el = id => document.getElementById(id);
  let chapters = [];
  let query = "";

  async function load() {
    try {
      chapters = await Store.all("library");
    } catch (e) {
      console.warn("[前文库] 读取失败，已按空处理：", e);
      chapters = [];
    }
    chapters.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const index = rebuildIndex();
    if (typeof window !== "undefined" && window.AppState) AppState.setLibrary(chapters, index);
  }

  /* 段落级倒排索引（bigram）：AI 前文检索只扫候选段，不再全量扫描。
     segs 在 load 时预切分一次并缓存，章节增删改后随 load 重建。 */
  function rebuildIndex() {
    const segs = [];
    for (const ch of chapters) {
      const paras = String(ch.text || "").split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length >= 10);
      paras.forEach((p, i) => segs.push({ id: ch.id, title: ch.title || "未命名", active: ch.active !== false, i, text: p }));
    }
    const bigram = new Map();
    segs.forEach((sg, idx) => {
      const clean = sg.text.replace(/\s+/g, "");
      if (clean.length < 2) return;
      for (let i = 0; i < clean.length - 1; i++) {
        const bg = clean.slice(i, i + 2);
        let set = bigram.get(bg);
        if (!set) { set = new Set(); bigram.set(bg, set); }
        set.add(idx);
      }
    });
    return { segs, bigram };
  }

  function open() {
    render();
    el("lib-modal").classList.add("show");
  }
  function close() { el("lib-modal").classList.remove("show"); }

  function render() {
    const q = query.trim();
    const ql = q.toLowerCase();
    const totalChars = chapters.reduce((s, c) => s + String(c.text || "").length, 0);
    el("lib-count").textContent = chapters.length + " 章 · " + totalChars + " 字" + (q ? " · 命中搜索" : "");
    let html = "";
    for (const c of chapters) {
      const inTitle = q && (c.title || "").toLowerCase().includes(ql);
      if (q && !inTitle && !(c.text || "").toLowerCase().includes(ql)) continue;
      let hits = [];
      if (q) {
        const paras = String(c.text || "").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
        paras.forEach((p, i) => { if (p.toLowerCase().includes(ql)) hits.push({ i, text: p }); });
        hits = hits.slice(0, 3);
      }
      html += chapterHtml(c, hits, q, inTitle);
    }
    el("lib-list").innerHTML = html ||
      (q ? '<div class="p-empty">没有命中「' + esc(q) + '」的章节或段落。</div>' : '<div class="p-empty">还没有前文章节。点「导入」选 md/txt（可多选），或「＋ 新建」手动粘贴。</div>');
  }

  function chapterHtml(c, hits, q, inTitle) {
    let hitHtml = "";
    if (hits.length) {
      hitHtml = '<div class="lib-hits">' + hits.map(h =>
        '<div class="lib-hit"><span class="lib-hit-text">' + snippet(h.text, q) + '</span>' +
        '<button class="m-ins" data-lib-locate="' + esc(c.id) + '" data-lib-para="' + h.i + '" title="定位到该段">定位</button></div>'
      ).join("") + '</div>';
    }
    const hitCount = inTitle && !hits.length ? "标题命中" : (hits.length ? "命中 " + hits.length + " 段" : "");
    return '<div class="lib-chapter">' +
      '<div class="lib-item">' +
        '<span class="lib-title">' + esc(c.title || "未命名") + '</span>' +
        '<span class="lib-meta dim">' + String(c.text || "").length + ' 字 · ' + new Date(c.ts || 0).toLocaleString() +
          (hitCount ? ' · <b class="lib-hitcount">' + hitCount + '</b>' : "") + '</span>' +
        '<span class="lib-acts">' +
          '<button class="m-ins" data-lib-toggle="' + esc(c.id) + '" title="是否参与 AI 前文检索">' + (c.active === false ? "已停用" : "参与检索") + '</button>' +
          '<button class="m-ins" data-lib-edit="' + esc(c.id) + '">编辑</button>' +
          '<button class="m-del" data-lib-del="' + esc(c.id) + '">删除</button>' +
        '</span>' +
      '</div>' + hitHtml + '</div>';
  }

  // 命中片段：命中词前后各留上下文 + <mark> 高亮
  function snippet(text, q) {
    const t = String(text || "");
    const ql = q.toLowerCase();
    const i = t.toLowerCase().indexOf(ql);
    if (i < 0) return esc(t.slice(0, 90));
    const start = Math.max(0, i - 30);
    const end = Math.min(t.length, i + q.length + 70);
    let sn = t.slice(start, end);
    if (start > 0) sn = "…" + sn;
    if (end < t.length) sn += "…";
    const out = [];
    let prev = 0, pos = 0;
    while (true) {
      const rel = sn.toLowerCase().indexOf(ql, pos);
      if (rel === -1) break;
      out.push(esc(sn.slice(prev, rel)));
      out.push("<mark>" + esc(sn.slice(rel, rel + q.length)) + "</mark>");
      pos = rel + q.length; prev = pos;
    }
    out.push(esc(sn.slice(prev)));
    return out.join("");
  }

  // 按段下标计算其在原文中的起止偏移（供定位选中）
  function paraRange(text, paraIdx) {
    const t = String(text || "");
    const paras = t.split(/\n\s*\n/);
    let off = 0;
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      if (i === paraIdx) {
        let s = off;
        while (s < t.length && /\s/.test(t[s])) s++;
        return { start: s, end: Math.min(t.length, s + p.trim().length) };
      }
      off += p.length;
      let k = off;
      while (k < t.length && /\s/.test(t[k])) k++;
      off = k;
    }
    return null;
  }

  function locateParagraph(id, paraIdx) {
    const ch = chapters.find(c => c.id === id);
    if (!ch) return;
    openEdit(id);
    const ta = el("lib-edit-text");
    if (!ta) return;
    const rg = paraRange(ta.value, +paraIdx);
    if (!rg) return;
    ta.focus();
    ta.setSelectionRange(rg.start, rg.end);
    const lh = 1.8 * 13.5;   // 与 CSS line-height × font-size 一致
    const visible = Math.max(1, Math.floor(ta.clientHeight / lh));
    const linesBefore = ta.value.slice(0, rg.start).split("\n").length;
    ta.scrollTop = Math.max(0, (linesBefore - Math.floor(visible / 2)) * lh);
    toast("已定位到命中段落");
  }

  function openEdit(id) {
    const ch = chapters.find(c => c.id === id) || { id: "", title: "", text: "" };
    el("lib-edit-id").value = ch.id || "";
    el("lib-edit-title").value = ch.title || "";
    el("lib-edit-text").value = ch.text || "";
    el("lib-edit-title-label").textContent = ch.id ? "编辑前文 · " + (ch.title || "") : "新建前文";
    el("lib-edit-modal").classList.add("show");
  }

  async function saveEdit() {
    const id = el("lib-edit-id").value;
    const title = (el("lib-edit-title").value || "").trim() || "未命名";
    const text = el("lib-edit-text").value;
    if (!text.trim()) { toast("正文不能为空"); return; }
    try {
      const rec = { id: id || uid("L"), title, text, active: true, ts: Date.now() };
      await Store.putAll("library", [rec]);
      await load();
      el("lib-edit-modal").classList.remove("show");
      render();
      toast(id ? "已更新" : "已加入前文库");
    } catch (e) {
      console.error("[前文库] 保存失败：", e);
      toast("保存失败：" + (e && e.message || e));
    }
  }

  async function del(id) {
    if (!confirm("删除这篇前文？")) return;
    try {
      await Store.remove("library", id);
      await load();
      render();
      toast("已删除");
    } catch (e) {
      console.error("[前文库] 删除失败：", e);
      toast("删除失败：" + (e && e.message || e));
    }
  }

  async function clearAll() {
    if (!confirm("清空整个前文库？")) return;
    try {
      await Store.clear("library");
      await load();
      render();
      toast("前文库已清空");
    } catch (e) {
      console.error("[前文库] 清空失败：", e);
      toast("清空失败：" + (e && e.message || e));
    }
  }

  // 章节级「参与检索」开关（AI 面板「忽略此章」也走这里）
  async function toggleActive(id) {
    const ch = chapters.find(c => c.id === id);
    if (!ch) return;
    ch.active = (ch.active !== false) ? false : true;
    try {
      await Store.putAll("library", [ch]);
      await load();
      render();
      toast(ch.active !== false ? "「" + (ch.title || "该章") + "」已恢复参与检索" : "「" + (ch.title || "该章") + "」已停用检索");
    } catch (e) {
      console.error("[前文库] 开关失败：", e);
      toast("开关失败：" + (e && e.message || e));
    }
  }

  async function importFiles(fileList) {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;
    let n = 0, fail = 0, errMsg = "";
    for (const f of arr) {
      try {
        const text = await readText(f);
        const rec = { id: uid("L"), title: (f.name || "未命名").replace(/\.(md|txt)$/i, ""), text, active: true, ts: Date.now() };
        await Store.putAll("library", [rec]);
        n++;
      } catch (e) { fail++; errMsg = (e && e.message) || String(e); }
    }
    try { await load(); } catch (e) { }
    render();
    toast(fail
      ? "已导入 " + n + " 章，失败 " + fail + " 章" + (errMsg ? "：" + errMsg : "")
      : "已导入 " + n + " 章到前文库");
  }

  const readText = U.readText;
  const esc = U.esc;
  const toast = U.toast;
  const uid = (p) => U.uid(p || "L");

  function bind() {
    document.addEventListener("click", e => {
      if (e.target.closest("[data-lib-open]")) open();
      else if (e.target.closest("[data-lib-import]")) el("lib-file").click();
      else if (e.target.closest("[data-lib-new]")) openEdit("");
      else if (e.target.closest("[data-lib-clear]")) clearAll();
      else if (e.target.closest("[data-lib-close]") || e.target.closest("[data-lib-mask]")) close();
      else if (e.target.closest("[data-lib-edit]")) openEdit(e.target.closest("[data-lib-edit]").getAttribute("data-lib-edit"));
      else if (e.target.closest("[data-lib-del]")) del(e.target.closest("[data-lib-del]").getAttribute("data-lib-del"));
      else if (e.target.closest("[data-lib-toggle]")) toggleActive(e.target.closest("[data-lib-toggle]").getAttribute("data-lib-toggle"));
      else if (e.target.closest("[data-lib-locate]")) locateParagraph(e.target.closest("[data-lib-locate]").getAttribute("data-lib-locate"), e.target.closest("[data-lib-locate]").getAttribute("data-lib-para"));
      else if (e.target.closest("[data-lib-edit-save]")) saveEdit();
      else if (e.target.closest("[data-lib-edit-cancel]")) el("lib-edit-modal").classList.remove("show");
    });
    const libFile = el("lib-file");
    if (libFile) libFile.addEventListener("change", e => {
      if (e.target.files && e.target.files.length) importFiles(e.target.files);
      e.target.value = "";
    });
    const libModal = el("lib-modal");
    if (libModal) {
      libModal.addEventListener("dragover", e => { e.preventDefault(); });
      libModal.addEventListener("drop", e => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
      });
    }
    const libSearch = el("lib-search");
    if (libSearch) libSearch.addEventListener("input", e => { query = e.target.value; render(); });
    const editMask = el("lib-edit-mask");
    if (editMask) editMask.addEventListener("click", () => el("lib-edit-modal").classList.remove("show"));
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { el("lib-modal").classList.remove("show"); el("lib-edit-modal").classList.remove("show"); }
    });
  }

  bind();

  return { open, close, load, toggleActive };
})();

window.LibManager = LibManager;
