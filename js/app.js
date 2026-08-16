"use strict";
const MAX = 4;

let versions = [];
let baselineIdx = -1;
let mode = "split";        // split(并排) | unified(合并)
let granularity = "char";  // char | line
let syncOn = true;
let ignoreFM = true;
let highlightOn = true;    // true=对比模式(红绿高亮) | false=纯阅读模式(纯原文)
let colCount = 4;          // 栏数（1–4，含基准），空槽位随栏数显示
let slotVersions = [];     // 槽1..colCount-1 → 版本下标 或 null(空槽)
let singleView = -1;       // 单栏模式下当前显示的版本下标

let docInfos = {};   // { vi: { v, vi, doc, stats } }
let anchors = [];    // 差异锚点行号（基准行号，升序去重，仅显示栏）
let curAnchor = -1;
let scrollBodies = [];
let syncing = false;
let pasteCounter = 0;

const $ = id => document.getElementById(id);

/* ---------- 扩展模式 / 持久化 ---------- */

const LS_STATE = "text-compare-state";
let stateHadColCount = false;

function isExt() {
  return typeof chrome !== "undefined" && chrome.runtime && !!chrome.runtime.id;
}
function getMode() {
  const m = new URLSearchParams(location.search).get("mode");
  return m === "popup" ? "popup" : "side";
}
const MODE_LABEL = { side: "侧边栏", popup: "小窗" };

function saveState() {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify({
      versions: versions.map(v => ({ name: v.name, raw: v.raw })),
      baselineIdx: baselineIdx,
      colCount: colCount,
      singleView: singleView
    }));
  } catch (e) { console.warn("[对比] 状态保存失败：", e); }
}
function loadState() {
  try {
    const s = localStorage.getItem(LS_STATE);
    if (!s) return;
    const d = JSON.parse(s);
    if (d.versions && d.versions.length) {
      versions = d.versions.map(v => makeVersion(v.name, v.raw));
      baselineIdx = (d.baselineIdx >= 0 && d.baselineIdx < versions.length) ? d.baselineIdx : 0;
    }
    if (typeof d.colCount === "number" && d.colCount >= 1 && d.colCount <= 4) {
      colCount = d.colCount;
      stateHadColCount = true;
    }
    if (typeof d.singleView === "number") singleView = d.singleView;
  } catch (e) { console.warn("[对比] 状态恢复失败：", e); }
}

function switchMode(mode) {
  if (!isExt()) return;
  const base = chrome.runtime.getURL("index.html");
  if (mode === "popup") {
    chrome.windows.create({ url: base + "?mode=popup", type: "popup", width: 1020, height: 760 }).catch(() => { });
  } else if (mode === "side") {
    chrome.sidePanel.setOptions({ path: "index.html" })
      .then(() => chrome.windows.getCurrent())
      .then(win => chrome.sidePanel.open({ windowId: win.id }))
      .catch(() => {
        try { chrome.sidePanel.open().then(() => { }, () => toast("侧边栏打开失败，请检查浏览器是否支持")); }
        catch (e) { toast("侧边栏打开失败"); }
      });
  }
}

function initModeMenu() {
  const wrap = $("mode-wrap");
  if (!wrap) return;
  if (!isExt()) { wrap.style.display = "none"; return; }
  const mode = getMode();
  $("mode-cur").textContent = MODE_LABEL[mode] || "模式";
  document.querySelectorAll("#mode-pop .mode-item").forEach(it => {
    it.classList.toggle("sel", it.getAttribute("data-mode") === mode);
  });
  $("btn-mode").addEventListener("click", e => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains("open");
    closeAllPickers();
    wrap.classList.toggle("open", !wasOpen);
  });
  document.querySelectorAll("#mode-pop .mode-item").forEach(it => {
    it.addEventListener("click", e => {
      e.stopPropagation();
      const target = it.getAttribute("data-mode");
      wrap.classList.remove("open");
      if (target !== mode) switchMode(target);
    });
  });
}

function applyCompact() {
  const mode = getMode();
  const widthNarrow = window.innerWidth < 720;
  const narrow = widthNarrow || window.innerHeight < 500;
  // 小窗、侧边栏（扩展内，含拉宽的侧边栏）、以及任何窄窗口 → 紧凑填充
  const compact = mode === "popup" || (mode === "side" && isExt()) || narrow;
  if (compact) {
    document.body.classList.add("compact");
    const w = $("app-window");
    if (w) w.classList.add("maximized");
    // 只有"窄宽"（侧边栏）才默认降为双栏，避免矮宽窗口被误降
    if (widthNarrow && !stateHadColCount && colCount > 2) {
      colCount = 2;
      [1, 2, 3, 4].forEach(x => $("btn-col-" + x).classList.toggle("active", x === colCount));
    }
  }
}

/* ---------- 图标 ---------- */

function svgIcon(paths, size) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" width="' + (size || 13) + '" height="' + (size || 13) + '">' + paths + '</svg>';
}
const ICONS = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  set: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>'
};

/* ---------- 文本处理 ---------- */

function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
function processText(raw, ignore) {
  let s = stripBOM(raw);
  if (ignore && /^---\s*\r?\n/.test(s)) {
    const m = s.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
    if (m) s = s.slice(m[0].length);
  }
  return s;
}
function makeVersion(name, raw) {
  const text = processText(raw, ignoreFM);
  return { name, raw, text, paras: Diff.splitParas(text), count: Diff.charCount(text) };
}
function esc(s) {
  // 统一走 util.js 的 U.esc（补齐 " 转义；此前本地实现只转义 &<>）
  return U.esc(s);
}
function otherVIs() {
  return versions.map((v, vi) => vi).filter(vi => vi !== baselineIdx);
}

/* ---------- 自定义版本下拉 / 改名 ---------- */

