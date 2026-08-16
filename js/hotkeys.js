"use strict";
/* hotkeys.js — 用户可自定义快捷键。
   默认键位与历史硬编码一致；用户可在设置「快捷键」面板改写（settings.hotkeys 覆盖），
   绑定为 null 表示禁用。分发由 editor.js / app.js 通过 actionFor(e) 统一走本模块。 */

const Hotkeys = (function () {

  const ACTIONS = [
    { id: "complete", label: "补全候选", scope: "editor" },
    { id: "replace", label: "换一种说法", scope: "editor" },
    { id: "ai_polish", label: "AI 润色", scope: "editor" },
    { id: "ai_expand", label: "AI 扩写", scope: "editor" },
    { id: "ai_rewrite", label: "AI 重写", scope: "editor" },
    { id: "shortcut_panel", label: "快捷键面板", scope: "global" },
    { id: "diff_prev", label: "差异上一处", scope: "global" },
    { id: "diff_next", label: "差异下一处", scope: "global" }
  ];

  const DEFAULT_HOTKEYS = {
    complete: { key: "Enter", ctrl: true },
    replace: { key: "Enter", ctrl: true, shift: true },
    ai_polish: { key: "p", alt: true },
    ai_expand: { key: "e", alt: true },
    ai_rewrite: { key: "r", alt: true },
    shortcut_panel: { key: "?" },
    diff_prev: { key: "ArrowUp", ctrl: true },
    diff_next: { key: "ArrowDown", ctrl: true }
  };

  function settings() { return (typeof Store !== "undefined" && Store.getSettings) ? Store.getSettings() : {}; }
  function savedMap() { return settings().hotkeys || {}; }

  // 规范化一条绑定：{key, ctrl, shift, alt, meta}；非法/空返回 null（= 禁用）
  function normalize(c) {
    if (!c || !c.key) return null;
    return {
      key: String(c.key),
      ctrl: !!c.ctrl, shift: !!c.shift, alt: !!c.alt, meta: !!c.meta
    };
  }
  function get(action) {
    const s = savedMap();
    if (Object.prototype.hasOwnProperty.call(s, action)) return normalize(s[action]);
    return normalize(DEFAULT_HOTKEYS[action]);
  }
  function bindings() {
    const out = {};
    for (const a of ACTIONS) out[a.id] = get(a.id);
    return out;
  }
  // 键位是否等价（不区分大小写，`?` 等符号原样比较）
  function keyEq(a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); }
  // 该键的 shift 是否有语义：字母/数字/空格/方向键/功能键严格区分 shift；
  // 标点符号键（? ! / @ 等）在多数布局下字符本身已编码 shift（如 ? = Shift+/），
  // 若严格比较会因布局不同导致绑定失效（v2.15 回归）→ 此类键忽略 shift 状态
  function isShiftSensitive(key) {
    const k = String(key || "");
    return /^[a-zA-Z0-9 ]$/.test(k) ||
      ["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Home", "End", "PageUp", "PageDown"].indexOf(k) >= 0;
  }
  // 绑定是否等价（matches / conflictOf 共用，避免口径漂移）
  function comboEq(a, b) {
    const A = normalize(a), B = normalize(b);
    if (!A || !B || !keyEq(A.key, B.key)) return false;
    if (A.ctrl !== B.ctrl || A.alt !== B.alt || A.meta !== B.meta) return false;
    if (isShiftSensitive(A.key) && A.shift !== B.shift) return false;
    return true;
  }
  function matches(e, action) {
    const c = get(action);
    if (!c) return false;
    return comboEq({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }, c);
  }
  // 事件命中哪个动作（按 ACTIONS 顺序返回第一个；无命中返回 null）
  function actionFor(e) {
    for (const a of ACTIONS) { if (matches(e, a.id)) return a.id; }
    return null;
  }
  // 是否应忽略的按键（纯修饰键 / Esc）
  function isIgnoredKey(e) {
    return ["Shift", "Control", "Alt", "Meta"].indexOf(e.key) >= 0 || e.key === "Escape";
  }
  // 从键盘事件提取绑定（排除纯修饰键 / Esc；非字母数字符号用小写）。
  // 标点键（? ! / @ 等）字符本身编码 shift 语义（? = Shift+/），录制时把 shift 归一为 false，
  // 与默认键位/显示一致（isShiftSensitive 匹配时本就忽略标点键的 shift）
  function parseCombo(e) {
    if (isIgnoredKey(e)) return null;
    const key = e.key === " " ? "Space" : e.key;
    return normalize({ key: key, ctrl: e.ctrlKey, shift: isShiftSensitive(key) ? e.shiftKey : false, alt: e.altKey, meta: e.metaKey });
  }
  function modLabel(name, on) { return on ? name : ""; }
  function comboLabel(c) {
    const n = normalize(c);
    if (!n) return "（已禁用）";
    const parts = [modLabel("Ctrl", n.ctrl), modLabel("Shift", n.shift), modLabel("Alt", n.alt), modLabel("Meta", n.meta), n.key === "ArrowUp" ? "↑" : n.key === "ArrowDown" ? "↓" : n.key];
    return parts.filter(Boolean).join("+");
  }
  // 冲突检测：该组合是否已被另一个动作占用（返回占用的动作 id，无则 null）
  function conflictOf(action, combo) {
    const c = normalize(combo);
    if (!c) return null;
    for (const a of ACTIONS) {
      if (a.id === action) continue;
      const oc = get(a.id);
      if (oc && comboEq(oc, c)) return a.id;
    }
    return null;
  }
  // 写入绑定（null=禁用）；冲突时返回被占用的动作 id 且不写入
  function assign(action, combo) {
    const c = normalize(combo);
    const other = conflictOf(action, c);
    if (other) return other;
    const s = Object.assign({}, settings());
    const map = Object.assign({}, s.hotkeys || {});
    map[action] = c;   // 显式覆盖（含禁用 null）
    Store.updateSettings({ hotkeys: map });
    return null;
  }
  function reset(action) {
    const s = Object.assign({}, settings());
    const map = Object.assign({}, s.hotkeys || {});
    delete map[action];
    Store.updateSettings({ hotkeys: map });
  }
  function resetAll() {
    const s = Object.assign({}, settings());
    Store.updateSettings({ hotkeys: {} });
  }

  return { ACTIONS, DEFAULT_HOTKEYS, get, bindings, matches, actionFor, parseCombo, comboLabel, isIgnoredKey, conflictOf, assign, reset, resetAll, comboEq, isShiftSensitive };
})();

if (typeof window !== "undefined") window.Hotkeys = Hotkeys;
if (typeof globalThis !== "undefined") globalThis.Hotkeys = Hotkeys;
if (typeof module !== "undefined" && module.exports) module.exports = Hotkeys;
