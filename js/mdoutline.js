"use strict";
/* mdoutline.js — 大纲 / 阅读工作区：md 块解析 + 行内渲染 + 大纲树 + 工作区控制器。
   离线、无依赖，所有文本先转义；链接只显示文字、图片不嵌入（防 XSS / 外链）。 */

const Md = (function () {
  // 统一走 util.js 的 esc（此前是局部重复实现）
  const esc = (typeof U !== "undefined") ? U.esc : ((s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  // 行内渲染：先转义再做 markdown 转换
  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, (m, c) => "<code>" + c + "</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, (m, p, it) => p + "<em>" + it + "</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, (m, txt) => txt);   // 链接只留文字
    return s;
  }
  return { inline, esc };
})();

const isFence = (l) => /^```/.test(l.trim()) || /^~~~/.test(l.trim());
const isHr = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l.trim());
const isList = (l) => /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);
const isQuote = (l) => /^>\s?/.test(l);
const isTable = (l) => /^\s*\|/.test(l);
const isHeading = (l) => /^(#{1,6})\s/.test(l.trim());

function parseBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") { i++; continue; }
    if (isFence(line)) {
      const arr = [line.replace(/^```|^~~~/, "")];
      i++;
      while (i < lines.length && !isFence(lines[i])) { arr.push(lines[i]); i++; }
      i++;   // 跳过闭合围栏
      blocks.push({ type: "code", text: arr.join("\n") });
      continue;
    }
    if (isTable(line)) {
      const rows = [];
      while (i < lines.length && isTable(lines[i])) { rows.push(lines[i].trim()); i++; }
      if (rows.length >= 2 && /^\s*\|?[\s:|-]+\|[\s|:-]*$/.test(rows[1])) blocks.push({ type: "table", rows: rows.slice(0, 2).concat(rows.slice(2)) });
      else blocks.push({ type: "para", text: rows.join("\n") });
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: "heading", level: h[1].length, text: h[2] }); i++; continue; }
    if (isHr(t)) { blocks.push({ type: "hr" }); i++; continue; }
    if (isQuote(line)) {
      const arr = [];
      while (i < lines.length && isQuote(lines[i])) { arr.push(lines[i].replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", lines: arr });
      continue;
    }
    if (isList(line)) {
      const arr = [];
      while (i < lines.length && isList(lines[i])) { arr.push(lines[i].trim()); i++; }
      blocks.push({ type: "list", items: arr });
      continue;
    }
    // 普通段：收集到空行 / 特殊行
    const arr = [];
    while (i < lines.length && lines[i].trim() !== "" && !isHeading(lines[i]) && !isTable(lines[i]) && !isList(lines[i]) && !isQuote(lines[i]) && !isHr(lines[i]) && !isFence(lines[i])) {
      arr.push(lines[i]); i++;
    }
    blocks.push({ type: "para", text: arr.join("\n") });
  }
  return blocks;
}

// 大纲树：标题层级建树，非标题块归入最近标题的 body
function parseOutline(text) {
  const root = { level: 0, title: "", children: [], body: [] };
  const stack = [root];
  let cur = root;
  for (const b of parseBlocks(text)) {
    if (b.type === "heading") {
      const node = { level: b.level, title: b.text, children: [], body: [] };
      while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      cur = node;
    } else {
      cur.body.push(b);
    }
  }
  return root;
}

function blockText(b) {
  if (b.type === "table") return b.rows.join(" ");
  if (b.type === "quote" || b.type === "list") return (b.lines || b.items || []).join(" ");
  return b.text || "";
}

