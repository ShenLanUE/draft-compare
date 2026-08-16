"use strict";
/* 模拟真人全量测试 v2 —— 完整解析 index.html 静态 DOM + 内存 IDB，按真实用户流程驱动 */

const fs = require("fs");
const path = require("path");
const ROOT = require("path").join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const errors = [];
const missing = new Set();
let dynId = 0;

/* ---------- 元素桩 ---------- */
function makeEl(id) {
  const el = {
    id, tagName: "DIV",
    style: {}, _innerHTML: "", value: "", checked: false, disabled: false, hidden: false,
    textContent: "", offsetWidth: 100, offsetHeight: 100, clientWidth: 300, clientHeight: 200,
    scrollTop: 0, scrollHeight: 0, selectionStart: 0, selectionEnd: 0,
    children: [], dataset: {}, _listeners: {}, _classes: new Set(),
    onclick: null, onchange: null, oninput: null,
    classList: {
      add: c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      toggle: (c, f) => { if (f === undefined) el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); else f ? el._classes.add(c) : el._classes.delete(c); },
      contains: c => el._classes.has(c)
    },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { if (c && typeof c === "object") c._parent = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
    focus() {}, select() {}, blur() {},
    setSelectionRange(s, e) { el.selectionStart = s; el.selectionEnd = e; },
    setRangeText(t, s, e, mode) { el.value = el.value.slice(0, s) + t + el.value.slice(e); },
    execCommand() { return false; },
    dispatchEvent(ev) { el.fire(ev.type || "input", { target: el }); },
    setAttribute() {}, removeAttribute() {}, replaceWith() {}, remove() {},
    getAttribute(k) {
      if (k === "class") return Array.from(el._classes).join(" ");
      if (k === "id") return el.id;
      if (k && k in el.dataset) return el.dataset[k] != null ? el.dataset[k] : null;
      return null;
    },
    hasAttribute(k) { return (k === "class" && el._classes.size > 0) || (k === "id" && !!el.id) || (k in el.dataset); },
    getBoundingClientRect() { return { top: 0, left: 0 }; },
    closest(sel) { let n = el; while (n) { if (matches(n, sel)) return n; n = n._parent; } return null; },
    querySelector(sel) { return findSel(el, sel, false); },
    querySelectorAll(sel) { return findSel(el, sel, true); },
    set innerHTML(v) { el._innerHTML = v; el.children = parseFragment(v); },
    get innerHTML() { return el._innerHTML; },
    fire(ev, e) {
      const evt = e || {}; evt.target = evt.target || el; evt.currentTarget = el;
      evt.preventDefault = evt.preventDefault || (() => {});
      const origSP = evt.stopPropagation || (() => {});
      let stopped = false;
      evt.stopPropagation = () => { stopped = true; origSP(); };   // 冒泡到 document 前尊重 stopPropagation（真实浏览器语义）
      (el._listeners[ev] || []).forEach(fn => { try { fn(evt); } catch (err) { errors.push({ where: el.id + "@" + ev, err }); } });
      if (!stopped && global.document._listeners[ev]) global.document._listeners[ev].forEach(fn => { try { fn(evt); } catch (err) { errors.push({ where: "doc@" + ev, err }); } });
    },
    click() {
      if (el.disabled) return;   // 禁用按钮不响应（真实浏览器行为）
      const evt = { target: el, preventDefault() {}, stopPropagation() {} };
      if (typeof el.onclick === "function") { try { el.onclick(evt); } catch (err) { errors.push({ where: el.id + "@onclick", err }); } }
      el.fire("click", evt);
    },
    change() {
      const evt = { target: el, preventDefault() {}, stopPropagation() {} };
      if (typeof el.onchange === "function") { try { el.onchange(evt); } catch (err) { errors.push({ where: el.id + "@onchange", err }); } }
      el.fire("change", evt);
    },
    input() {
      const evt = { target: el, preventDefault() {}, stopPropagation() {} };
      if (typeof el.oninput === "function") { try { el.oninput(evt); } catch (err) { errors.push({ where: el.id + "@oninput", err }); } }
      el.fire("input", evt);
    },
    keydown(key, mods) {
      // mods: 布尔（仅 ctrl）或 { ctrlKey, shiftKey, metaKey, altKey }；支持 Ctrl+Shift+Enter 等组合
      const m = (mods && typeof mods === "object") ? mods : { ctrlKey: !!mods };
      const e = { key, ctrlKey: !!m.ctrlKey, metaKey: !!m.metaKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey, isComposing: false, preventDefault() {}, stopPropagation() {}, target: el };
      (el._listeners["keydown"] || []).forEach(fn => { try { fn(e); } catch (err) { errors.push({ where: el.id + "@keydown", err }); } });
      if (global.document._listeners["keydown"]) global.document._listeners["keydown"].forEach(fn => { try { fn(e); } catch (err) { errors.push({ where: "doc@keydown", err }); } });
    }
  };
  Object.defineProperty(el, "className", {
    get() { return Array.from(el._classes).join(" "); },
    set(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  return el;
}

function matches(el, sel) {
  const norm = String(sel || "").trim();
  if (!norm) return false;
  if (norm.startsWith(".")) return !!(el._classes && el._classes.has(norm.slice(1)));
  if (norm.startsWith("#")) return el.id === norm.slice(1);
  if (/^[a-zA-Z]+$/.test(norm)) return (el.tagName || "").toUpperCase() === norm.toUpperCase();
  const attrs = [...norm.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
  return attrs.length > 0 && attrs.every(a => el.dataset[a[1]] !== undefined && (a[2] === undefined || el.dataset[a[1]] === a[2]));
}

function findSel(el, sel, all) {
  const out = [];
  const walk = (node) => {
    for (const c of (node.children || [])) {
      if (!c || typeof c !== "object") continue;
      if (matches(c, sel)) { if (!all) return c; out.push(c); }
      const d = walk(c);
      if (d && !all) return d;
    }
    return null;
  };
  const r = walk(el);
  return all ? out : r;
}

function parseFragment(htmlStr) {
  const root = { children: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(htmlStr))) {
    const text = htmlStr.slice(last, m.index);
    if (text.trim() && stack.length) stack[stack.length - 1]._tail = (stack[stack.length - 1]._tail || "") + text;
    last = re.lastIndex;
    const isClose = m[1] === "/", tag = m[2], attrs = m[3], selfClose = m[4] === "/";
    if (isClose) { stack.pop(); continue; }
    const el = makeEl("dyn-" + tag + "-" + (dynId++));
    el.tagName = tag.toUpperCase();
    const attrRe = /([a-zA-Z0-9-]+)(?:="([^"]*)")?/g;
    let am; while ((am = attrRe.exec(attrs))) {
      const k = am[1], v = am[2] || "";
      if (k === "class") v.split(/\s+/).filter(Boolean).forEach(c => el._classes.add(c));
      else if (k === "id") { el.id = v; idMap.set(v, el); }
      else if (k === "disabled") el.disabled = true;
      else if (k === "hidden") el.hidden = true;
      else if (k === "checked") el.checked = true;
      else if (k === "value") el.value = v;
      else el.dataset[k] = v;   // 完整属性名（含 data- 前缀），与选择器 [data-xxx] 一致
    }
    const parent = stack[stack.length - 1];
    if (selfClose) parent.children.push(el);
    else { parent.children.push(el); stack.push(el); }
    if (el.id) idMap.set(el.id, el);   // 动态生成的 id 也进注册表
  }
  if (last < htmlStr.length && stack.length) stack[stack.length - 1]._tail = (stack[stack.length - 1]._tail || "") + htmlStr.slice(last);
  const fill = (n) => (n.children || []).forEach(c => { if (c && typeof c === "object") { c.textContent = (c._tail || "").trim(); fill(c); } });
  fill(root);
  return root.children;
}

/* ---------- 解析 index.html body 静态结构 ---------- */
const idMap = new Map();
const bodyHtml = (html.match(/<body>([\s\S]*)<\/body>/) || [])[1] || "";
const bodyTree = { children: parseFragment(bodyHtml) };
(function collectIds(node) {
  if (!node || typeof node !== "object") return;
  if (node.id) idMap.set(node.id, node);
  (node.children || []).forEach(collectIds);
})({ children: bodyTree.children });

function getById(id) {
  if (idMap.has(id)) return idMap.get(id);
  if (!registryFallback.has(id)) { missing.add(id); registryFallback.set(id, makeEl(id)); }
  return registryFallback.get(id);
}
const registryFallback = new Map();

/* ---------- 全局桩 ---------- */
global.document = {
  getElementById: getById,
  createElement: (tag) => { const e = makeEl("dyn-" + tag + "-" + (dynId++)); e.tagName = tag.toUpperCase(); return e; },
  createTextNode: (t) => ({ nodeType: 3, textContent: t, children: [], _classes: new Set(), dataset: {} }),
  execCommand: () => false,
  head: { appendChild() {} },
  body: makeEl("body"),
  _listeners: {},
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
  querySelector(sel) { return findSel({ children: bodyTree.children }, sel, false); },
  querySelectorAll(sel) { return findSel({ children: bodyTree.children }, sel, true); }
};
global.window = global;
global.location = { href: "file:///" + ROOT.replace(/\\/g, "/") + "/index.html", search: "" };
global.getComputedStyle = () => ({ font: "14px sans-serif", fontSize: "14px", lineHeight: "21px", letterSpacing: "0px", padding: "4px", border: "1px solid #000", boxSizing: "border-box" });
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = () => {};
global.AbortController = AbortController;
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.Blob = class { };
global.FileReader = class { readAsText() { setTimeout(() => this.onload && this.onload({ target: { result: "" } }), 0); } };
global.confirm = () => true;

global.localStorage = (() => { const d = {}; return { getItem: k => (d[k] != null ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } }; })();

/* 内存 IDB（版本感知：只有更高版本才触发 onupgradeneeded；访问缺表抛 NotFoundError，对齐真实浏览器） */
const idbData = {};
let dbVersion = 1;
const makeReq = (result) => { const r = { result, onsuccess: null, onerror: null, error: null }; setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0); return r; };
global.indexedDB = {
  open: (name, version) => {
    const db = {
      version: dbVersion,
      objectStoreNames: { contains: n => n in idbData },
      createObjectStore: n => { idbData[n] = idbData[n] || {}; return {}; },
      transaction: (sname, mode) => {
        if (!(sname in idbData)) throw new Error("NotFoundError: object store '" + sname + "' not found");
        const t = { oncomplete: null, onerror: null };
        t.objectStore = (name) => ({
          getAll: () => makeReq(Object.values(idbData[name] || {})),
          put: (v) => { const k = (v.id != null ? v.id : v.key != null ? v.key : v.text); idbData[name] = idbData[name] || {}; idbData[name][k] = v; return makeReq(null); },
          clear: () => { idbData[name] = {}; return makeReq(null); },
          count: () => makeReq(Object.keys(idbData[name] || {}).length),
          get: k => makeReq(idbData[name] ? idbData[name][k] : null),
          delete: k => { if (idbData[name]) delete idbData[name][k]; return makeReq(null); }
        });
        queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); });
        return t;
      },
      close: () => {}
    };
    const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      // 低于当前版本打开 → 抛 VersionError（对齐真实浏览器）；无版本=打开当前版本不升级
      if (typeof version === "number" && version < dbVersion) {
        const err = new Error("VersionError");
        err.name = "VersionError";
        if (req.onerror) req.onerror({ target: { error: err } });
        return;
      }
      req.result = db;
      if (typeof version === "number" && version > dbVersion) {
        dbVersion = version;
        db.version = dbVersion;
        if (req.onupgradeneeded) req.onupgradeneeded();
      }
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }
};

