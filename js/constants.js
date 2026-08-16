"use strict";
/* constants.js — 跨模块时间/数量常量（消除魔法数字）。 */

const C = {
  SAVE_DELAY: 500,          // 定稿自动保存防抖（ms）
  LINT_DELAY: 300,          // 反AI扫描防抖（ms）
  LINT_DELAY_LONG: 1500,    // 超长草稿降频（ms）
  SEL_TOOL_DEBOUNCE: 150,   // 选区工具条弹出防抖（ms）
  SUGGEST_DEBOUNCE: 150,    // 搜索/素材台防抖（ms）
  PAUSE_SUGGEST: 1200,      // 停顿自动补全（ms）
  TOAST_MS: 2500            // toast 停留（ms）
};

if (typeof window !== "undefined") window.C = C;
if (typeof globalThis !== "undefined") globalThis.C = C;
if (typeof module !== "undefined" && module.exports) module.exports = C;