function versionPicker(id, current, list) {
  const cur = list.find(o => o.vi === current) || list[0];
  const items = list.map(o =>
    '<div class="vpick-item' + (o.vi === current ? ' sel' : '') + '" data-pick="' + o.vi + '">' +
      '<span class="vpick-check">' + (o.vi === current ? svgIcon(ICONS.check, 12) : "") + '</span>' +
      '<span class="vpick-name">' + esc(o.name) + '</span>' +
      '<span class="vpick-ren" data-ren="' + o.vi + '" title="重命名">' + svgIcon(ICONS.edit, 12) + '</span>' +
    '</div>').join('');
  return '<div class="vpick" data-vpick="' + id + '">' +
    '<button class="vpick-btn" title="此栏显示的版本">' +
      '<span class="vpick-cur">' + esc(cur ? cur.name : "选择版本") + '</span>' +
      svgIcon(ICONS.chevron, 12) +
    '</button>' +
    '<div class="vpick-pop">' + items + '</div>' +
    '</div>';
}

function closeAllPickers() {
  document.querySelectorAll(".vpick.open").forEach(p => p.classList.remove("open"));
}

function startRename(vi, anchor) {
  if (!versions[vi] || !anchor) return;
  const input = document.createElement("input");
  input.className = "ren-input";
  input.value = versions[vi].name;
  input.maxLength = 60;
  anchor.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    versions[vi].name = input.value.trim() || versions[vi].name;
    saveState();
    render();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    render();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
}

/* ---------- 计算 ---------- */

function assignSlots() {
  const others = otherVIs();
  const slots = Math.max(colCount - 1, 0);
  const prev = slotVersions;
  const next = new Array(slots).fill(null);
  for (let s = 0; s < slots; s++) {
    const wanted = prev[s];
    if (wanted != null && versions[wanted] && wanted !== baselineIdx && !next.slice(0, s).includes(wanted)) {
      next[s] = wanted;
    }
  }
  let oi = 0;
  for (let s = 0; s < slots; s++) {
    if (next[s] != null) continue;
    while (oi < others.length && next.includes(others[oi])) oi++;
    if (oi < others.length) { next[s] = others[oi]; oi++; }
  }
  slotVersions = next;
}

function compute() {
  docInfos = {};
  anchors = [];
  curAnchor = -1;
  if (!highlightOn) return;
  if (baselineIdx < 0 || versions.length === 0) return;
  const base = versions[baselineIdx];
  if (!base) return;
  otherVIs().forEach(vi => {
    const doc = Diff.mergeDoc(base.text, versions[vi].text);
    docInfos[vi] = { v: versions[vi], vi, doc, stats: Diff.docStats(doc) };
  });
  const set = new Set();
  for (const vi of slotVersions) {
    if (vi == null) continue;
    const info = docInfos[vi];
    if (info) for (const e of info.doc) if (Diff.isDiffEntry(e)) set.add(e.pos);
  }
  anchors = Array.from(set).sort((a, b) => a - b);
  curAnchor = anchors.length ? 0 : -1;
}

/* ---------- 渲染 ---------- */

function validateSingleView() {
  if (versions.length === 0) { singleView = -1; return; }
  if (baselineIdx < 0 || baselineIdx >= versions.length) baselineIdx = 0;
  if (singleView < 0 || singleView >= versions.length || !versions[singleView]) singleView = baselineIdx;
}

function render() {
  const panes = $("panes");
  panes.innerHTML = "";
  assignSlots();
  validateSingleView();
  compute();
  if (versions.length >= 2 && mode === "unified") renderUnified();
  else if (colCount === 1 && versions.length >= 1) renderSingleView();
  else renderSlots();
  setToolbarState();
  updateStatsBar();
  updateDesc();
  updateNavDisabled();
}

function setToolbarState() {
  const colBtns = [1, 2, 3, 4].map(x => $("btn-col-" + x));
  const modeBtns = ["split", "unified"].map(x => $("btn-" + x));
  const granBtns = ["char", "line"].map(x => $("btn-" + x));
  const ready = versions.length >= 2;
  colBtns.forEach(b => b.disabled = ready && mode === "unified");
  modeBtns.forEach(b => b.disabled = !ready);
  granBtns.forEach(b => b.disabled = !ready);
  $("chk-hl").disabled = !ready;
  $("chk-sync").disabled = !ready || mode === "unified";
  // 栏位按钮高亮与 colCount 同步（避免 HTML 默认"四栏"与保存的栏数不一致）
  [1, 2, 3, 4].forEach(x => $("btn-col-" + x).classList.toggle("active", x === colCount));
}

function makeColDiv(v, vi, isBase, slotIdx) {
  const col = document.createElement("div");
  col.className = "col";
  const hdr = document.createElement("div");
  hdr.className = "col-hdr";
  let statsHtml = "";
  if (!isBase && docInfos[vi]) {
    const s = docInfos[vi].stats;
    statsHtml = '<span class="col-stats">同' + s.same + ' 删<span class="stat-del">' + s.del + '</span> 增<span class="stat-add">' + s.add + '</span></span>';
  }
  const badge = isBase ? '<span class="badge">基准</span>' : "";
  let btns =
    '<button class="copy-btn" data-copy="' + vi + '" title="复制全文（纯原文）">' + svgIcon(ICONS.copy, 12) + '复制全文</button>';
  if (!isBase) btns += '<button class="hbtn set" data-set="' + vi + '" title="以它为基准">' + svgIcon(ICONS.set, 11) + '设为基准</button>';
  btns += '<button class="hbtn clr" data-clear="' + vi + '" title="清空全文">' + svgIcon(ICONS.trash, 11) + '清空</button>';
  let sel = "";
  if (!isBase && slotIdx != null && otherVIs().length > slotVersions.length) {
    sel = versionPicker("slot:" + slotIdx, slotVersions[slotIdx], otherVIs().map(i => ({ vi: i, name: versions[i].name })));
  }
  hdr.innerHTML =
    '<div class="col-left"><span class="col-name">' + esc(v.name) + badge + '</span>' +
    '<button class="ren-btn" data-header-ren="' + vi + '" title="重命名">' + svgIcon(ICONS.edit, 11) + '</button>' +
    sel + '</div>' +
    '<div class="col-meta">' + v.count + ' 字' + statsHtml + '</div>' +
    '<div class="col-acts">' + btns + '</div>';
  const body = document.createElement("div");
  body.className = "col-body";
  col.appendChild(hdr);
  col.appendChild(body);
  return col;
}