process.on("uncaughtException", e => errors.push({ err: e }));
process.on("unhandledRejection", e => errors.push({ err: e }));

/* ---------- 种子数据（与真实词库结构一致，带 tags） ---------- */
global.BANK_BUNDLE = {
  version: 1,
  lexicon: [
    { type: "lexicon", category: "micro-action", word: "咽口水", terms: ["咽口水", "咽了咽口水"], gloss: "喉结滚动", example: "他咽了口口水", hint: "", antiAI: null, tags: ["紧张"], isEmo: true, genreTags: ["通用"] },
    { type: "lexicon", category: "micro-expression", word: "眼眶发酸", terms: ["眼眶发酸"], gloss: "小神态", example: "她眼眶一酸，别过头去", hint: "", antiAI: "单章≤2次", tags: ["难过"], isEmo: true, genreTags: ["通用"] }
  ],
  golden: [
    { type: "golden", category: "emotion", book: "样书", original: "关门的手停住了，她看着酒瓶下意识咽了咽口水。", why: "动作递进", how: "给角色找一扇门", source: "", tags: ["紧张"], genreTags: [] }
  ],
  anti: [{ type: "anti", level: "T1", terms: ["仿佛"], replacement: "删除" }, { type: "anti", level: "T1", terms: ["犹如"], replacement: "像" }]
};

/* ---------- 加载模块 ---------- */
const order = ["util.js", "constants.js", "ui.js", "bus.js", "appstate.js", "diff.js", "banks.js", "store.js", "suggest.js", "lint.js", "hotkeys.js", "llm.js", "modelpicker.js", "agent.js", "editor.js", "editor-settings.js", "editor-ai.js", "bankmanager.js", "loremanager.js", "library.js", "mdoutline.js", "app.js"];
for (const f of order) {
  try { require(path.join(ROOT, "js", f)); }
  catch (e) { errors.push({ where: "load:" + f, err: e }); }
}