function renderBlock(b) {
  switch (b.type) {
    case "heading": return '<h' + Math.min(6, b.level) + ' class="md-h">' + Md.inline(b.text) + '</h' + Math.min(6, b.level) + '>';
    case "para": return '<p class="md-p">' + Md.inline(b.text) + '</p>';
    case "quote": return '<blockquote class="md-bq">' + b.lines.map(l => Md.inline(l)).join("<br>") + '</blockquote>';
    case "list": {
      const tag = /^\s*\d+[.)]/.test((b.items && b.items[0]) || "") ? "ol" : "ul";
      return '<' + tag + ' class="md-list">' + b.items.map(it => "<li>" + Md.inline(it.replace(/^\s*[-*+]\s+|\s*\d+[.)]\s+/, "")) + "</li>").join("") + "</" + tag + ">";
    }
    case "code": return '<pre class="md-code"><code>' + Md.esc(b.text) + "</code></pre>";
    case "hr": return '<hr class="md-hr">';
    case "table": return renderTable(b.rows);
    default: return "";
  }
}
function renderTable(rows) {
  const parseRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
  const head = parseRow(rows[0]);
  const body = rows.slice(2);
  return '<table class="md-table"><thead><tr>' + head.map(h => "<th>" + Md.inline(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    body.map(r => "<tr>" + parseRow(r).map(c => "<td>" + Md.inline(c) + "</td>").join("") + "</tr>").join("") +
    "</tbody></table>";
}

function countSections(node) {
  let n = 0;
  for (const c of node.children) { n += 1 + countSections(c); }
  return n;
}
// 搜索过滤：命中自身或子树 → 保留，命中节点标记
function filterTree(node, q) {
  const ql = String(q || "").toLowerCase();
  if (!ql) return null;
  const self = node.title.toLowerCase().includes(ql) || node.body.some(b => blockText(b).toLowerCase().includes(ql));
  const children = node.children.map(c => filterTree(c, q)).filter(Boolean);
  if (self || children.length) return { node, self, children };
  return null;
}
// 搜索命中高亮：把已转义/行内渲染后的 HTML 里命中的词包 <mark>（UX-08，与全文视图一致）
function markHit(html, q) {
  if (!q) return html;
  const ql = String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(ql, "gi"), m => "<mark>" + m + "</mark>");
}
// F-06：大纲写作进度（OutlineManager 每次 render 前写入当前文档的 {标题: 状态}）
let olProgress = {};
function statusBtn(title) {
  const st = olProgress[title] || "todo";
  return '<button type="button" class="ol-status st-' + st + '" data-ol-status="' + Md.esc(title) +
    '" title="点击切换：待写 → 写中 → 已写">' + (st === "done" ? "已写" : st === "writing" ? "写中" : "待写") + '</button>';
}
function renderTree(node, q) {
  const isRoot = node.level === 0;
  let html = "";
  if (!isRoot) {
    const open = node.level <= 2;
    const sec = countSections(node);   // 每节点只算一次（此前调用两次）
    html += '<details class="ol-node" data-ol-level="' + node.level + '"' + (open ? " open" : "") + ">" +
      "<summary><span class='ol-title'>" + markHit(Md.inline(node.title), q) + "</span>" +
      statusBtn(node.title) +
      (sec ? '<em class="ol-count">' + sec + "</em>" : "") +
      '<button class="ol-send" data-ol-send="' + Md.esc(node.title) + '" title="该节正文送入定稿区">送</button></summary>';
  }
  if (node.body.length) html += '<div class="ol-body">' + markHit(node.body.map(renderBlock).join(""), q) + "</div>";
  for (const c of node.children) html += renderTree(c, q);
  if (!isRoot) html += "</details>";
  return html;
}
// 搜索模式：仅渲染命中的子树（祖先展开），命中词高亮
function renderFiltered(node, f, q) {
  if (!f) return "";
  const isRoot = node.level === 0;
  let html = "";
  if (!isRoot) {
    const sec = countSections(node);
    html += '<details class="ol-node ol-hit" data-ol-level="' + node.level + '" open><summary><span class="ol-title">' +
      markHit(Md.inline(node.title), q) + "</span>" +
      statusBtn(node.title) +
      (sec ? '<em class="ol-count">' + sec + "</em>" : "") +
      '<button class="ol-send" data-ol-send="' + Md.esc(node.title) + '" title="该节正文送入定稿区">送</button></summary>';
  }
  if (node.body.length) html += '<div class="ol-body">' + markHit(node.body.map(renderBlock).join(""), q) + "</div>";
  for (const c of node.children) {
    const cf = f.children.find(x => x.node === c);
    html += cf ? renderFiltered(c, cf, q) : "";
  }
  if (!isRoot) html += "</details>";
  return html;
}

/* ================= 工作区控制器 ================= */

const OutlineManager = (function () {
  const el = (id) => document.getElementById(id);
  let docs = [];
  let curId = null;
  let view = "tree";   // tree | full
  let progress = {};   // docId → { 章节标题: done|writing|todo }（F-06）

  async function load() {
    try { docs = await Store.all("docs"); } catch (e) { console.warn("[大纲] 读取文档失败：", e); docs = []; }
    docs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (!curId || !docs.some(d => d.id === curId)) curId = docs.length ? docs[0].id : null;
    if (curId) {
      try { progress[curId] = (await Store.getMeta("outline-progress-" + curId)) || {}; } catch (e) { progress[curId] = {}; }
    }
  }
  function loadProgress(id) {
    if (!id) return;
    Store.getMeta("outline-progress-" + id).then(m => { progress[id] = m || {}; render(); }).catch(() => { progress[id] = {}; });
  }
  function saveProgress() {
    if (!curId) return;
    Store.setMeta("outline-progress-" + curId, progress[curId] || {}).catch(() => { });
  }
  function cur() { return docs.find(d => d.id === curId) || null; }

  function render() {
    const wrap = el("outline-wrap");
    if (!wrap) return;
    const sel = el("outline-file");
    if (sel) {
      sel.innerHTML = '<option value="">— 选择文档 —</option>' +
        docs.map(d => '<option value="' + Md.esc(d.id) + '"' + (d.id === curId ? " selected" : "") + '>' + Md.esc(d.name || "未命名") + '</option>').join("");
    }
    const body = el("outline-body");
    if (!body) return;
    const d = cur();
    const count = el("outline-count");
    if (count) count.textContent = docs.length + " 个文档" + (d ? " · " + String(d.text || "").replace(/\s/g, "").length + " 字" : "");
    if (!d) {
      body.innerHTML = '<div class="p-empty">还没有文档。点「导入」选 md/txt（可多选），或「＋ 新建」。</div>';
      return;
    }
    const q = (el("outline-search") && el("outline-search").value || "").trim();
    const blocks = parseBlocks(d.text);
    olProgress = progress[curId] || {};   // F-06：供 renderTree/renderFiltered 读进度
    if (view === "tree") {
      const tree = parseOutline(d.text);
      if (q) {
        const f = filterTree(tree, q);
        body.innerHTML = f ? renderFiltered(tree, f, q) : '<div class="p-empty">没有命中「' + Md.esc(q) + '」</div>';
      } else {
        body.innerHTML = renderTree(tree, q);
        if (!body.innerHTML.trim()) body.innerHTML = renderFull(blocks, q);
      }
    } else {
      body.innerHTML = renderFull(blocks, q);
    }
    const bt = document.querySelector("[data-outline-tree]"), bf = document.querySelector("[data-outline-full]");
    if (bt) bt.classList.toggle("active", view === "tree");
    if (bf) bf.classList.toggle("active", view === "full");
  }
  function renderFull(blocks, q) {
    let html = blocks.map(renderBlock).join("");
    if (q) {
      const ql = q.toLowerCase();
      const re = new RegExp(ql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      html = html.replace(re, m => "<mark>" + m + "</mark>");
    }
    return html;
  }

  async function importFiles(list) {
    let n = 0;
    for (const f of Array.from(list || [])) {
      try {
        const text = await readText(f);
        const name = (f.name || "未命名").replace(/\.(md|txt)$/i, "");
        await Store.putAll("docs", [{ id: uid(), name, text, ts: Date.now() }]);
        n++;
      } catch (e) { }
    }
    if (n) { await load(); if (!curId && docs.length) curId = docs[0].id; render(); }
    toast(n ? "已导入 " + n + " 个文档" : "导入失败");
  }
  const readText = U.readText;
  const uid = (p) => U.uid(p || "D");

  function openEdit(doc) {
    el("doc-edit-id").value = doc ? doc.id : "";
    el("doc-edit-name").value = doc ? doc.name : "";
    el("doc-edit-text").value = doc ? doc.text : "";
    el("doc-edit-title-label").textContent = doc ? "编辑文档 · " + doc.name : "新建文档";
    el("doc-edit-modal").classList.add("show");
  }
  async function saveEdit() {
    const id = el("doc-edit-id").value;
    const name = (el("doc-edit-name").value || "").trim() || "未命名";
    const text = el("doc-edit-text").value;
    if (!text.trim()) { toast("正文不能为空"); return; }
    await Store.putAll("docs", [{ id: id || uid(), name, text, ts: Date.now() }]);
    await load();
    if (!id) curId = docs.find(d => d.name === name && d.text === text) ? docs[docs.length - 1].id : curId;
    if (!curId && docs.length) curId = docs[0].id;
    el("doc-edit-modal").classList.remove("show");
    render();
    toast(id ? "已更新" : "已新建");
  }
  async function delCur() {
    const d = cur();
    if (!d || !confirm("删除「" + d.name + "」？")) return;
    await Store.remove("docs", [d.id]);
    await load();
    render();
    toast("已删除");
  }
  function exportCur() {
    const d = cur();
    if (!d) return;
    const blob = new Blob([d.text || ""], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (d.name || "文档") + ".md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast("已导出");
  }
  function copyCur() {
    const d = cur();
    if (!d) return;
    copyText(d.text || "");
    toast("已复制全文（md 源码）");
  }
  const copyText = U.copyText;
  const toast = U.toast;
  function setView(v) { view = v; render(); }
  function collapseAll(open) {
    document.querySelectorAll("#outline-body details.ol-node").forEach(d => {
      if (open) d.setAttribute("open", ""); else d.removeAttribute("open");
    });
  }
  // 大纲节正文（含子节） → 送定稿区
  function sectionText(node) {
    const out = [];
    if (node.level > 0) out.push(Array(Math.max(1, node.level) + 1).join("#") + " " + node.title);
    for (const b of node.body) {
      const t = blockText(b);
      if (t) out.push(t);
    }
    for (const c of node.children) out.push(sectionText(c));
    return out.join("\n\n");
  }
  function sendSectionToEditor(title) {
    const d = cur();
    if (!d) return;
    const tree = parseOutline(d.text);
    const q = title;
    // 找到标题匹配的节点
    let hit = null;
    (function find(node) {
      if (hit) return;
      if (node.level > 0 && node.title === q) { hit = node; return; }
      for (const c of node.children) find(c);
    })(tree);
    const text = hit ? sectionText(hit) : (d.text || "");
    if (window.Editor && Editor.sendText) Editor.sendText(text);
    toast("已送入定稿区" + (hit ? "（" + hit.title + "）" : "（全文）"));
    // F-06：送定稿自动标「已写」
    if (hit) {
      const m = progress[curId] || (progress[curId] = {});
      m[hit.title] = "done";
      saveProgress();
    }
  }
  async function addCurToLibrary() {
    const d = cur();
    if (!d) return;
    await Store.putAll("library", [{ id: uid(), title: d.name, text: d.text || "", active: true, ts: Date.now() }]);
    if (window.LibManager) LibManager.load().catch(() => { });
    toast("「" + d.name + "」已加入前文库");
  }

  function bind() {
    const sel = el("outline-file");
    if (sel) sel.addEventListener("change", e => { curId = e.target.value || null; loadProgress(curId); render(); });
    const search = el("outline-search");
    if (search) {
      let t = null;
      search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(render, 150); });
    }
    document.addEventListener("click", e => {
      if (e.target.closest("[data-outline-import]")) el("outline-file-input").click();
      else if (e.target.closest("[data-outline-new]")) openEdit(null);
      else if (e.target.closest("[data-outline-edit]")) openEdit(cur());
      else if (e.target.closest("[data-outline-del]")) delCur();
      else if (e.target.closest("[data-outline-export]")) exportCur();
      else if (e.target.closest("[data-outline-copy]")) copyCur();
      else if (e.target.closest("[data-outline-tree]")) setView("tree");
      else if (e.target.closest("[data-outline-full]")) setView("full");
      else if (e.target.closest("[data-outline-expand]")) collapseAll(true);
      else if (e.target.closest("[data-outline-collapse]")) collapseAll(false);
      else if (e.target.closest("[data-outline-lib]")) addCurToLibrary();
      else if (e.target.closest("[data-ol-status]")) {
        e.preventDefault(); e.stopPropagation();   // F-06：点状态徽标循环切换（不触发 details 折叠）
        const t = e.target.closest("[data-ol-status]").getAttribute("data-ol-status");
        const m = progress[curId] || (progress[curId] = {});
        m[t] = m[t] === "done" ? "todo" : m[t] === "writing" ? "done" : "writing";
        saveProgress();
        render();
      }
      else if (e.target.closest("[data-ol-send]")) {
        e.preventDefault(); e.stopPropagation();
        sendSectionToEditor(e.target.closest("[data-ol-send]").getAttribute("data-ol-send"));
      }
      else if (e.target.closest("[data-outline-send-all]")) sendSectionToEditor("");
      else if (e.target.closest("[data-doc-edit-save]")) saveEdit();
      else if (e.target.closest("[data-doc-edit-cancel]") || e.target.closest("[data-doc-edit-mask]")) el("doc-edit-modal").classList.remove("show");
    });
    const fi = el("outline-file-input");
    if (fi) fi.addEventListener("change", e => { if (e.target.files && e.target.files.length) importFiles(e.target.files); e.target.value = ""; });
    const dm = el("doc-edit-modal");
    if (dm) dm.addEventListener("dragover", e => { e.preventDefault(); });
    if (dm) dm.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });
  }

  if (typeof document !== "undefined" && typeof Store !== "undefined") {
    bind();
    load().then(render).catch(() => { });
  }

  return { render, load, refresh: () => load().then(render) };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { Md, parseBlocks, parseOutline };
if (typeof globalThis !== "undefined") globalThis.OutlineManager = OutlineManager;
