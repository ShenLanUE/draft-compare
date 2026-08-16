"use strict";
/* bus.js — 极简发布订阅。跨模块事件（lore:changed / lib:changed 等），
   解耦生产者（写状态）与消费者（渲染/读取），避免 window.* 隐式耦合。 */

const Bus = (function () {
  const map = new Map();

  function on(evt, fn) {
    let s = map.get(evt);
    if (!s) { s = new Set(); map.set(evt, s); }
    s.add(fn);
    return () => { s.delete(fn); };
  }
  function off(evt, fn) {
    const s = map.get(evt);
    if (s) s.delete(fn);
  }
  function emit(evt, payload) {
    const s = map.get(evt);
    if (!s) return;
    s.forEach(fn => {
      try { fn(payload); } catch (e) { console.warn("[bus]", evt, e); }
    });
  }
  return { on, off, emit };
})();

if (typeof window !== "undefined") window.Bus = Bus;
if (typeof globalThis !== "undefined") globalThis.Bus = Bus;
if (typeof module !== "undefined" && module.exports) module.exports = Bus;