function emptySlot(idx) {
  const col = document.createElement("div");
  col.className = "col";
  col.innerHTML =
    '<div class="col-hdr"><div class="col-left"><span class="col-name dim">空槽位 ' + (idx + 1) + '</span></div></div>' +
    '<div class="col-body slot-empty-body"><div class="slot-empty">' +
    '<div class="slot-plus">+</div>' +
    '<button class="sec-btn" data-slot-import="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>导入文件</button>' +
    '<button class="sec-btn" data-slot-paste="1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>粘贴文本</button>' +
    '<div class="slot-hint">拖入文件到此，或点击按钮</div>' +
    '</div></div>';
  return col;
}

function renderRawBody(body, paras, withNums) {
  paras.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "para";
    el.setAttribute("data-line", i + 1);
    if (withNums) {
      const num = document.createElement("span");
      num.className = "pnum";
      num.textContent = (i + 1) + ".";
      el.appendChild(num);
    }
    el.appendChild(document.createTextNode(p));
    body.appendChild(el);
  });
}

function renderSlots() {
  const panes = $("panes");
  panes.className = "slots";
  scrollBodies = [];
  const compare = versions.length >= 2;

  if (versions.length === 0) {
    for (let i = 0; i < colCount; i++) panes.appendChild(emptySlot(i));
  } else {
    const base = versions[baselineIdx];
    const baseCol = makeColDiv(base, baselineIdx, true, -1);
    const baseBody = baseCol.querySelector(".col-body");
    baseBody.id = "base-body";
    renderRawBody(baseBody, base.paras, highlightOn);
    panes.appendChild(baseCol);
    scrollBodies.push(baseBody);

    slotVersions.forEach((vi, si) => {
      if (vi == null) {
        panes.appendChild(emptySlot(si + 1));
      } else {
        const v = versions[vi];
        const col = makeColDiv(v, vi, false, si);
        const body = col.querySelector(".col-body");
        if (compare && highlightOn) renderMergeBody(body, vi);
        else renderRawBody(body, v.paras, false);
        panes.appendChild(col);
        scrollBodies.push(body);
      }
    });
  }
  bindPaneScroll();
}

function renderSingleView() {
  const panes = $("panes");
  panes.className = "slots";
  scrollBodies = [];
  let vi = singleView;
  if (vi < 0 || vi >= versions.length || !versions[vi]) { singleView = baselineIdx; vi = baselineIdx; }
  const v = versions[vi];
  if (!v) { renderSlots(); return; }
  const col = document.createElement("div");
  col.className = "col";
  const hdr = document.createElement("div");
  hdr.className = "col-hdr";
  const badge = vi === baselineIdx ? '<span class="badge">基准</span>' : "";
  let sel = "";
  if (versions.length >= 2) {
    sel = versionPicker("single", vi, versions.map((vv, i) => ({ vi: i, name: vv.name })));
  }
  let btns = '<button class="copy-btn" data-copy="' + vi + '" title="复制全文（纯原文）">' + svgIcon(ICONS.copy, 12) + '复制全文</button>';
  if (vi !== baselineIdx) btns += '<button class="hbtn set" data-set="' + vi + '" title="以它为基准">' + svgIcon(ICONS.set, 11) + '设为基准</button>';
  btns += '<button class="hbtn clr" data-clear="' + vi + '" title="清空全文">' + svgIcon(ICONS.trash, 11) + '清空</button>';
  hdr.innerHTML =
    '<div class="col-left"><span class="col-name">' + esc(v.name) + badge + '</span>' +
    '<button class="ren-btn" data-header-ren="' + vi + '" title="重命名">' + svgIcon(ICONS.edit, 11) + '</button>' +
    sel + '</div>' +
    '<div class="col-meta">' + v.count + ' 字</div>' +
    '<div class="col-acts">' + btns + '</div>';
  const body = document.createElement("div");
  body.className = "col-body";
  renderRawBody(body, v.paras, true);
  col.appendChild(hdr);
  col.appendChild(body);
  panes.appendChild(col);
  scrollBodies.push(body);
  bindPaneScroll();
}

function renderUnified() {
  const panes = $("panes");
  panes.className = "unified";
  scrollBodies = [];
  const scroller = document.createElement("div");
  scroller.className = "uni-scroll";
  otherVIs().forEach(vi => {
    const v = versions[vi];
    const block = document.createElement("div");
    block.className = "uni-block";
    const hdr = document.createElement("div");
    hdr.className = "uni-hdr";
    let statsHtml = "";
    if (highlightOn && docInfos[vi]) {
      const s = docInfos[vi].stats;
      statsHtml = '<span class="uni-stats">同' + s.same + ' 删<span class="stat-del">' + s.del + '</span> 增<span class="stat-add">' + s.add + '</span></span>';
    }
    let btns = '<button class="copy-btn" data-copy="' + vi + '" title="复制全文（纯原文）">' + svgIcon(ICONS.copy, 12) + '复制全文</button>';
    btns += '<button class="hbtn clr" data-clear="' + vi + '" title="清空全文">' + svgIcon(ICONS.trash, 11) + '清空</button>';
    hdr.innerHTML =
      '<span class="uni-name">' + esc(v.name) + '</span>' +
      '<button class="ren-btn" data-header-ren="' + vi + '" title="重命名">' + svgIcon(ICONS.edit, 11) + '</button>' +
      '<span class="uni-meta">' + v.count + ' 字</span>' +
      statsHtml +
      '<span style="margin-left:auto"></span>' + btns;
    const body = document.createElement("div");
    body.className = "uni-body";
    if (highlightOn) renderMergeBody(body, vi);
    else renderRawBody(body, v.paras, false);
    block.appendChild(hdr);
    block.appendChild(body);
    scroller.appendChild(block);
  });
  panes.appendChild(scroller);
  scrollBodies.push(scroller);
  bindPaneScroll();
}

