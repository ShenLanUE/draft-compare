"use strict";
/* modelpicker.js — 统一分组模型选择器：按 Provider 分组，选项文案 Model（Provider）。
   模型列表唯一来源 provider.models；activeModels 记录各 Provider 记忆的默认模型。 */

const ModelPicker = (function () {

  // 统一走 util.js 的 esc（此前是后置的局部兜底，先 use 后 const 且与 U.esc 重复）
  const esc = (typeof U !== "undefined") ? U.esc : ((s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

  // 某 Provider 的模型列表（唯一来源 provider.models；无则回退 p.model）
  function modelsOf(pid) {
    const p = (Store.getProviders && Store.getProviders()[pid]) || {};
    if (Array.isArray(p.models) && p.models.length) return p.models.slice();
    return p.model ? [p.model] : [];
  }

  // 填充一个 <select>。opts.withDefault=true 时首项「跟随当前」（value=""）。
  // opts.selected 为 "pid||model"（或空=跟随当前）。
  // opts.singleProvider 传 pid 时只列该 Provider 的模型（value=模型名，不分组，用于设置里选默认模型）。
  function fill(sel, opts) {
    opts = opts || {};
    const selected = opts.selected || "";
    const single = opts.singleProvider || "";
    let html = opts.withDefault ? '<option value="">跟随当前</option>' : '';
    const provs = (Store.getProviders && Store.getProviders()) || {};
    for (const id of Object.keys(provs)) {
      if (single && id !== single) continue;
      const p = provs[id];
      const models = modelsOf(id);
      if (!models.length) continue;
      const label = p.name || id;
      const options = models.map(m => {
        const val = single ? m : id + "||" + m;
        const selVal = single ? selected.split("||").pop() : selected;
        return '<option value="' + esc(val) + '"' + (selVal === m ? " selected" : "") + '>' +
          esc(m + (single ? "" : "（" + label + "）")) + '</option>';
      }).join("");
      if (single) html += options;
      else html += '<optgroup label="' + esc(label) + '">' + options + '</optgroup>';
    }
    // 默认模型不在列表时补一项，避免选中态丢失
    if (selected) {
      const selForMatch = single ? selected.split("||").pop() : selected;
      const exists = (sel.innerHTML || "").indexOf('value="' + esc(selForMatch) + '"') >= 0;
      if (!exists && selForMatch) {
        if (single) {
          html += '<option value="' + esc(selForMatch) + '" selected>' + esc(selForMatch) + '</option>';
        } else {
          const sp = selected.split("||");
          const pid = sp[0], m = sp[1];
          const p = provs[pid];
          if (p) html += '<option value="' + esc(selected) + '" selected>' + esc(m + "（" + (p.name || pid) + "）") + '</option>';
        }
      }
    }
    sel.innerHTML = html;
    return sel;
  }

  return { fill, modelsOf };
})();

if (typeof globalThis !== "undefined") globalThis.ModelPicker = ModelPicker;
if (typeof module !== "undefined" && module.exports) module.exports = ModelPicker;
