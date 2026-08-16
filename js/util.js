"use strict";
/* util.js — 公共工具（低层，无业务依赖）。集中 esc/toast/readText/download/copyText/uid，
   避免各模块重复实现（DRY）。 */

const U = (function () {

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function toast(msg) {
    const a = (typeof window !== "undefined" && window.AppBridge) || null;
    if (a && a.toast) a.toast(msg);
    else console.log(msg);
  }

  function readText(f) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsText(f, "utf-8");
    });
  }

  function download(content, name) {
    try {
      const blob = (typeof Blob !== "undefined" && content instanceof Blob) ? content : new Blob([String(content == null ? "" : content)], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      toast("已导出 " + name);   // UX-15：下载完成给界面反馈
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { toast("导出失败"); }
  }

  function copyText(t) {
    const a = (typeof window !== "undefined" && window.AppBridge) || null;
    if (a && a.copyText) { a.copyText(t); return; }
    try { navigator.clipboard.writeText(t); } catch (e) { }
  }

  function uid(prefix) {
    return (prefix || "") + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  }

  return { esc, toast, readText, download, copyText, uid };
})();

if (typeof window !== "undefined") window.U = U;
if (typeof globalThis !== "undefined") globalThis.U = U;
if (typeof module !== "undefined" && module.exports) module.exports = U;