function appendLine(body, pos, cls, lineA, lineB, text, ops, adopt) {
  const el = document.createElement("div");
  el.className = "mline " + cls;
  el.setAttribute("data-pos", pos);
  const g = document.createElement("span");
  g.className = "gutter";
  g.textContent = (lineA || "") + (lineB ? ":" + lineB : "");
  el.appendChild(g);
  const tx = document.createElement("span");
  tx.className = "txt";
  if (ops) {
    for (const [o, s] of ops) {
      if (o === 0) tx.appendChild(document.createTextNode(s));
      else {
        const m = document.createElement("span");
        m.className = o === -1 ? "diff-delete" : "diff-insert";
        m.textContent = s;
        tx.appendChild(m);
      }
    }
  } else {
    tx.textContent = text;
  }
  el.appendChild(tx);
  // F-01：差异行 hover「采纳此句 → 定稿区」（新版文本）
  if (adopt != null && adopt !== "") {
    const b = document.createElement("button");
    b.className = "adopt-btn";
    b.textContent = "采纳";
    b.title = "把新版此句采纳到定稿区光标处";
    b.dataset.adopt = adopt;
    el.appendChild(b);
  }
  body.appendChild(el);
}

function renderMergeBody(body, vi) {
  const info = docInfos[vi];
  if (!info) return;
  const doc = info.doc;
  const isLine = granularity === "line";
  for (const e of doc) {
    if (e.type === "equal") {
      appendLine(body, e.pos, "m-equal", e.lineA, e.lineB, e.text, null);
    } else if (e.type === "delete") {
      appendLine(body, e.pos, "m-del", e.lineA, e.lineB, e.text, null);
    } else if (e.type === "insert") {
      appendLine(body, e.pos, "m-ins", e.lineA, e.lineB, e.text, null, e.text);
    } else { // inline
      if (isLine) {
        appendLine(body, e.pos, "m-del", e.lineA, "", e.textA, null);
        appendLine(body, e.pos, "m-ins", "", e.lineB, e.textB, null, e.textB);
      } else {
        appendLine(body, e.pos, "m-inline", e.lineA, e.lineB, null, e.ops, e.textB);
      }
    }
  }
}

function bindPaneScroll() {
  document.querySelectorAll("#panes .col-body, #panes .uni-scroll").forEach(b => {
    b.removeEventListener("scroll", onPaneScroll);
    b.addEventListener("scroll", onPaneScroll);
  });
}

function ratioOf(b) {
  const max = b.scrollHeight - b.clientHeight;
  return max > 0 ? b.scrollTop / max : 0;
}
function onPaneScroll(e) {
  if (syncing || !syncOn) return;
  const src = e.target;
  const r = ratioOf(src);
  syncing = true;
  for (const b of scrollBodies) {
    if (b !== src) {
      const max = b.scrollHeight - b.clientHeight;
      b.scrollTop = max > 0 ? r * max : 0;
    }
  }
  requestAnimationFrame(() => { syncing = false; });
}

/* ---------- 差异跳转 / 定位 ---------- */

function findNear(body, attr, val) {
  const els = body.querySelectorAll("[" + attr + "]");
  let best = null, bd = Infinity;
  for (const el of els) {
    const v = +el.getAttribute(attr);
    const d = Math.abs(v - val);
    if (d < bd) { bd = d; best = el; }
  }
  return best;
}
function scrollToEl(body, el) {
  if (!body || !el) return;
  const bt = body.getBoundingClientRect().top;
  const et = el.getBoundingClientRect().top;
  body.scrollTop += et - bt - 12;
}
function goPos(pos) {
  let idx = anchors.findIndex(a => a >= pos);
  if (idx === -1) idx = anchors.length - 1;
  if (idx >= 0) curAnchor = idx;
  scrollToAll(pos);
}
function goAnchor(dir) {
  if (!anchors.length) { toast("没有差异可跳转"); return; }
  if (curAnchor < 0) curAnchor = 0;
  curAnchor = (curAnchor + dir + anchors.length) % anchors.length;
  scrollToAll(anchors[curAnchor]);
}
function scrollToAll(pos) {
  document.querySelectorAll("#panes .cur").forEach(el => el.classList.remove("cur"));
  if (scrollBodies.length > 0) {
    const el = findNear(scrollBodies[0], "data-line", pos);
    scrollToEl(scrollBodies[0], el);
  }
  scrollBodies.forEach(b => {
    const el = findNear(b, "data-pos", pos);
    if (el) scrollToEl(b, el);
  });
  document.querySelectorAll('#panes [data-pos="' + pos + '"]').forEach(el => el.classList.add("cur"));
  const bl = document.querySelector('#panes [data-line="' + pos + '"]');
  if (bl) bl.classList.add("cur");
}
function updateNavDisabled() {
  const dis = versions.length < 2 || !highlightOn || !anchors.length;
  $("btn-prev").disabled = dis;
  $("btn-next").disabled = dis;
}

/* ---------- 悬停联动 ---------- */

function highlightPos(pos, on) {
  const els = document.querySelectorAll('#panes [data-pos="' + pos + '"], #panes [data-line="' + pos + '"]');
  els.forEach(el => el.classList.toggle("hl", on));
}
function onPaneOver(e) {
  if (!highlightOn) return;
  const el = e.target.closest("[data-pos],[data-line]");
  if (!el) return;
  highlightPos(el.getAttribute("data-pos") || el.getAttribute("data-line"), true);
}
function onPaneOut(e) {
  if (!highlightOn) return;
  const el = e.target.closest("[data-pos],[data-line]");
  if (!el) return;
  highlightPos(el.getAttribute("data-pos") || el.getAttribute("data-line"), false);
}

/* ---------- 统计 / 描述 ---------- */

