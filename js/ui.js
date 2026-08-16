"use strict";
/* ui.js — 通用弹窗工具：modal 开关 / 三选 choice。供 loremanager / bankmanager / editor 复用。 */

window.UI = (function () {

  function open(id) { const m = document.getElementById(id); if (m) m.classList.add("show"); }
  function close(id) { const m = document.getElementById(id); if (m) m.classList.remove("show"); }
  function isOpen(id) { const m = document.getElementById(id); return !!(m && m.classList.contains("show")); }

  // 三选 / 多选弹窗：需要 #ui-choice-modal（title/msg/actions 由本次填充）
  function choice(opts) {
    const modal = document.getElementById("ui-choice-modal");
    if (!modal) return Promise.resolve(opts.default != null ? opts.default : null);
    const titleEl = document.getElementById("ui-choice-title");
    const msgEl = document.getElementById("ui-choice-msg");
    const actEl = document.getElementById("ui-choice-actions");
    if (titleEl) titleEl.textContent = opts.title || "选择";
    if (msgEl) msgEl.textContent = opts.msg || "";
    if (actEl) {
      const list = opts.options || [];
      actEl.innerHTML = list.map((o, i) =>
        '<button type="button" class="' + (i === list.length - 1 ? "main-btn" : "sec-btn") + '" data-choice-val="' + U.esc(String(o.value)) + '">' + U.esc(o.label) + '</button>'
      ).join("");
    }
    modal.classList.add("show");
    return new Promise(resolve => {
      const h = (e) => {
        const b = e.target.closest("[data-choice-val]");
        if (!b) return;
        document.removeEventListener("click", h);
        modal.classList.remove("show");
        resolve(b.getAttribute("data-choice-val"));
      };
      document.addEventListener("click", h);
      const mask = modal.querySelector(".ui-choice-mask");
      if (mask) {
        mask.onclick = () => {
          document.removeEventListener("click", h);
          modal.classList.remove("show");
          resolve(opts.default != null ? opts.default : null);
        };
      }
    });
  }

  return { open, close, isOpen, choice };
})();

if (typeof globalThis !== "undefined") globalThis.UI = window.UI;
if (typeof module !== "undefined" && module.exports) module.exports = window.UI;