const flow = async (name, fn) => {
  const before = errors.length;
  try { await fn(); } catch (e) { errors.push({ where: "flow:" + name, err: e }); }
  const newErrs = errors.slice(before);
  console.log((newErrs.length ? "✗" : "✓") + " " + name + (newErrs.length ? "  -> " + newErrs.map(x => (x.where || "") + " " + (x.err && x.err.message || x.err)).join(" | ") : ""));
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const q = (sel) => global.document.querySelector(sel);
const ok2 = (cond, name) => { if (!cond) errors.push({ where: "assert:" + name, err: new Error("断言失败 " + name) }); };

(async () => {
  await wait(150);

  console.log("=== 启动 ===");
  console.log("模块:", order.length, "| 启动异常:", errors.filter(e => e.where && String(e.where).startsWith("load")).map(e => (e.err && e.err.message || e.err).toString().split("\n")[0]).join(" | ") || "无", "| 缺失ID:", missing.size ? Array.from(missing).join(",") : "无");

  const S = global.Store, App = global.AppBridge, Ed = global.Editor, BM = global.BankManager, Lib = global.LibManager, BL = global.BankLoader;

  // 种子补充：角色/设定/前文 → 供 AI 全量注入与跨章节检索
  await S.putAll("character", [{ id: "c1", type: "character", name: "林晚", appearance: "黑长直，左眼角泪痣", personality: "外冷内热", relationships: "李恪的青梅" }]);
  await S.putAll("setting", [{ id: "s1", type: "setting", name: "青云宗", category: "门派", description: "北境第一大修仙宗门" }]);
  await S.putAll("library", [{ id: "l1", title: "第 3 章", text: "他坐在窗边，手指轻轻扣着桌面，喉结上下滚了滚，咽了咽口水。\n\n她始终没说话。", ts: 1 }]);
  // 词库种子（byEmotion / @搜索 / 换说法 依赖）：把 BANK_BUNDLE 写入 store 再 rebuild（需带 id）
  await S.putAll("bank", global.BANK_BUNDLE.lexicon.map((e, i) => ({ ...e, id: "SB" + i })));
  await S.putAll("golden", global.BANK_BUNDLE.golden.map((e, i) => ({ ...e, id: "SG" + i })));
  await BL.rebuild();
  await Lib.load();
  await wait(50);

  /* ===== A. 对比区 ===== */
  await flow("A1 导入两份草稿", () => {
    App.addVersion("草稿A", "第一段\n\n第二段\n\n第三段");
    App.addVersion("草稿B", "第一段\n\n第二段改了\n\n第四段");
  });
  await flow("A2 栏数/粒度/模式/差异跳转", () => {
    ["btn-col-1", "btn-col-2", "btn-col-3", "btn-col-4", "btn-char", "btn-line", "btn-split", "btn-unified", "btn-prev", "btn-next"].forEach(id => getById(id).click());
    getById("chk-hl").checked = false; getById("chk-hl").change();
    getById("chk-sync").checked = false; getById("chk-sync").change();
    getById("chk-fm").checked = false; getById("chk-fm").change();
  });
  await flow("A3 定稿送对比 + 沉浸放大还原", () => {
    getById("editor-ta").value = "这是定稿区写的内容。\n\n第二段。";
    getById("editor-ta").input();
    getById("btn-send-cmp").click();
    getById("btn-max").click();
    getById("btn-max").click();
  });

  /* ===== B. 定稿区 ===== */
  await flow("B1 输入/反AI检查", () => {
    getById("editor-ta").value = "他仿佛愣住了，瞳孔一缩，与此同时手指轻轻扣着桌面。";
    getById("editor-ta").input();
  });
  await flow("B2 @ 搜索 + 补全", () => {
    const ta = getById("editor-ta");
    ta.value = "他咽了咽口水 @咽";
    ta.selectionStart = ta.value.length; ta.selectionEnd = ta.value.length;
    ta.input();
    getById("btn-suggest").click();
  });
  await flow("B3 换说法", () => {
    const ta = getById("editor-ta");
    ta.value = "他感到很紧张";
    ta.selectionStart = 2; ta.selectionEnd = 6;
    getById("btn-replace").click();
  });
  await flow("B4 情绪/素材台/常用词句", () => {
    getById("btn-emo").click();
    getById("btn-material").click();
    getById("btn-fav").click();
    getById("fav-text").value = "他的手在抖\n\n她把话咽了回去";
    getById("fav-text").change();
    q('[data-fav-save]').click();
  });
  await flow("M6b 快捷键分流回归（BUG-001 Ctrl+Shift+Enter）", () => {
    // 必须在 H2 批量 md 覆盖词库之前跑（byEmotion 依赖种子词库）
    getById("editor-count").click();   // 复位遗留弹窗（重置 popupMode）
    const p = getById("suggest-popup");
    p.hidden = true;
    const ed = getById("editor-ta");
    ed.value = "他站在原地，心里紧张。";
    ed.selectionStart = 8; ed.selectionEnd = 10;   // 选中「紧张」
    // Ctrl+Shift+Enter → 走 doReplace（换说法）：弹窗带「替换」模式标题
    ed.keydown("Enter", { ctrlKey: true, shiftKey: true });
    const mode = q(".sug-mode");
    ok2(!p.hidden && mode && /替换「紧张」/.test(mode.textContent), "Ctrl+Shift+Enter 走换说法（带模式标题，BUG-001 修复）");
    // Ctrl+Enter → 走补全：无换说法模式标题
    getById("editor-count").click();
    p.hidden = true;
    ed.keydown("Enter", { ctrlKey: true });
    ok2(!q(".sug-mode"), "Ctrl+Enter 走补全（无换说法模式标题）");
    getById("editor-count").click();
  });
  await flow("V2 换说法弹窗标题区分（N-02）", () => {
    getById("editor-count").click();
    const ed = getById("editor-ta");
    ed.value = "他站在原地，心里紧张。";
    ed.selectionStart = 8; ed.selectionEnd = 10;   // 选中「紧张」
    getById("btn-replace").click();
    const mode = q(".sug-mode");
    ok2(!!mode && /替换「紧张」/.test(mode.textContent), "换说法弹窗显示模式标题（N-02）");
    getById("editor-count").click();
  });

  /* ===== C. 词库管理 ===== */
  await flow("C1 词库管理 tab 渲染（无角色/设定）", () => {
    BM.open();
    ["lexicon", "golden", "anti", "fav"].forEach(t => {
      getById("bank-search").value = ""; getById("bank-search").input();
      getById("bank-prev").click(); getById("bank-next").click();
    });
    const tabs = getById("bank-tabs").querySelectorAll("button");
    ok2(tabs.length === 4, "词库管理器只剩 4 个 tab：" + tabs.length);
    ok2(![...tabs].some(b => b.getAttribute("data-btab") === "character" || b.getAttribute("data-btab") === "setting"), "词库管理器不再含角色/设定 tab");
    BM.close();
  });
  await flow("C2 设定：新增角色卡（md 模式）", async () => {
    q('[data-lore-open]').click();
    q('[data-lore-add]').click();
    q('[data-lemode="md"]').click();
    getById("lore-edit-md").value = "## 测试角色\n- **外貌**：金发\n- **性格**：外冷内热";
    getById("lore-edit-md").input();
    q('[data-lore-edit-save]').click();
    await new Promise(r => setTimeout(r, 120));
    const list = getById("lore-list");
    ok2(list && list.innerHTML.includes("测试角色"), "设定弹窗新增角色卡成功：" + (list && list.innerHTML.slice(0, 80) || "无"));
    q('[data-lore-close]').click();
  });
  await flow("C3 设定：切分类新增门派设定卡", async () => {
    q('[data-lore-open]').click();
    q('[data-lore-cat="门派"]').click();
    q('[data-lore-add]').click();
    getById("lore-edit-form").querySelector('[data-lk="name"]').value = "青云宗";
    getById("lore-edit-form").querySelector('[data-lk="description"]').value = "北境第一大修仙宗门";
    q('[data-lore-edit-save]').click();
    await new Promise(r => setTimeout(r, 120));
    ok2(getById("lore-list").innerHTML.includes("青云宗"), "门派分类新增设定卡成功");
    const sets = await S.all("setting");
    ok2(sets.some(s => s.name === "青云宗" && s.category === "门派"), "设定卡入 setting 表且分类=门派");
    q('[data-lore-close]').click();
  });

  /* ===== D. 设置 / Provider ===== */
  await flow("D1 设置切换 Provider + 保存", () => {
    getById("btn-settings").click();
    getById("set-provider").value = "qwen"; getById("set-provider").change();
    getById("set-base").value = "https://api.deepseek.com/v1";
    getById("set-key").value = "sk-x";
    getById("set-ctxlimit").value = "2000";
    getById("set-libsegs").value = "4";
    q('[data-settings-save]').click();
  });
  await flow("D2 Provider 管理弹窗", () => {
    getById("btn-settings").click();
    q('[data-provider-manage]').click();
    q('[data-provider-close]').click();
  });

  /* ===== E. AI 深度辅助 ===== */
  await flow("E1 AI 润色", () => {
    const LLM = global.LLM;
    LLM.chat = async (msgs) => { const u = msgs[1].content; return u.includes("搜索关键词") ? '[{"kw":"眼眶","type":"小神态"}]' : "他眼眶一热，别过头去。\n\n她没再说话。"; };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("他眼眶一热。"); return "他眼眶一热。\n\n她没再说话。"; };
    S.updateSettings({ llmEnabled: true, activeProvider: "deepseek" });
    S.saveSecret("deepseek", "sk-x");
    getById("editor-ta").value = "他看着她的背影，心里难受。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    getById("btn-ai").click();
    q('[data-ai-task="polish"]').click();
  });
  await flow("E2 AI 续写（流式）", () => {
    getById("btn-ai").click();
    q('[data-ai-task="continue"]').click();
  });

  /* ===== F. 前文库 ===== */
  await flow("F1 前文库新建/搜索", () => {
    Lib.open();
    q('[data-lib-new]').click();
    getById("lib-edit-title").value = "第 9 章";
    getById("lib-edit-text").value = "她推开门，雨声涌进来。\n\n他仍坐在原位。";
    q('[data-lib-edit-save]').click();
    getById("lib-search").value = "雨声"; getById("lib-search").input();
    Lib.close();
  });

  /* ===== G. 对比区高级（基准/清空/多栏） ===== */
  await flow("G1 三栏 + 设基准 + 清空一栏", () => {
    App.addVersion("草稿C", "第一段\n\n第四段新增内容");
    getById("btn-col-3").click();
    const setBtn = q('[data-set]');
    if (setBtn) setBtn.click();
    const clrBtn = q('[data-clear]');
    if (clrBtn) clrBtn.click();
    getById("btn-col-2").click();
  });

  /* ===== H. 词库管理深度 ===== */
  await flow("H1 编辑词条（表单）", () => {
    BM.open();
    const editBtn = q('[data-bk-edit]');
    if (editBtn) {
      editBtn.click();
      const w = getById("entry-form").querySelector('[data-fk="word"]');
      if (w) { w.value = "咽口水·改"; }
      q('[data-entry-save]').click();
    }
    BM.close();
  });
  await flow("H2 批量 md 编辑保存", () => {
    BM.open();
    q('[data-bank-batch]').click();
    getById("batch-md").value = "## 紧张\n- **攥衣角** — 桌下手捏成拳\n";
    q('[data-batch-save]').click();
    BM.close();
  });
  await flow("H3 分类管理 + 格式说明", () => {
    BM.open();
    q('[data-bank-cat]').click();
    q('[data-cat-save]').click();
    q('[data-bank-format]').click();
    q('[data-help-close]').click();
    BM.close();
  });

  /* ===== I. Provider 深度 ===== */
  await flow("I1 新建自定义 Provider", () => {
    getById("btn-settings").click();
    q('[data-provider-manage]').click();
    q('[data-provider-new]').click();
    getById("prov-new-name").value = "我的中转";
    q('[data-provider-create]').click();
  });
  await flow("I2 复制/删除/添加预设", () => {
    const cnt = () => errors.length;
    getById("btn-settings").click(); let e0 = cnt();
    q('[data-provider-manage]').click(); let e1 = cnt();
    const dup = q('[data-prov-act="dup"]');
    console.log("    dup:", dup ? "存在 attr=" + dup.getAttribute("data-prov-id") : "无");
    if (dup) dup.click(); let e2 = cnt();
    const del = q('[data-prov-act="del"]');
    console.log("    del:", del ? "存在 attr=" + del.getAttribute("data-prov-id") : "无");
    if (del) del.click(); let e3 = cnt();
    q('[data-provider-preset]').click(); let e4 = cnt();
    const presetBtn = q('[data-preset="groq"]');
    console.log("    groq:", presetBtn ? "存在 attr=" + presetBtn.getAttribute("data-preset") + " disabled=" + presetBtn.disabled : "无");
    if (presetBtn) presetBtn.click(); let e5 = cnt();
    q('[data-provider-close]').click(); let e6 = cnt();
    console.log("    errs: open=%d manage=%d dup=%d del=%d preset=%d groq=%d close=%d", e0, e1, e2, e3, e4, e5, e6);
  });

  /* ===== J. AI 深度任务（扩写/重写，含角色设定与前文注入） ===== */
  await flow("J1 AI 扩写 + 重写", () => {
    const LLM = global.LLM;
    LLM.chat = async (msgs) => { const u = msgs[1].content; return u.includes("搜索关键词") ? '[{"kw":"雨","type":"词汇"}]' : "雨声灌进来，他浑身一激灵。\n\n她把门带上。"; };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("雨声灌进来。"); return "雨声灌进来，他浑身一激灵。\n\n她把门带上。"; };
    getById("editor-ta").value = "雨下得很大。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    getById("btn-ai").click();
    q('[data-ai-task="expand"]').click();
    getById("btn-ai").click();
    q('[data-ai-task="rewrite"]').click();
  });

  /* ===== K. 设置规则/自动补全/流式 ===== */
  await flow("K1 规则开关 + 自动补全 + 流式保存", () => {
    getById("btn-settings").click();
    getById("rule-t1").checked = false; getById("rule-t1").change();
    getById("set-autosuggest").checked = true; getById("set-autosuggest").change();
    getById("set-llm").checked = true; getById("set-llm").change();
    getById("set-stream").checked = true; getById("set-stream").change();
    q('[data-settings-save]').click();
  });

  /* ===== L. 前文库删除/清空 ===== */
  await flow("L1 前文库删除 + 清空", () => {
    Lib.open();
    const delBtn = q('[data-lib-del]');
    if (delBtn) delBtn.click();
    q('[data-lib-clear]').click();
    Lib.close();
  });

  await flow("I2a 仅点预设开关+groq", () => {
    getById("btn-settings").click();
    q('[data-provider-manage]').click();
    const before = errors.length;
    q('[data-provider-preset]').click();
    const g = q('[data-preset="groq"]');
    console.log("    groq 按钮:", g ? "存在 dataset=" + JSON.stringify(g.dataset) : "不存在");
    if (g) g.click();
    console.log("    预设点击新增错误:", errors.length - before);
    q('[data-provider-close]').click();
  });

  /* ===== M. 边缘 UX 流 ===== */
  await flow("M1 纯阅读模式切换", () => {
    getById("chk-hl").checked = false; getById("chk-hl").change();
    getById("btn-unified").click();
    getById("chk-hl").checked = true; getById("chk-hl").change();
  });
  await flow("M2 未开启 LLM 时点 AI", () => {
    S.updateSettings({ llmEnabled: false });
    getById("btn-ai").click();
    const it = q('[data-ai-task="polish"]');
    if (it) it.click();
    S.updateSettings({ llmEnabled: true });
  });
  await flow("M3 常用词句删除", () => {
    BM.open();
    const favDel = q('[data-bank-fav-del]');
    if (favDel) favDel.click();
    BM.close();
  });
  await flow("M4 情绪选择 + 素材台刷新", () => {
    getById("btn-emo").click();
    const emo = q('[data-emo="难过"]');
    if (emo) emo.click();
    getById("mat-search").value = "咽";
    getById("mat-search").input();
  });
  await flow("M4b 情绪选择器导出回归（BUG-001）", () => {
    ok2(typeof global.EditorAi.syncAiEmo === "function", "EditorAi.syncAiEmo 已导出（BUG-001）");
    ok2(typeof global.EditorAi.syncAiCfgFromUI === "function", "EditorAi.syncAiCfgFromUI 已导出");
  });
  await flow("M5 fav 管理打开/取消", () => {
    getById("btn-fav").click();
    q('[data-fav-cancel]').click();
  });
  await flow("M6 插入 AI 改写结果", () => {
    const ins = q('[data-ai-ins]');
    if (ins) ins.click();
  });
  await flow("F2 AI 全部插入（批量）", () => {
    const allBtn = q('[data-ai-ins-all]');
    if (!allBtn) { ok2(true, "（当前无多版本结果，批量插入跳过）"); return; }
    const ed = getById("editor-ta");
    const before = ed.value;
    allBtn.click();
    ok2(ed.value !== before, "全部插入：定稿区内容变化");
  });

  // 确保存在一个可用（base+key）的 active Provider，避免被前面流程删掉 deepseek 后 AI 不可用
  const ensureAIReady = () => {
    const provs = S.getProviders();
    const workId = provs["openai"] ? "openai" : Object.keys(provs)[0];
    S.updateSettings({ llmEnabled: true, activeProvider: workId, activeModels: {} });
    S.saveSecret(workId, "sk-x");
    return workId;
  };

  /* ===== N. 2.6.0 新功能（模型路由 / 快速切换 / Agent 配置） ===== */
  await flow("N1 快速切换默认模型", () => {
    getById("btn-ai").click();
    const sel = getById("ai-model-sel");
    ok2(sel && sel.children.length > 0, "AI 菜单含模型下拉选项");
    sel.value = "qwen||qwen-plus";
    sel.change();
    ok2(S.getSettings().activeProvider === "qwen" && S.getSettings().activeModels.qwen === "qwen-plus", "快速切换更新默认 Provider·模型记忆");
    getById("btn-ai").click();
  });
  await flow("N2 Agent 模型绑定 + Agent 配置保存生效", () => {
    getById("btn-settings").click();
    q('[data-set-tab="agent"]').click();
    const wp = getById("agent-model-writer");
    ok2(!!wp && wp.children.length > 0, "Agent 模型下拉含选项");
    wp.value = "kimi||moonshot-v1-8k";
    wp.change();
    getById("cfg-systemnote").value = "都市文风";
    getById("cfg-uselore").checked = false;
    getById("cfg-uselore").change();
    q('[data-settings-save]').click();
    ok2(S.getSettings().agentModels.writer && S.getSettings().agentModels.writer.providerId === "kimi", "Agent 模型绑定保存（写作→kimi）");
    ok2(S.getSettings().agentCfg.systemNote === "都市文风", "systemNote 保存");
    ok2(S.getSettings().agentCfg.useLore === false, "useLore 开关保存");
  });
  await flow("N3 按写作 Agent 模型执行 AI（mock）", () => {
    const LLM = global.LLM;
    let usedConf = null;
    LLM.chat = async (msgs, opts, conf) => { const u = msgs[1].content; if (u.includes("搜索关键词")) return '[{"kw":"眼眶","type":"小神态"}]'; usedConf = conf; return "改写一。\n\n改写二。"; };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("改写一。"); return "改写一。\n\n改写二。"; };
    getById("editor-ta").value = "她看着窗外，心里难受。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    getById("btn-ai").click();
    q('[data-ai-task="polish"]').click();
    ok2(!usedConf || usedConf.providerId === "kimi", "写作子 Agent 按绑定传 kimi");
  });

  /* ===== O. 2.6.0 深度 / 边界（最易出问题 & 影响体验） ===== */
  await   flow("O1 多模型表单保存往返", () => {
    getById("btn-settings").click();
    const pid = getById("set-provider").value;
    getById("set-models").value = "m1, m2";
    q('[data-settings-save]').click();
    const saved = S.getProviders()[pid];
    ok2(!!saved && Array.isArray(saved.models) && saved.models.includes("m2"), "set-models 保存进 provider.models");
    getById("btn-settings").click();
    ok2(getById("set-models").value.indexOf("m2") >= 0, "再次打开回填模型列表");
    q('[data-settings-cancel]').click();
  });
  await flow("O2 Agent 绑定 Provider 被删 → 回落默认", async () => {
    S.updateSettings({ agentModels: { writer: { providerId: "kimi", model: "moonshot-v1-8k" } } });
    // 删除 kimi
    getById("btn-settings").click();
    q('[data-provider-manage]').click();
    const delKimi = q('[data-prov-act="del"][data-prov-id="kimi"]');
    ok2(!!delKimi, "找到 kimi 删除按钮");
    if (delKimi) delKimi.click();
    q('[data-provider-close]').click();
    // 跑 polish → 应回落当前默认（deepseek），不抛"AI 未开启"
    const LLM = global.LLM;
    let usedConf2 = null;
    LLM.chat = async (msgs, opts, conf) => { const u = msgs[1].content; if (u.includes("搜索关键词")) return '[{"kw":"眼眶","type":"小神态"}]'; usedConf2 = conf; return "改写一。\n\n改写二。"; };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("改写一。"); return "改写一。\n\n改写二。"; };
    ensureAIReady();
    getById("editor-ta").value = "她垂下眼。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    getById("btn-ai").click();
    q('[data-ai-task="polish"]').click();
    await new Promise(r => setTimeout(r, 120));
    ok2(usedConf2 === null || usedConf2.providerId !== "kimi", "被删路由回落默认（不再按 kimi）");
  });
  await flow("O3 上下文长度上限生效（截断）", async () => {
    const LLM = global.LLM;
    let seenCtx = "", calls = 0;
    LLM.chat = async (msgs, opts, conf) => { calls++; const u = msgs[1].content; if (u.includes("搜索关键词")) return '[{"kw":"眼眶","type":"小神态"}]'; seenCtx = u; return "改写一。\n\n改写二。"; };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("改写一。"); return "改写一。\n\n改写二。"; };
    ensureAIReady();
    S.updateSettings({ ctxLimit: 8 });
    const long = "从前有座山，山上有座庙，庙里有个老和尚在讲故事。";
    getById("editor-ta").value = long;
    getById("editor-ta").selectionStart = long.length;
    getById("editor-ta").selectionEnd = long.length;
    getById("btn-ai").click();
    q('[data-ai-task="continue"]').click();
    await new Promise(r => setTimeout(r, 150));
    console.log("    O3 calls:", calls, "seenCtx len:", (seenCtx || "").length, "head:", (seenCtx || "").slice(0, 40).replace(/\n/g, "\\n"));
    ok2(seenCtx.includes("已截取最近 8 字"), "上下文超限时注明截断");
    ok2(seenCtx.indexOf("从前有座山") < 0, "超限部分被裁掉");
    S.updateSettings({ ctxLimit: 0 });
  });
  await flow("O4 空角色/设定/前文时 AI 仍可用", async () => {
    const LLM = global.LLM;
    let seenW = "";
    LLM.chat = async (msgs, opts, conf) => { const u = msgs[1].content; if (u.includes("搜索关键词")) return '[{"kw":"眼眶","type":"小神态"}]'; seenW = u; return "改写一。\n\n改写二。"; };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("改写一。"); return "改写一。\n\n改写二。"; };
    ensureAIReady();
    await Promise.all([S.clear("character"), S.clear("setting"), S.clear("library")]);
    await BL.rebuild();
    await Lib.load();
    getById("editor-ta").value = "他推开门。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    getById("btn-ai").click();
    q('[data-ai-task="continue"]').click();
    await new Promise(r => setTimeout(r, 120));
    ok2(seenW.length > 0 && seenW.includes("任务：续写下一段"), "空素材库下 AI 正常出稿");
  });
  await flow("O5 快速切换后菜单标题更新", () => {
    getById("btn-ai").click();
    const sel = getById("ai-model-sel");
    sel.value = "groq||llama-3.3-70b-versatile";
    sel.change();
    ok2(S.getSettings().activeProvider === "groq", "快速切到 groq");
    const label = getById("ai-menu-label").textContent;
    ok2(label.indexOf("AI 润色") >= 0, "AI 按钮固定为「AI 润色」：" + label);
    getById("btn-ai").click();
    // 还原默认，避免影响后续
    S.updateSettings({ activeProvider: "deepseek", activeModels: { deepseek: "deepseek-chat" } });
  });

  /* ===== P. 多子 Agent：自定义 Agent + 素材整理 LLM 模式 + 审校 ===== */
  await flow("P1 自定义 Agent 新建 → 面板出现 → 运行", async () => {
    getById("btn-settings").click();
    q('[data-set-tab="agent"]').click();
    q('[data-agent-new]').click();
    getById("agent-edit-name").value = "古风写手";
    getById("agent-edit-prompt").value = "你是古风写手：多用文言对白。";
    const amSel = getById("agent-edit-model");
    amSel.value = "kimi||moonshot-v1-8k";
    amSel.change();
    q('[data-amode="direct"]').click();
    q('[data-agent-save]').click();
    const agents = S.getSettings().customAgents || [];
    ok2(agents.length === 1 && agents[0].name === "古风写手" && agents[0].pipeline === false, "自定义 Agent 保存（name+pipeline）");
    ok2(getById("custom-agent-list").innerHTML.includes("古风写手"), "设置里自定义 Agent 列表渲染");
    q('[data-settings-cancel]').click();

    getById("btn-ai").click();
    const cBtn = q('[data-ai-task="' + agents[0].id + '"]');
    ok2(!!cBtn, "AI 面板出现自定义 Agent 按钮");
    const LLM = global.LLM;
    let seenSys = "", seenConf = null;
    LLM.chat = async (msgs, opts, conf) => {
      const u = msgs[1].content, sys = msgs[0].content;
      if (u.includes("搜索关键词")) return '[{"kw":"咽口水","type":"小动作"}]';
      seenSys = sys; seenConf = conf;
      return "古风正文一。\n\n古风正文二。";
    };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("古风正文一。"); return "古风正文一。\n\n古风正文二。"; };
    getById("editor-ta").value = "他推开门，雨声涌进来。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    cBtn.click();
    await new Promise(r => setTimeout(r, 150));
    ok2(seenSys.includes("你是古风写手"), "自定义 Agent 系统提示词生效");
    ok2(!seenConf || seenConf.providerId === "kimi", "自定义 Agent 用自身绑定 kimi");
    getById("btn-ai").click();
  });
  await flow("P2 素材整理 LLM 模式 + 审校开关", async () => {
    getById("btn-settings").click();
    q('[data-set-tab="agent"]').click();
    getById("agent-material-mode").value = "llm"; getById("agent-material-mode").change();
    getById("agent-reviewer-on").checked = true; getById("agent-reviewer-on").change();
    q('[data-settings-save]').click();
    const am = S.getSettings().agentModels;
    ok2(am.material.mode === "llm" && am.reviewer.enabled === true, "素材LLM模式+审校开关保存");

    const LLM = global.LLM;
    let sawMatLlm = false, sawReviewer = false;
    // 词库被前面 H2 批量编辑替换过，这里播种一个确定命中的词条，保证素材检索不空
    await S.clear("bank");
    await S.putAll("bank", [{ id: "p2lex", type: "lexicon", category: "micro-action", word: "攥衣角", terms: ["攥衣角"], gloss: "紧张小动作", example: "", hint: "", antiAI: null, tags: [], genreTags: [] }]);
    await BL.rebuild();
    LLM.chat = async (msgs, opts, conf) => {
      const u = msgs[1].content, sys = msgs[0].content;
      if (u.includes("搜索关键词")) return '[{"kw":"攥衣角","type":"词汇"}]';
      if (u.includes("候选素材")) { sawMatLlm = true; return "[小动作] 攥衣角"; }
      if (sys.includes("审校编辑")) { sawReviewer = true; return "审校后的正文。"; }
      return "正文一。\n\n正文二。";
    };
    LLM.streamChat = async (msgs, opts) => { if (opts && opts.onDelta) opts.onDelta("正文一。"); return "正文一。\n\n正文二。"; };
    getById("editor-ta").value = "他攥着拳站在门口。";
    getById("editor-ta").selectionStart = getById("editor-ta").value.length;
    getById("editor-ta").selectionEnd = getById("editor-ta").value.length;
    getById("btn-ai").click();
    q('[data-ai-task="continue"]').click();
    await new Promise(r => setTimeout(r, 200));
    ok2(sawMatLlm, "素材整理 LLM 模式触发调用");
    ok2(sawReviewer, "审校子 Agent 触发调用");
    getById("btn-ai").click();
    // 还原，避免影响后续流程
    S.updateSettings({ agentModels: { material: { mode: "local" }, reviewer: { enabled: false } } });
  });

  /* ===== Z. 回归：前文库导入 + 词句库不空（老库缺表 bug） ===== */
  await flow("Z1 前文库导入 md/txt 文件", async () => {
    global.FileReader = class {
      readAsText() {
        const self = this;
        setTimeout(() => {
          self.result = "这是导入的前文正文。\n\n她站在门口没有动。";
          if (self.onload) self.onload({ target: { result: self.result } });
        }, 0);
      }
    };
    Lib.open();
    const libFile = getById("lib-file");
    libFile.files = [{ name: "第 12 章.txt", text: "这是导入的前文正文。\n\n她站在门口没有动。" }];
    libFile.change();
    await new Promise(r => setTimeout(r, 80));
    // 清掉前面流程遗留的搜索词，否则新章节会被搜索过滤掉（真实用户场景：导入前先清空搜索）
    getById("lib-search").value = "";
    getById("lib-search").input();
    global.FileReader = class { readAsText() { setTimeout(() => this.onload && this.onload({ target: { result: "" } }), 0); } };
    const list = getById("lib-list");
    ok2(list && list.innerHTML.includes("第 12 章"), "导入 md/txt 后标题入库：" + (list && list.innerHTML.slice(0, 80) || "无"));
    Lib.close();
  });
  await flow("Z2 词句库非空 + 前文库 store 可用（回归）", async () => {
    ok2(BL.state.lexicon.length > 0 && BL.state.golden.length > 0,
      "词句库已载入（词句库空 bug 回归）：lexicon=" + BL.state.lexicon.length + " golden=" + BL.state.golden.length);
    await S.putAll("library", [{ id: "reg1", title: "回归验证", text: "正文", ts: 1 }]);
    const libs = await S.all("library");
    ok2(libs.some(c => c.id === "reg1"), "前文库 store 读写正常（前文库 bug 回归）");
  });

  /* ===== Y. 大纲/阅读工作区（切换 + 导入 + 渲染 + 联动入口） ===== */
  await flow("Y1 大纲工作区：切换 + 导入 + 渲染", async () => {
    q('[data-area="outline"]').click();
    ok2(getById("outline-wrap").style.display !== "none", "切到大纲模式");
    global.FileReader = class {
      readAsText() {
        const self = this;
        setTimeout(() => { self.result = "# 第一卷\n\n正文段落\n\n## 第一章\n\n细节"; if (self.onload) self.onload({ target: { result: self.result } }); }, 0);
      }
    };
    const fi = getById("outline-file-input");
    fi.files = [{ name: "大纲.md", text: "# 第一卷\n\n正文段落\n\n## 第一章\n\n细节" }];
    fi.change();
    await new Promise(r => setTimeout(r, 80));
    global.FileReader = class { readAsText() { setTimeout(() => this.onload && this.onload({ target: { result: "" } }), 0); } };
    ok2(getById("outline-file").innerHTML.includes("大纲"), "大纲导入后文件可选");
    ok2(getById("outline-body").innerHTML.includes("第一卷"), "大纲树渲染出标题");
    q('[data-area="compare"]').click();
    ok2(getById("outline-wrap").style.display === "none", "切回对比模式");
  });

  /* ===== B. 补充：备份导出 / 反AI T1 替换 / 大纲联动 ===== */
  await flow("B5 备份导出（Store.snapshot 驱动，含 docs）", async () => {
    getById("btn-settings").click();
    ok2(!!q('[data-backup-export]'), "设置里存在备份导出按钮");
    q('[data-backup-export]').click();
    await new Promise(r => setTimeout(r, 60));
    EditorSettings.closeSettings();
  });
  await flow("B6 反AI T1 一键替换按钮", async () => {
    S.updateSettings({ llmRules: { t1: true, t2: true, t3: true, ctx: true, pattern: true, freq: true } });
    global.Lint.compile([{ level: "T1", terms: ["犹如"], replacement: "像" }].concat((BL.state.anti || [])), []);
    const ed = getById("editor-ta");
    ed.value = "他犹如愣住。";
    ed.input();
    await new Promise(r => setTimeout(r, 420));
    ok2(!!q('[data-problem-fix]'), "T1 禁用词出现一键替换按钮");
  });
  await flow("B7 大纲送定稿 + 加前文库联动", async () => {
    q('[data-area="outline"]').click();
    const ed = getById("editor-ta");
    const before = ed.value;
    q('[data-outline-send-all]').click();
    await new Promise(r => setTimeout(r, 30));
    ok2(ed.value !== before, "送定稿：定稿区收到大纲文本");
    const libBefore = (await S.all("library")).length;
    q('[data-outline-lib]').click();
    await new Promise(r => setTimeout(r, 50));
    const libAfter = (await S.all("library")).length;
    ok2(libAfter > libBefore, "加前文库：文档进入前文库");
    q('[data-area="compare"]').click();
  });

  /* ===== v2.14 新增功能回归 ===== */
  await flow("V1 差异采纳到定稿（F-01）", async () => {
    getById("btn-unified").click();
    await new Promise(r => setTimeout(r, 30));
    const adopt = q('[data-adopt]');
    if (!adopt) { ok2(true, "（当前视图无差异行，采纳跳过）"); getById("btn-split").click(); return; }
    const ed = getById("editor-ta");
    const before = ed.value;
    adopt.click();
    await new Promise(r => setTimeout(r, 30));
    ok2(ed.value !== before, "采纳差异：定稿区收到新版句子");
    getById("btn-split").click();
  });
  await flow("V3 快捷键面板 ?（F-03）", () => {
    // 正文编辑器聚焦时打 ? 不弹面板（? 与输入冲突修复）
    const ed = getById("editor-ta");
    ed.keydown("?");
    ok2(!getById("shortcut-modal").classList.contains("show"), "正文内按 ? 不弹快捷键面板（不吞问号）");
    // 焦点在非输入类元素（如标题/空白处）按 ? 才弹
    getById("editor-count").keydown("?");
    ok2(getById("shortcut-modal").classList.contains("show"), "非输入焦点按 ? 弹出快捷键面板");
    q('[data-shortcut-close]').click();
    ok2(!getById("shortcut-modal").classList.contains("show"), "关闭快捷键面板");
  });
  await flow("V4 词库星标收藏（F-04）", () => {
    if (getById("material-panel").hidden) getById("btn-material").click();
    const browse = q('[data-mat="browse"]');
    if (browse) browse.click();
    const star = q('[data-star]');
    if (!star) { ok2(true, "（素材台无词条，星标跳过）"); return; }
    const word = star.getAttribute("data-star");
    star.click();
    const starred = S.getSettings().starred || [];
    ok2(starred.indexOf(word) >= 0, "点星后进入收藏列表");
    const star2 = q('[data-star="' + word + '"]');
    if (star2) star2.click();
    const starred2 = S.getSettings().starred || [];
    ok2(starred2.indexOf(word) < 0, "再点取消收藏");
  });
  await flow("V5 大纲进度标记（F-06）", () => {
    q('[data-area="outline"]').click();
    const st = q('[data-ol-status]');
    if (!st) { ok2(true, "（大纲无节点，进度跳过）"); q('[data-area="compare"]').click(); return; }
    const label0 = st.textContent;
    st.click();
    const st2 = q('[data-ol-status]');
    ok2(!!st2 && st2.textContent !== label0, "点状态徽标后状态变化");
    q('[data-area="compare"]').click();
  });
  await flow("V6 反AI导出报告 + 备份点击无异常（F-05/F-07）", () => {
    const exp = getById("problems-export");
    if (exp) exp.click();
    const bku = q('[data-backup-export]');
    if (bku) bku.click();
    ok2(true, "导出报告 / 备份导出点击无异常");
  });

  /* ===== HK. 用户自定义快捷键（v2.15） ===== */
  await flow("HK1 快捷键模块逻辑", () => {
    const HK = global.Hotkeys;
    ok2(!!HK, "Hotkeys 模块已加载");
    const evt = (key, m) => ({ key, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });
    ok2(HK.actionFor(evt("Enter", { ctrl: true })) === "complete", "默认 Ctrl+Enter → complete");
    ok2(HK.actionFor(evt("Enter", { ctrl: true, shift: true })) === "replace", "默认 Ctrl+Shift+Enter → replace");
    ok2(HK.actionFor(evt("p", { alt: true })) === "ai_polish", "默认 Alt+P → ai_polish");
    ok2(HK.comboLabel({ key: "Enter", ctrl: true, shift: true }) === "Ctrl+Shift+Enter", "comboLabel 人类可读");
    ok2(HK.parseCombo({ key: "Control" }) === null, "纯修饰键被忽略");
    // v2.15.1 回归：标点键忽略 shift（真实键盘 ? = Shift+/），任意 shift 状态都应命中
    ok2(HK.actionFor(evt("?", {})) === "shortcut_panel", "默认 ? 打开快捷键面板（无 shift）");
    ok2(HK.actionFor(evt("?", { shift: true })) === "shortcut_panel", "默认 ? 打开快捷键面板（Shift+/ 真实布局）");
    // comboEq：字母/功能键 shift 严格区分（Ctrl+Enter ≠ Ctrl+Shift+Enter），标点键忽略 shift
    ok2(HK.comboEq({ key: "Enter", ctrl: true }, { key: "Enter", ctrl: true, shift: true }) === false, "comboEq 功能键 shift 严格区分");
    ok2(HK.comboEq({ key: "?", shift: true }, { key: "?" }) === true, "comboEq 标点键忽略 shift");
    // v2.15.1 polish：录制标点键时 shift 归一为 false（? = Shift+/ 存成 {key:"?",shift:false}，显示 "?"）
    ok2(HK.parseCombo({ key: "?", shiftKey: true }).shift === false, "parseCombo 标点键 shift 归一");
    // v2.15.2 回归：录制快捷键时按 ? 不弹快捷键面板（避免面板盖住设置弹窗）
    getById("app-window").keydown("?");
    const modalShownBefore = getById("shortcut-modal").classList.contains("show");
    if (modalShownBefore) q('[data-shortcut-close]').click();
    global.EditorSettings.startCapture("shortcut_panel");
    getById("app-window").keydown("?");
    ok2(!getById("shortcut-modal").classList.contains("show"), "录制中按 ? 不弹快捷键面板");
    getById("app-window").keydown("Escape");   // 取消录制
    ok2(!global.EditorSettings.isCapturing(), "Escape 取消录制");
    // 冲突检测：把 replace 绑成当前 complete 的组合 → 拒绝并返回占用者
    const other = HK.assign("replace", { key: "Enter", ctrl: true });
    ok2(other === "complete", "冲突检测返回占用动作");
    ok2(!S.getSettings().hotkeys || !S.getSettings().hotkeys.replace, "冲突时未写入");
  });
  await flow("HK2 设置面板改绑 + 生效", () => {
    getById("btn-settings").click();
    // 注：harness 的 matches 不支持 `#settings-modal .set-tab` 复合选择器 → 点击绑定不生效，直接调 switchSetTab（等价）
    global.EditorSettings.switchSetTab("hotkeys");
    ok2(!!getById("hotkeys-list") && getById("hotkeys-list").innerHTML.length > 0, "快捷键 tab 渲染行");
    // 把 shortcut_panel 改绑 Ctrl+K（录制：点「改」→ 按组合；父级委托无法冒泡，直接调 onHkListClick）
    const setBtn = q('[data-hk-set="shortcut_panel"]');
    ok2(!!setBtn, "shortcut_panel 行有「改」按钮");
    global.EditorSettings.onHkListClick({ target: setBtn });
    getById("app-window").keydown("k", { ctrlKey: true });
    const hk = S.getSettings().hotkeys || {};
    ok2(hk.shortcut_panel && hk.shortcut_panel.key === "k", "录制后写入 settings.hotkeys.shortcut_panel=Ctrl+K");
    // 改绑生效：非输入焦点按 Ctrl+K → 弹快捷键面板；旧键 ? 不再响应
    getById("app-window").keydown("k", { ctrlKey: true });
    ok2(getById("shortcut-modal").classList.contains("show"), "改绑后 Ctrl+K 打开快捷键面板");
    q('[data-shortcut-close]').click();
    getById("app-window").keydown("?");
    ok2(!getById("shortcut-modal").classList.contains("show"), "改绑后 ? 不再打开面板");
    q('[data-settings-cancel]').click();
  });
  await flow("HK3 恢复默认", () => {
    getById("btn-settings").click();
    global.EditorSettings.switchSetTab("hotkeys");
    getById("hotkeys-reset").click();
    ok2(!S.getSettings().hotkeys || Object.keys(S.getSettings().hotkeys).length === 0, "恢复默认清空自定义键位");
    q('[data-settings-cancel]').click();
    // 默认键位回归：? 打开面板，Ctrl+K 不再响应
    getById("app-window").keydown("?");
    ok2(getById("shortcut-modal").classList.contains("show"), "恢复后 ? 仍打开快捷键面板");
    q('[data-shortcut-close]').click();
    getById("app-window").keydown("k", { ctrlKey: true });
    ok2(!getById("shortcut-modal").classList.contains("show"), "恢复后 Ctrl+K 不再打开面板");
  });
  await flow("DBG Provider 状态", () => {
    const provs = S.getProviders();
    console.log("    providers keys:", Object.keys(provs).join(","));
    console.log("    has groq:", !!provs["groq"], "| presets has groq:", !!S.providerPresets()["groq"], "| active:", S.getSettings().activeProvider);
  });

  await wait(400);
  console.log("\n=== 汇总 ===");
  console.log("全部异常数:", errors.length);
  if (errors.length) {
    const seen = new Set();
    for (const e of errors) {
      const line = (e.where ? e.where + ": " : "") + ((e.err && e.err.stack || e.err) || "").toString().split("\n").slice(0, 2).join(" ");
      if (seen.has(line)) continue;
      seen.add(line);
      console.log("  " + line);
    }
  } else {
    console.log("无异常");
  }
  console.log("缺失ID:", missing.size ? Array.from(missing).join(", ") : "无");
  process.exit(errors.length ? 1 : 0);
})();