function updateStatsBar() {
  if (versions.length === 0) { $("stats").innerHTML = ""; return; }
  if (versions.length === 1) { $("stats").innerHTML = '<span class="dim">已载入 1 份，再导入 1 份即可对比</span>'; return; }
  if (!highlightOn) {
    $("stats").innerHTML = '<span class="dim">纯阅读模式</span>';
    return;
  }
  let same = 0, del = 0, add = 0;
  for (const vi of slotVersions) {
    if (vi == null) continue;
    const info = docInfos[vi];
    if (info) {
      same += info.stats.same; del += info.stats.del; add += info.stats.add;
    }
  }
  $("stats").innerHTML = "同步 <b>" + same + "</b> · 删 <b class=\"stat-del\">" + del + "</b> · 增 <b class=\"stat-add\">" + add + "</b> · <span class=\"dim\">" + anchors.length + " 处差异</span>";
}
function updateDesc() {
  const d = $("mode-desc");
  if (versions.length === 0) {
    d.textContent = "从空槽位或顶部「导入 / 粘贴」载入草稿，第一份为基准";
    return;
  }
  if (versions.length === 1) {
    d.textContent = "已载入 1 份，再导入 1 份即可开始对比（拖拽 / 导入 / 粘贴）";
    return;
  }
  const base = "基准：" + versions[baselineIdx].name;
  if (mode === "unified") {
    d.textContent =
      (granularity === "char" ? "字对比" : "行对比") + " · 合并 · " + base + " · 共 " + versions.length + " 份" +
      (anchors.length ? " · 共 " + anchors.length + " 处差异" : " · 完全一致");
    return;
  }
  const shown = slotVersions.filter(v => v != null).length + 1;
  const empty = colCount - shown;
  let txt = (granularity === "char" ? "字对比" : "行对比") + " · 并排 · " + base + " · 显示 " + shown + " 栏";
  if (empty > 0) txt += "（空槽 " + empty + "）";
  txt += " · 共 " + versions.length + " 份";
  txt += !highlightOn ? " · 纯阅读模式" : (anchors.length ? " · 共 " + anchors.length + " 处差异" : " · 完全一致");
  d.textContent = txt;
}

/* ---------- 导入 / 操作 ---------- */

async function addFiles(fileList) {
  const arr = Array.from(fileList);
  const bankFiles = [];
  const draftFiles = [];
  for (const f of arr) {
    const raw = await U.readText(f);
    const kind = Banks.detectBank(raw, f.name);
    if (kind) bankFiles.push({ kind, raw, file: f });
    else draftFiles.push({ file: f, raw });
  }
  if (bankFiles.length) {
    const n = await BankLoader.importFiles(bankFiles);
    if (!draftFiles.length) {
      toast("已识别词库 " + bankFiles.length + " 个文件，载入 " + n + " 条");
      return;
    }
  }
  if (draftFiles.length) {
    const slots = MAX - versions.length;
    if (slots <= 0) { toast("最多对比 " + MAX + " 份"); return; }
    const take = draftFiles.slice(0, slots);
    if (draftFiles.length > slots) toast("草稿一次最多载入 " + MAX + " 份，已取前 " + slots + " 份");
    for (const d of take) versions.push(makeVersion(d.file.name, d.raw));
    if (baselineIdx === -1) baselineIdx = 0;
    saveState();
    render();
    if (bankFiles.length) toast("词库 " + bankFiles.length + " 个 + 草稿 " + draftFiles.length + " 份已载入");
  }
}
function slotDone() {
  const ta = $("paste-text");
  if (!ta) return;
  const t = ta.value;
  if (!t.trim()) { toast("先粘贴文本"); return; }
  const slots = MAX - versions.length;
  if (slots <= 0) { toast("最多对比 " + MAX + " 份"); return; }
  versions.push(makeVersion("粘贴文本 " + (++pasteCounter), t));
  if (baselineIdx === -1) baselineIdx = 0;
  ta.value = "";
  closePasteModal();
  saveState();
  render();
}
function openPasteModal() {
  $("paste-modal").classList.add("show");
  setTimeout(() => $("paste-text").focus(), 50);
}
function closePasteModal() {
  $("paste-modal").classList.remove("show");
}
function copyText(t) {
  const done = () => toast("已复制到剪贴板");
  const fail = () => toast("复制失败");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done, fail));
  } else fallbackCopy(t, done, fail);
}
function fallbackCopy(t, done, fail) {
  const ta = document.createElement("textarea");
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { fail(); }
  ta.remove();
}

/* ---------- 事件绑定 ---------- */

function setGranularity(g) {
  granularity = g;
  ["char", "line"].forEach(x => $("btn-" + x).classList.toggle("active", x === g));
  render();
}
function setMode(m) {
  mode = m;
  ["split", "unified"].forEach(x => $("btn-" + x).classList.toggle("active", x === m));
  render();
}
function setColCount(n) {
  const prev = slotVersions.slice();
  colCount = n;
  [1, 2, 3, 4].forEach(x => $("btn-col-" + x).classList.toggle("active", x === n));
  assignSlots();
  // UX-05：栏数变化导致槽位分配重排时给提示，避免作者误以为某栏还是原来的版本
  if (slotVersions.length !== prev.length || prev.some((v, i) => v !== slotVersions[i])) {
    toast("栏数变化，版本已重新分配");
  }
  saveState();
  render();
}

$("btn-import").onclick = () => $("file-input").click();
$("btn-paste").onclick = () => openPasteModal();
$("btn-reselect").onclick = () => {
  if (versions.length && !confirm("清空全部草稿并重新选择？")) return;
  versions = []; baselineIdx = -1; docInfos = {}; anchors = []; slotVersions = []; singleView = -1;
  try { localStorage.removeItem(LS_STATE); } catch (e) { }
  render();
  $("file-input").click();
};
$("btn-char").onclick = () => setGranularity("char");
$("btn-line").onclick = () => setGranularity("line");
$("btn-split").onclick = () => setMode("split");
$("btn-unified").onclick = () => setMode("unified");
[1, 2, 3, 4].forEach(n => { $("btn-col-" + n).onclick = () => setColCount(n); });
$("btn-prev").onclick = () => goAnchor(-1);
$("btn-next").onclick = () => goAnchor(1);
$("chk-sync").onchange = e => { syncOn = e.target.checked; };
$("chk-hl").onchange = e => { highlightOn = e.target.checked; render(); };
$("chk-fm").onchange = e => {
  ignoreFM = e.target.checked;
  for (const v of versions) {
    const t = processText(v.raw, ignoreFM);
    v.text = t; v.paras = Diff.splitParas(t); v.count = Diff.charCount(t);
  }
  render();
};

