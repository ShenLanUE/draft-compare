"use strict";
/* appstate.js — 跨模块共享数据单例。替换 window.BankData / LibData / LibIndex 可变全局：
   生产者（BankLoader / LibManager）写入并 emit，消费者（agent / loremanager）读 state。 */

const AppState = (function () {
  const bus = () => (typeof globalThis !== "undefined" && globalThis.Bus) || (typeof window !== "undefined" && window.Bus) || null;
  const state = { characters: [], settings: [], chapters: [], index: null };

  return {
    get: () => state,
    setLore(characters, settings) {
      state.characters = characters || [];
      state.settings = settings || [];
      const b = bus();
      if (b) b.emit("lore:changed", state);
    },
    setLibrary(chapters, index) {
      state.chapters = chapters || [];
      state.index = index || null;
      const b = bus();
      if (b) b.emit("lib:changed", state);
    }
  };
})();

if (typeof window !== "undefined") window.AppState = AppState;
if (typeof globalThis !== "undefined") globalThis.AppState = AppState;
if (typeof module !== "undefined" && module.exports) module.exports = AppState;