$("file-input").onchange = e => {
  if (e.target.files && e.target.files.length) addFiles(e.target.files);
  e.target.value = "";
};

$("panes").addEventListener("click", e => {
  if (e.target.closest("button")) return;
  const el = e.target.closest("[data-pos]");
  if (el) goPos(+el.getAttribute("data-pos"));
});
$("panes").addEventListener("mouseover", onPaneOver);
$("panes").addEventListener("mouseout", onPaneOut);

document.addEventListener("click", e => {
  const t = e.target;
  const vpBtn = t.closest(".vpick-btn");
  if (vpBtn) {
    const vp = vpBtn.closest(".vpick");
    const wasOpen = vp.classList.contains("open");
    closeAllPickers();
    if (!wasOpen) vp.classList.add("open");
    return;
  }
  const vpRen = t.closest(".vpick-ren");
  if (vpRen) {
    const vi = +vpRen.getAttribute("data-ren");
    startRename(vi, vpRen.previousElementSibling);
    return;
  }
  const vpItem = t.closest(".vpick-item[data-pick]");
  if (vpItem) {
    const vi = +vpItem.getAttribute("data-pick");
    const vp = vpItem.closest(".vpick");
    const id = vp ? vp.getAttribute("data-vpick") : "";
    if (id === "single") singleView = vi;
    else if (id.indexOf("slot:") === 0) slotVersions[+id.slice(5)] = vi;
    closeAllPickers();
    saveState();
    render();
    return;
  }
  const set = t.closest("[data-set]");
  if (set) { baselineIdx = +set.getAttribute("data-set"); saveState(); render(); return; }
  const cl = t.closest("[data-clear]");
  if (cl) {
    const i = +cl.getAttribute("data-clear");
    if (!versions[i] || !confirm("确认移除「" + versions[i].name + "」？")) return;
    versions.splice(i, 1);
    if (baselineIdx > i) baselineIdx--;
    else if (baselineIdx === i) baselineIdx = versions.length ? 0 : -1;
    saveState(); render(); return;
  }
  const hren = t.closest("[data-header-ren]");
  if (hren) {
    const vi = +hren.getAttribute("data-header-ren");
    startRename(vi, hren.previousElementSibling);
    return;
  }
  const cp = t.closest("[data-copy]");
  if (cp) { copyText(versions[+cp.getAttribute("data-copy")].text); return; }
  // F-01：diff 行「采纳此句 → 定稿区」
  const adopt = t.closest("[data-adopt]");
  if (adopt) {
    const txt = adopt.getAttribute("data-adopt");
    if (txt && window.Editor && Editor.sendText) { Editor.sendText(txt); toast("已采纳到定稿区"); }
    return;
  }
  const si = t.closest("[data-slot-import]");
  if (si) { $("file-input").click(); return; }
  const sp = t.closest("[data-slot-paste]");
  if (sp) { openPasteModal(); return; }
  const sd = t.closest("[data-slot-done]");
  if (sd) { slotDone(); return; }
  if (t.closest("[data-paste-cancel]")) { closePasteModal(); return; }
  if (t.closest("#paste-mask")) { closePasteModal(); return; }
  if (!t.closest(".vpick")) closeAllPickers();
  if (!t.closest(".mode-wrap")) {
    const mw = $("mode-wrap");
    if (mw) mw.classList.remove("open");
  }
});

document.addEventListener("keydown", e => {
  const act = (typeof Hotkeys !== "undefined" && Hotkeys.actionFor) ? Hotkeys.actionFor(e) : null;
  if (act === "diff_next") { e.preventDefault(); goAnchor(1); }
  else if (act === "diff_prev") { e.preventDefault(); goAnchor(-1); }
});

const dover = $("drop-overlay");
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault();
  dover.classList.add("show");
}));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => {
  e.preventDefault();
  dover.classList.remove("show");
}));
document.addEventListener("drop", e => {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

let toastTimer = null;
const toastQueue = [];
let toastActive = false;
// UX-13：toast 走短队列，每条足时展示，连续操作不被覆盖
function toast(msg) {
  toastQueue.push(String(msg));
  if (!toastActive) nextToast();
}
function nextToast() {
  const msg = toastQueue.shift();
  if (msg == null) { toastActive = false; return; }
  toastActive = true;
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    toastActive = false;
    if (toastQueue.length) setTimeout(nextToast, 90);   // 换条间隔，避免视觉粘连
  }, (typeof C !== "undefined" && C.TOAST_MS) || 2500);
}

/* ---------- 窗口拖动 / 缩放 / 记忆 ---------- */

(function initWindow() {
  const w = $("app-window"), tb = $("title-bar"), rh = $("resize-handle"), mx = $("btn-max");
  if (!w || !tb || !rh || !mx) return;
  let geo = null;
  try {
    const s = localStorage.getItem("draft-compare-win");
    if (s) {
      geo = JSON.parse(s);
      if (geo.max) w.classList.add("maximized");
      else {
        if (geo.width) w.style.width = geo.width;
        if (geo.height) w.style.height = geo.height;
        if (geo.left) w.style.left = geo.left;
        if (geo.top) w.style.top = geo.top;
      }
    }
  } catch (e) { }
  function save() {
    try {
      localStorage.setItem("draft-compare-win", JSON.stringify({
        max: w.classList.contains("maximized"),
        width: w.style.width, height: w.style.height,
        left: w.style.left, top: w.style.top
      }));
    } catch (e) { }
  }
  let dragging = false, dx = 0, dy = 0;
  tb.addEventListener("mousedown", e => {
    if (e.target.closest("button,label,input")) return;
    if (w.classList.contains("maximized")) return;
    dragging = true;
    dx = e.clientX - w.offsetLeft;
    dy = e.clientY - w.offsetTop;
    e.preventDefault();
  });
  document.addEventListener("mousemove", e => {
    if (dragging) { w.style.left = (e.clientX - dx) + "px"; w.style.top = (e.clientY - dy) + "px"; }
    if (resizing) {
      w.style.width = Math.max(480, ow + (e.clientX - ox)) + "px";
      w.style.height = Math.max(320, oh + (e.clientY - oy)) + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    if (dragging || resizing) { dragging = false; resizing = false; save(); }
  });
  let resizing = false, ox = 0, oy = 0, ow = 0, oh = 0;
  rh.addEventListener("mousedown", e => {
    if (w.classList.contains("maximized")) return;
    resizing = true;
    ox = e.clientX; oy = e.clientY; ow = w.offsetWidth; oh = w.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  // 对比区沉浸放大（与定稿区 maxed 同理）。
  // 紧凑/扩展模式下 #app-window 本就全屏，原"窗口最大化"无意义，这里统一放大对比区。
  mx.onclick = () => {
    const maxed = document.body.classList.toggle("compare-maxed");
    mx.title = maxed ? "退出沉浸对比（还原）" : "沉浸对比（放大对比区）";
  };
})();

loadState();
applyCompact();
initModeMenu();
render();

/* ============ 工作区切换（对比 / 大纲） ============ */
function setWorkArea(mode) {
  const isOutline = mode === "outline";
  document.body.classList.toggle("mode-outline", isOutline);
  const panes = document.getElementById("panes");
  const ow = document.getElementById("outline-wrap");
  if (panes) panes.style.display = isOutline ? "none" : "";
  if (ow) ow.style.display = isOutline ? "" : "none";
  const tb = document.getElementById("toolbar");
  if (tb) tb.classList.toggle("outline-mode", isOutline);
  document.querySelectorAll("#seg-area button").forEach(b => b.classList.toggle("active", b.getAttribute("data-area") === mode));
  if (isOutline && window.OutlineManager) OutlineManager.render();
  Store.updateSettings({ ui: Object.assign({}, (Store.getSettings().ui) || {}, { workArea: mode }) });
}
document.addEventListener("click", e => {
  const a = e.target.closest("[data-area]");
  if (a) { setWorkArea(a.getAttribute("data-area")); return; }
  if (e.target.closest("#btn-diff-report")) { exportDiffReport(); return; }
});
(function () {
  const ui = (Store.getSettings().ui) || {};
  setWorkArea(ui.workArea === "outline" ? "outline" : "compare");
})();

/* ============ 定稿助手：词库加载 / 桥接 ============ */

const BankLoader = {
  state: { lexicon: [], golden: [], anti: [], favs: [], characters: [], settings: [] },

  async init() {
    let has = false;
    try {
      const c = await Store.count("bank");
      const g = await Store.count("golden");
      has = (c > 0 || g > 0);
    } catch (e) {
      console.warn("[词库] 读取存储失败，尝试内置词库：", e);
    }
    if (!has) {
      try {
        const ok = await this.seedFromBundle();
        if (!ok) {
          setBankStatus("未载入词库：点击「导入」拖入词库 .md 文件", false);
          Editor.setData();
          return;
        }
      } catch (e) {
        console.error("[词库] 内置词库播种失败：", e);
        setBankStatus("词库载入失败（存储不可用）：" + ((e && e.message) || e), false);
        Editor.setData();
        return;
      }
    }
    try {
      await this.rebuild();
    } catch (e) {
      console.error("[词库] 重建失败：", e);
      setBankStatus("词库重建失败：" + ((e && e.message) || e), false);
      Editor.setData();
    }
  },

  // 从 js/banks-data.js 的 window.BANK_BUNDLE 播种（file:// 与扩展都可用）
  async seedFromBundle() {
    let b = window.BANK_BUNDLE;
    if (!b) {
      b = await this.loadBundleScript();
    }
    if (!b || (!b.lexicon && !b.golden && !b.anti)) return false;
    const items = [
      ...(b.lexicon || []), ...(b.golden || []),
      ...(b.anti || []).map(r => ({ type: "anti", ...r }))
    ];
    await this.persist(items);
    await Store.setMeta("bundle-version", b.version || 1);
    return true;
  },

  loadBundleScript() {
    return new Promise(resolve => {
      const s = document.createElement("script");
      s.src = "js/banks-data.js";
      s.onload = () => resolve(window.BANK_BUNDLE || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  },

  async importFiles(list) {
    const items = [];
    for (const b of list) {
      try {
        if (b.kind === "lexicon") items.push(...Banks.parseLexicon(b.raw, b.file.name));
        else if (b.kind === "golden") items.push(...Banks.parseGolden(b.raw, b.file.name));
        else if (b.kind === "character") items.push(...Banks.parseCharacters(b.raw, b.file.name));
        else if (b.kind === "setting") items.push(...Banks.parseSettings(b.raw, b.file.name));
        else items.push(...Banks.parseAntiRules(b.raw).map(r => ({ type: "anti", ...r })));
      } catch (e) { }
    }
    if (items.length) await this.persist(items);
    await this.rebuild();
    return items.length;
  },

  async persist(items) {
    const uid = () => "U" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    const pick = (t) => items.filter(i => i.type === t).map(e => ({ ...e, id: e.id || uid() }));
    const lex = pick("lexicon");
    const gold = pick("golden");
    const anti = pick("anti");
    const characters = pick("character");
    const settings = pick("setting");
    if (lex.length) await Store.putAll("bank", lex);
    if (gold.length) await Store.putAll("golden", gold);
    if (anti.length) await Store.putAll("anti", anti);
    if (characters.length) await Store.putAll("character", characters);
    if (settings.length) await Store.putAll("setting", settings);
  },

  async rebuild() {
    // 单表读取失败不得让整个词库崩空（缺表/损坏时降级为空并告警）
    const safeAll = async (store) => {
      try { return await Store.all(store); }
      catch (e) { console.warn("[词库] 读取失败，已忽略：" + store, e); return []; }
    };
    const lex = await safeAll("bank");
    const gold = await safeAll("golden");
    const anti = await safeAll("anti");
    const favs = await Store.loadFavs().catch(() => []);
    const characters = await safeAll("character");
    const settings = await safeAll("setting");
    this.state = { lexicon: lex, golden: gold, anti, favs, characters, settings };
    // 共享状态：agent / 设定管理等消费者通过 AppState 读取（不再用可变全局）
    if (typeof window !== "undefined" && window.AppState) AppState.setLore(characters, settings);
    const freqRules = [];
    for (const e of lex) {
      if (e.antiAI) {
        const fr = Banks.freqRule(e.antiAI);
        if (fr && (fr.max !== null || fr.whole)) {
          freqRules.push(Object.assign({ terms: e.terms, word: e.word }, fr, { bannedPhrases: Banks.bannedPhrasesOf(e.antiAI) }));
        }
      }
    }
    Suggest.setData(lex, gold, anti, favs);
    Lint.compile(anti, freqRules);
    Editor.setGoldenCache(gold);
    Editor.setData();
    const userN = (lex.filter(e => e.user).length) + (gold.filter(e => e.user).length);
    setBankStatus("词库 " + lex.length + " 条 · 黄金句 " + gold.length + " 条 · 常用 " + favs.length + " 条" +
      (characters.length ? " · 角色 " + characters.length : "") + (settings.length ? " · 设定 " + settings.length : "") +
      (userN ? " · 自定义 " + userN : ""), true);
    if (window.BankManager) BankManager.onDataChanged();
  },

  // 重置为内置词库（清空并重新播种）
  async resetAll() {
    await Store.clear("bank");
    await Store.clear("golden");
    await Store.clear("anti");
    await Store.clear("character");
    await Store.clear("setting");
    const ok = await this.seedFromBundle();
    await this.rebuild();
    return ok;
  }
};

function setBankStatus(text, ok) {
  const b = document.getElementById("bank-status");
  if (b) { b.textContent = text; b.className = ok ? "ok" : ""; }
}

function addVersion(name, text) {
  if (versions.length >= MAX) { toast("对比区已满（最多 " + MAX + " 份），请先清空一个槽位"); return null; }
  versions.push(makeVersion(name, text));
  if (baselineIdx === -1) baselineIdx = 0;
  saveState();
  render();
  return versions.length - 1;
}

// 让某版本在对比区可见（放到某槽位并高亮）
function revealVersion(vi) {
  const v = versions[vi];
  if (!v) return;
  if (colCount === 1) { singleView = vi; render(); return; }
  const slots = Math.max(colCount - 1, 0);
  if (slots >= 1) {
    // 放到第一个空槽，否则替换最后一个槽
    const empty = slotVersions.findIndex(s => s == null);
    const idx = empty >= 0 ? empty : slots - 1;
    slotVersions[idx] = vi;
    render();
    requestAnimationFrame(() => {
      const cols = document.querySelectorAll("#panes .col");
      const col = cols[Math.min(idx + 1, cols.length - 1)];
      if (col) { col.classList.add("flash-col"); setTimeout(() => col.classList.remove("flash-col"), 1200); }
    });
  }
}

// 导出差异报告 md（由 docInfos 生成删/增/改清单）
function exportDiffReport() {
  if (versions.length < 2 || !Object.keys(docInfos).length) { toast("至少需要两份草稿才能导出差异报告"); return; }
  const lines = ["# 差异报告", "", "生成时间：" + new Date().toLocaleString(),
    "", "基准：《" + ((versions[baselineIdx] && versions[baselineIdx].name) || "?") + "》", ""];
  for (const vi of Object.keys(docInfos)) {
    const info = docInfos[vi];
    if (!info || info.vi === baselineIdx || !info.doc) continue;
    const v = info.v;
    lines.push("## 对比《" + (v && v.name ? v.name : "?") + "》", "",
      "同步 " + info.stats.same + " · 删 " + info.stats.del + " · 增 " + info.stats.add, "");
    const delLines = [], insLines = [], inlLines = [];
    for (const e of info.doc) {
      if (e.type === "delete") delLines.push("- ~~" + (e.text || "") + "~~");
      else if (e.type === "insert") insLines.push("- " + (e.text || ""));
      else if (e.type === "inline") {
        let d = "", a = "";
        for (const [o, s] of e.ops || []) { if (o === -1) d += s; else if (o === 1) a += s; }
        inlLines.push("- 改：" + (d ? "~~" + d + "~~" : "（删空）") + " → " + (a || "（删空）"));
      }
    }
    if (delLines.length) lines.push("### 删除（" + delLines.length + "）", "", ...delLines.slice(0, 60), "");
    if (insLines.length) lines.push("### 新增（" + insLines.length + "）", "", ...insLines.slice(0, 60), "");
    if (inlLines.length) lines.push("### 修改（" + inlLines.length + "）", "", ...inlLines.slice(0, 80), "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "差异报告.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("差异报告已导出");
}

window.AppBridge = { toast, copyText, addVersion, revealVersion, exportDiffReport };
window.BankLoader = BankLoader;

// 分类显示名覆盖（设置持久化，唯一源：Banks）
(function () {
  const cat = (Store.getSettings().catLabels) || {};
  Banks.setCatOverrides(cat);
})();

Store.loadSecrets();   // 启动即载入 API Key（IndexedDB），供设置面板同步读取
Editor.init();
BankLoader.init();
if (window.LibManager) LibManager.load().catch(err => console.warn("[前文库] 载入失败", err));   // 前文库载入（agent 跨章节检索用）

// 底部词库状态 → 打开词库管理
(function () {
  const bs = document.getElementById("bank-status");
  if (bs) bs.addEventListener("click", () => { if (window.BankManager) BankManager.open(); });
})();
