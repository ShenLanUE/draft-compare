"use strict";
/* editor-settings.js — 设置面板 / Provider 管理 / 自定义 Agent 管理。
   从 editor.js 拆出，复用 Editor._ 内部桥（renderAiMenuModels/renderAiTasks/applyEditorFont/scheduleLint/setAutoSuggest）。 */

const EditorSettings = (function () {
  const el = (id) => document.getElementById(id);
  const esc = U.esc;
  const toast = U.toast;
  const core = () => (typeof globalThis !== "undefined" && globalThis.Editor && Editor._) || null;

  let setDirty = false;
  let uiProvId = null;    // 表单当前编辑的 provider id；base/model/key/stream 仅"保存"落盘
  let provManageTab = ""; // "" 列表 | "preset" 预设 | "new" 新建

  function currentProvId() {
    return uiProvId || Store.activeProviderId();
  }

  function openSettings(tab) {
    setDirty = false;
    uiProvId = Store.activeProviderId();
    loadSettingsUI();
    switchSetTab(typeof tab === "string" ? tab : "svc");
    el("settings-modal").classList.add("show");
  }
  function closeSettings() {
    // UX-10：有未保存改动时关闭弹窗给确认（覆盖 取消按钮 / mask 点击 两条路径）
    if (setDirty && !confirm("有未保存的改动，确定关闭？")) return;
    setDirty = false;
    el("settings-modal").classList.remove("show");
  }
  function markDirty() { setDirty = true; }

  // 设置面板 tab 切换（AI 服务 / 写作 Agent / 检查与通用 / 快捷键）
  function switchSetTab(tab) {
    document.querySelectorAll("#settings-modal .set-tab").forEach(b => {
      b.classList.toggle("active", b.getAttribute("data-set-tab") === tab);
    });
    document.querySelectorAll("#settings-modal .set-pane").forEach(p => {
      p.classList.toggle("show", p.getAttribute("data-set-pane") === tab);
    });
    if (tab === "hotkeys") renderHotkeys();
  }

  /* ================= 快捷键设置（用户可自定义，即时保存） ================= */

  let hkCapturing = null;   // 正在录制的新键位动作 id
  function renderHotkeys() {
    const list = el("hotkeys-list");
    if (!list) return;
    const cap = hkCapturing;
    list.innerHTML = Hotkeys.ACTIONS.map(a => {
      const c = Hotkeys.get(a.id);
      const label = Hotkeys.comboLabel(c);
      const scope = a.scope === "editor" ? "编辑器" : "全局";
      const cell = cap === a.id
        ? '<td class="hk-cap" colspan="2">按新组合键…（Esc 取消）</td>'
        : '<td class="hk-combo">' + esc(label) + '</td>' +
          '<td class="hk-acts">' +
            '<button type="button" class="sec-btn" data-hk-set="' + a.id + '">改</button>' +
            (c ? '<button type="button" class="sec-btn" data-hk-clear="' + a.id + '" title="禁用该快捷键">清除</button>' : "") +
          '</td>';
      return '<tr data-hk-action="' + a.id + '">' +
        '<td class="hk-name">' + esc(a.label) + '</td>' +
        '<td class="hk-scope">' + scope + '</td>' + cell + '</tr>';
    }).join("");
  }
  function startCapture(action) { hkCapturing = action; renderHotkeys(); }
  function cancelCapture() { hkCapturing = null; renderHotkeys(); }
  // 录制：document 级 keydown（editor.js bind 注册）；捕获新组合 → 冲突检测 → 即时写入
  function hkKeydown(e) {
    if (!hkCapturing) return;
    if (e.key === "Escape") { e.preventDefault(); cancelCapture(); return; }
    const combo = Hotkeys.parseCombo(e);
    if (!combo) return;   // 纯修饰键忽略
    e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    const act = hkCapturing;
    const other = Hotkeys.assign(act, combo);
    if (other) {
      const hit = Hotkeys.ACTIONS.find(a => a.id === other);
      toast("快捷键冲突：「" + (hit && hit.label || other) + "」已占用该组合");
    } else {
      toast("已设置：" + Hotkeys.comboLabel(combo));
    }
    hkCapturing = null;
    renderHotkeys();
  }
  function onHkListClick(e) {
    const set = e.target.closest("[data-hk-set]");
    if (set) { startCapture(set.getAttribute("data-hk-set")); return; }
    const clr = e.target.closest("[data-hk-clear]");
    if (clr) { Hotkeys.assign(clr.getAttribute("data-hk-clear"), null); renderHotkeys(); }
  }
  function hkResetAll() {
    if (confirm("恢复全部快捷键为默认？")) { Hotkeys.resetAll(); renderHotkeys(); toast("快捷键已恢复默认"); }
  }

  function loadSettingsUI() {
    const s = Store.getSettings();
    el("set-autosuggest").checked = !!s.autoSuggest;
    const hk = el("set-ai-hotkeys");
    if (hk) hk.checked = s.aiHotkeys !== false;
    const fsz = el("set-editor-font");
    if (fsz) fsz.value = (parseFloat(s.editorFontSize) > 0 ? s.editorFontSize : 13.5);
    const cl = el("set-ctxlimit");
    if (cl) cl.value = s.ctxLimit || 0;
    const ls = el("set-libsegs");
    if (ls) ls.value = (s.libSegs == null ? 4 : s.libSegs);
    el("set-llm").checked = !!s.llmEnabled;
    const id = currentProvId();
    const provs = Store.getProviders();
    const defaultPid = Store.activeProviderId();
    const sel = el("set-provider");
    if (sel) {
      sel.innerHTML = Object.keys(provs).map(pid => {
        const p = provs[pid];
        return '<option value="' + esc(pid) + '"' + (pid === id ? " selected" : "") + '>' +
          esc(p.name || pid) + (pid === defaultPid ? "（默认）" : "") + '</option>';
      }).join("");
    }
    const p = provs[id] || {};
    const typeLabel = el("set-type-label");
    if (typeLabel) typeLabel.textContent = p.type === "anthropic" ? "Anthropic" : "OpenAI 兼容";
    el("set-base").value = p.base || "";
    const sm = el("set-model");
    if (sm) ModelPicker.fill(sm, { singleProvider: id, selected: id + "||" + Store.activeModel(id) });
    const m = el("set-models");
    if (m) m.value = (p.models && p.models.length ? p.models : (p.model ? [p.model] : [])).join(", ");
    const n = el("set-note");
    if (n) n.value = p.note || "";
    el("set-key").value = Store.getSecret(id);
    el("set-stream").checked = !!p.stream;
    // 占位符随接口类型
    el("set-base").placeholder = p.type === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com/v1";
    el("set-model").placeholder = p.type === "anthropic" ? "claude-sonnet-4-20250514" : "deepseek-chat";
    // Agent 模型（跟随 Agent）：统一分组选择器
    const am = s.agentModels || {};
    const fillAgentSel = (selId, binding) => {
      const rs = el(selId);
      if (!rs) return;
      ModelPicker.fill(rs, { withDefault: true, selected: (binding && binding.providerId) ? binding.providerId + "||" + (binding.model || "") : "" });
    };
    fillAgentSel("agent-model-planner", am.planner);
    fillAgentSel("agent-model-material", am.material);
    fillAgentSel("agent-model-writer", am.writer);
    fillAgentSel("agent-model-reviewer", am.reviewer);
    const mm = el("agent-material-mode");
    if (mm) mm.value = (am.material && am.material.mode === "llm") ? "llm" : "local";
    const rv = el("agent-reviewer-on");
    if (rv) rv.checked = !!(am.reviewer && am.reviewer.enabled);
    renderCustomAgentList();
    // Agent 配置
    const ac = s.agentCfg || {};
    const sn = el("cfg-systemnote");
    if (sn) sn.value = ac.systemNote || "";
    ["polish", "continue", "expand", "rewrite"].forEach(k => {
      const c = el("cfg-note-" + k);
      if (c) c.value = (ac.taskNotes && ac.taskNotes[k]) || "";
    });
    ["usematerial", "uselore", "useprev", "autoresearch"].forEach(k => {
      const c = el("cfg-" + k);
      if (c) c.checked = ac[k] !== false;
    });
    const ct = el("cfg-temperature");
    if (ct) ct.value = (ac.temperature != null ? ac.temperature : 0.7);
    const cm = el("cfg-maxtokens");
    if (cm) cm.value = (ac.maxWriteTokens || 1200);
    ["t1", "t2", "t3", "ctx", "pattern", "freq"].forEach(k => {
      const n = el("rule-" + k);
      if (n) n.checked = (s.llmRules && s.llmRules[k] !== false);
    });
    setDirty = false;
  }

  function currentConfFromUI() {
    return { base: el("set-base").value.trim(), model: el("set-model").value.trim(), key: el("set-key").value.trim() };
  }
  // 临时配置（测试/拉模型用），不落盘
  function confFromUI() {
    const id = currentProvId();
    const p = Store.getProviders()[id] || {};
    return Object.assign({ id, type: p.type || "openai" }, currentConfFromUI());
  }
  function applyConfToSettings(id) {
    const conf = currentConfFromUI();
    const key = conf.key;
    delete conf.key;
    const models = (el("set-models") && el("set-models").value)
      ? el("set-models").value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
      : (conf.model ? [conf.model] : []);
    const note = (el("set-note") && el("set-note").value) || "";
    const provs = Store.getProviders();
    const cur = provs[id] || { id, type: "openai", base: "", model: "", stream: false };
    const patch = { providers: Object.assign({}, provs, {
      [id]: Object.assign({}, cur, { base: conf.base, model: conf.model, models, note, stream: el("set-stream").checked })
    }) };
    Store.updateSettings(patch);
    Store.saveSecret(id, key);
  }
  function rulesFromUI() {
    const rules = {};
    ["t1", "t2", "t3", "ctx", "pattern", "freq"].forEach(k => { rules[k] = el("rule-" + k).checked; });
    return rules;
  }

  function switchProvider(id) {
    if (id === currentProvId()) return;
    if (setDirty && !confirm("切换 Provider 会丢失当前未保存的改动，继续？")) {
      const sel = el("set-provider");
      if (sel) sel.value = currentProvId();
      return;
    }
    uiProvId = id;   // 只表示"正在编辑哪个 Provider"，浏览不改全局默认
    loadSettingsUI();
  }
  function setAsDefault() {
    const id = currentProvId();
    Store.updateSettings({ activeProvider: id });
    // 只刷新下拉的「默认」标记，不重置表单（避免丢失未保存改动）
    const sel = el("set-provider");
    if (sel) {
      const provs = Store.getProviders();
      sel.innerHTML = Object.keys(provs).map(pid => {
        const p = provs[pid];
        return '<option value="' + esc(pid) + '"' + (pid === id ? " selected" : "") + '>' +
          esc(p.name || pid) + (pid === id ? "（默认）" : "") + '</option>';
      }).join("");
    }
    toast("已将 " + ((Store.getProviders()[id] && Store.getProviders()[id].name) || id) + " 设为全局默认");
  }

  function saveSettings() {
    const id = currentProvId();
    applyConfToSettings(id);
    const selModel = (sel) => {
      const v = (el(sel) && el(sel).value) || "";
      return v ? { providerId: v.split("||")[0], model: v.split("||")[1] || "" } : null;
    };
    const agentModels = {
      planner: selModel("agent-model-planner"),
      material: Object.assign({ mode: "local" }, selModel("agent-model-material")),
      writer: selModel("agent-model-writer"),
      reviewer: Object.assign({ enabled: !!(el("agent-reviewer-on") && el("agent-reviewer-on").checked) }, selModel("agent-model-reviewer"))
    };
    const mm = el("agent-material-mode");
    if (mm) agentModels.material.mode = mm.value === "llm" ? "llm" : "local";
    const agentCfg = {
      systemNote: (el("cfg-systemnote") && el("cfg-systemnote").value) || "",
      taskNotes: {
        polish: (el("cfg-note-polish") && el("cfg-note-polish").value) || "",
        continue: (el("cfg-note-continue") && el("cfg-note-continue").value) || "",
        expand: (el("cfg-note-expand") && el("cfg-note-expand").value) || "",
        rewrite: (el("cfg-note-rewrite") && el("cfg-note-rewrite").value) || ""
      },
      useMaterial: !!(el("cfg-usematerial") && el("cfg-usematerial").checked),
      useLore: !!(el("cfg-uselore") && el("cfg-uselore").checked),
      usePrev: !!(el("cfg-useprev") && el("cfg-useprev").checked),
      autoResearch: !!(el("cfg-autoresearch") && el("cfg-autoresearch").checked),
      temperature: parseFloat((el("cfg-temperature") && el("cfg-temperature").value) || "0.7"),
      maxWriteTokens: parseInt((el("cfg-maxtokens") && el("cfg-maxtokens").value) || "1200", 10) || 1200
    };
    const amOld = Object.assign({}, (Store.getSettings().activeModels) || {});
    const defModel = (el("set-model") && el("set-model").value) || "";
    if (defModel) amOld[id] = defModel;
    Store.updateSettings({
      autoSuggest: el("set-autosuggest").checked,
      aiHotkeys: !(el("set-ai-hotkeys") && !el("set-ai-hotkeys").checked),
      editorFontSize: Math.max(10, parseFloat((el("set-editor-font") && el("set-editor-font").value) || "13.5") || 13.5),
      llmEnabled: el("set-llm").checked,
      activeProvider: Store.getSettings().activeProvider,   // 全局默认只在「设为默认」时改
      activeModels: amOld,
      llmRules: rulesFromUI(),
      ctxLimit: Math.max(0, parseInt((el("set-ctxlimit") && el("set-ctxlimit").value) || "0", 10) || 0),
      libSegs: Math.max(0, Math.min(10, parseInt((el("set-libsegs") && el("set-libsegs").value) || "4", 10) || 0)),
      agentModels,
      customAgents: Agent.customAgents(),
      agentCfg
    });
    const c = core();
    if (c && c.setAutoSuggest) c.setAutoSuggest(el("set-autosuggest").checked);
    if (c && c.applyEditorFont) c.applyEditorFont();
    setDirty = false;   // 已保存，避免 closeSettings 再次弹未保存确认
    closeSettings();
    if (c && c.scheduleLint) c.scheduleLint();   // 规则开关立即生效
    if (c && c.renderAiMenuModels) c.renderAiMenuModels();
    if (window.EditorAi && EditorAi.renderAiTasks) EditorAi.renderAiTasks();
    toast("设置已保存");
  }
  function testSettings() {
    const conf = confFromUI();
    if (!conf.base || !conf.key) { toast("请先填写 API Base 和 Key"); return; }
    // 用临时配置测试，不落盘
    LLM.chat([{ role: "user", content: "回复：连接成功" }], null, conf).then(t => {
      toast("连接成功：" + t.slice(0, 40));
    }).catch(err => toast("连接失败：" + err.message));
  }
  function fetchModelList() {
    const conf = confFromUI();
    if (!conf.base || !conf.key) { toast("请先填写 API Base 和 Key"); return; }
    toast("正在拉取模型列表…");
    LLM.fetchModels(null, conf).then(list => {
      if (!list.length) { toast("未拉到模型（接口可能不支持，可手动填写）"); return; }
      // 直接写 provider.models（唯一来源），不再走 llmModels 缓存
      const id = conf.id;
      const provs = Store.getProviders();
      const cur = provs[id] || { id, type: "openai", base: conf.base, model: "", stream: false };
      Store.updateSettings({ providers: Object.assign({}, provs, { [id]: Object.assign({}, cur, { models: list }) }) });
      const m = el("set-models");
      if (m) m.value = list.join(", ");
      const sm = el("set-model");
      if (sm) ModelPicker.fill(sm, { singleProvider: id, selected: id + "||" + Store.activeModel(id) });
      toast("拉到 " + list.length + " 个模型，已填入模型列表（保存后生效）");
    }).catch(err => toast(err.message));
  }

  /* ================= Provider 管理 ================= */

  function setProvTab(t) { provManageTab = t; renderProviderToolbar(); }
  function toggleProvTab(t) { provManageTab = provManageTab === t ? "" : t; renderProviderToolbar(); }

  function openProviderManage() {
    provManageTab = "";
    renderProviderManage();
    el("provider-modal").classList.add("show");
  }
  function closeProviderManage() { el("provider-modal").classList.remove("show"); }

  function renderProviderManage() {
    const body = el("provider-list");
    const provs = Store.getProviders();
    const active = Store.activeProviderId();
    const rows = Object.keys(provs).map(id => {
      const p = provs[id];
      const isActive = id === active;
      return '<div class="prov-row' + (isActive ? " active" : "") + '" title="' + esc(p.base || "未配置 API Base") + '">' +
        '<span class="prov-name" data-prov-name="' + id + '">' + esc(p.name || id) + '</span>' +
        '<span class="prov-type">' + (p.type === "anthropic" ? "Anthropic" : "OpenAI") + '</span>' +
        (isActive ? '<span class="prov-flag">默认</span>' : "") +
        '<span class="prov-acts">' +
          '<button class="m-del" data-prov-act="default" data-prov-id="' + id + '"' + (isActive ? " disabled" : "") + '>设为默认</button>' +
          '<button class="m-del" data-prov-act="rename" data-prov-id="' + id + '">重命名</button>' +
          '<button class="m-del" data-prov-act="dup" data-prov-id="' + id + '">复制</button>' +
          '<button class="m-del danger" data-prov-act="del" data-prov-id="' + id + '">删除</button>' +
        '</span>' +
      '</div>';
    }).join("");
    body.innerHTML = rows || '<div class="p-empty">还没有 Provider</div>';
    const cnt = el("provider-count");
    if (cnt) cnt.textContent = "共 " + Object.keys(provs).length + " 个";
    renderProviderToolbar();
  }

  function renderProviderToolbar() {
    const area = el("provider-extra");
    if (!area) return;
    if (provManageTab === "preset") {
      const have = Store.getProviders();
      const btns = Object.keys(Store.providerPresets()).map(id => {
        const p = Store.providerPresets()[id];
        const added = !!have[id];
        return '<button class="sec-btn preset-btn" data-preset="' + id + '"' + (added ? " disabled" : "") + '>' + esc(p.name) + (added ? "（已添加）" : "") + '</button>';
      }).join("");
      area.innerHTML = '<div class="prov-section"><div class="prov-section-title">添加预设（点击即加入并切换；已添加的置灰）</div><div class="preset-grid">' + btns + '</div></div>';
    } else if (provManageTab === "new") {
      area.innerHTML =
        '<div class="prov-section"><div class="prov-section-title">新建自定义 Provider（type 创建后不可改）</div>' +
        '<div class="prov-new"><input id="prov-new-name" type="text" placeholder="显示名，如 我的中转" maxlength="40">' +
        '<div class="seg" id="prov-new-type"><button data-nt="openai" class="active">OpenAI 兼容</button><button data-nt="anthropic">Anthropic</button></div>' +
        '<button class="main-btn" data-provider-create>创建</button></div></div>';
    } else {
      area.innerHTML = "";
    }
  }

  function createProvider() {
    const name = (el("prov-new-name").value || "").trim() || ("自定义 " + (Object.keys(Store.getProviders()).length + 1));
    const typeBtn = document.querySelector("#prov-new-type button.active");
    const type = typeBtn ? typeBtn.getAttribute("data-nt") : "openai";
    const id = "c" + Date.now().toString(36);
    const provs = Object.assign({}, Store.getProviders(), { [id]: { id, name, type, base: "", model: "", stream: false } });
    Store.updateSettings({ providers: provs });
    el("provider-modal").classList.remove("show");
    uiProvId = id;
    Store.updateSettings({ activeProvider: id });
    loadSettingsUI();
    toast("已创建，填入 Base / Key 后点保存");
  }

  function addPreset(id) {
    const have = Store.getProviders();
    if (have[id]) {
      uiProvId = id;
      Store.updateSettings({ activeProvider: id });
      el("provider-modal").classList.remove("show");
      loadSettingsUI();
      return;
    }
    const p = Store.providerPresets()[id];
    Store.updateSettings({ providers: Object.assign({}, have, { [id]: Object.assign({ id, stream: false }, p) }) });
    uiProvId = id;
    Store.updateSettings({ activeProvider: id });
    el("provider-modal").classList.remove("show");
    loadSettingsUI();
    toast("已添加预设 " + p.name);
  }

  function renameProvider(id) {
    const span = document.querySelector('[data-prov-name="' + id + '"]');
    if (!span) return;
    const input = document.createElement("input");
    input.className = "prov-ren";
    input.value = span.textContent;
    input.maxLength = 40;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const name = input.value.trim();
      if (name) {
        const provs = Store.getProviders();
        const cur = provs[id] || { id, type: "openai", base: "", model: "", stream: false };
        Store.updateSettings({ providers: Object.assign({}, provs, { [id]: Object.assign({}, cur, { name }) }) });
      }
      renderProviderManage();
    };
    const cancel = () => { if (done) return; done = true; renderProviderManage(); };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
  }

  function duplicateProvider(id) {
    const provs = Store.getProviders();
    const src = provs[id];
    if (!src) return;
    const nid = id + "_c" + Date.now().toString(36);
    Store.updateSettings({ providers: Object.assign({}, provs, { [nid]: Object.assign({}, src, { id: nid, name: (src.name || id) + "（副本）" }) }) });
    const key = Store.getSecret(id);
    if (key) Store.saveSecret(nid, key);
    renderProviderManage();
    toast("已复制为 " + (src.name || id) + "（副本）");
  }

  function deleteProvider(id) {
    const provs = Store.getProviders();
    if (Object.keys(provs).length <= 1) { toast("至少保留一个 Provider"); return; }
    if (!confirm("删除 Provider「" + ((provs[id] && provs[id].name) || id) + "」？")) return;
    const next = Object.assign({}, provs);
    delete next[id];
    Store.updateSettings({ providers: next });
    if (Store.activeProviderId() === id) {
      const first = Object.keys(next)[0];
      Store.updateSettings({ activeProvider: first });
      uiProvId = first;
      loadSettingsUI();
    }
    renderProviderManage();
  }

  function setDefaultProvider(id) {
    Store.updateSettings({ activeProvider: id });
    uiProvId = id;
    loadSettingsUI();
    renderProviderManage();
    toast("已设为默认");
  }

  /* ================= 自定义 Agent ================= */

  function renderCustomAgentList() {
    const wrap = el("custom-agent-list");
    if (!wrap) return;
    const list = Agent.customAgents() || [];
    if (!list.length) { wrap.innerHTML = '<div class="p-empty">还没有自定义 Agent，点「＋ 新建」创建一个写手角色。</div>'; return; }
    wrap.innerHTML = list.map(a =>
      '<div class="ca-row">' +
        '<span class="ca-name">' + esc(a.name) + (a.enabled === false ? ' <span class="dim">（停用）</span>' : "") + '</span>' +
        '<span class="ca-mode dim">' + (a.pipeline === false ? "直接写" : "完整管线") + '</span>' +
        '<span class="ca-acts">' +
          '<button type="button" class="m-del" data-agent-edit="' + esc(a.id) + '">编辑</button>' +
          '<button type="button" class="m-del" data-agent-toggle="' + esc(a.id) + '">' + (a.enabled === false ? "启用" : "停用") + '</button>' +
          '<button type="button" class="m-del danger" data-agent-del="' + esc(a.id) + '">删除</button>' +
        '</span>' +
      '</div>').join("");
  }

  function agentEditMode() {
    const w = el("agent-edit-mode");
    const b = w ? w.querySelector(".active") : null;
    return b ? b.getAttribute("data-amode") : "pipeline";
  }
  function openAgentEdit(id) {
    const list = Agent.customAgents() || [];
    const a = id ? list.find(x => x.id === id) : null;
    el("agent-edit-id").value = (a && a.id) || "";
    el("agent-edit-name").value = (a && a.name) || "";
    el("agent-edit-prompt").value = (a && a.systemPrompt) || "";
    const mode = (a && a.pipeline === false) ? "direct" : "pipeline";
    const mw = el("agent-edit-mode");
    if (mw) mw.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.getAttribute("data-amode") === mode));
    el("agent-edit-usematerial").checked = !(a && a.useMaterial === false);
    el("agent-edit-uselore").checked = !(a && a.useLore === false);
    el("agent-edit-useprev").checked = !(a && a.usePrev === false);
    el("agent-edit-enabled").checked = !(a && a.enabled === false);
    const ms = el("agent-edit-model");
    if (ms) {
      ModelPicker.fill(ms, { withDefault: true, selected: (a && a.providerId) ? a.providerId + "||" + (a.model || "") : "" });
    }
    el("agent-edit-temperature").value = (a && a.temperature != null ? a.temperature : 0.7);
    el("agent-edit-maxtokens").value = (a && a.maxTokens) || 1200;
    const delBtn = document.querySelector("[data-agent-del]");
    if (delBtn) delBtn.style.display = a ? "" : "none";
    el("agent-title").textContent = a ? "编辑自定义 Agent" : "新建自定义 Agent";
    el("agent-modal").classList.add("show");
  }
  function saveAgentEdit() {
    const id = el("agent-edit-id").value || ("a" + Date.now().toString(36));
    const name = (el("agent-edit-name").value || "").trim();
    if (!name) { toast("请填写 Agent 名称"); return; }
    const mv = (el("agent-edit-model") && el("agent-edit-model").value) || "";
    const list = (Agent.customAgents() || []).filter(x => x.id !== id);
    list.push({
      id, name,
      systemPrompt: (el("agent-edit-prompt").value || "").trim(),
      useMaterial: el("agent-edit-usematerial").checked,
      useLore: el("agent-edit-uselore").checked,
      usePrev: el("agent-edit-useprev").checked,
      pipeline: agentEditMode() !== "direct",
      providerId: mv ? mv.split("||")[0] : "",
      model: mv ? mv.split("||")[1] || "" : "",
      temperature: Math.max(0, Math.min(1.5, parseFloat(el("agent-edit-temperature").value) || 0.7)),
      maxTokens: parseInt(el("agent-edit-maxtokens").value, 10) || 1200,
      enabled: el("agent-edit-enabled").checked
    });
    Store.updateSettings({ customAgents: list });
    el("agent-modal").classList.remove("show");
    renderCustomAgentList();
    const c = core();
    if (window.EditorAi && EditorAi.renderAiTasks) EditorAi.renderAiTasks();
    toast("自定义 Agent 已保存");
  }
  function deleteAgentEdit(id) {
    if (!confirm("删除这个自定义 Agent？")) return;
    const list = (Agent.customAgents() || []).filter(x => x.id !== id);
    Store.updateSettings({ customAgents: list });
    el("agent-modal").classList.remove("show");
    renderCustomAgentList();
    const c = core();
    if (window.EditorAi && EditorAi.renderAiTasks) EditorAi.renderAiTasks();
    toast("已删除");
  }
  function toggleAgentEnabled(id) {
    const list = (Agent.customAgents() || []).map(x => x.id === id ? Object.assign({}, x, { enabled: x.enabled === false }) : x);
    Store.updateSettings({ customAgents: list });
    renderCustomAgentList();
    const c = core();
    if (window.EditorAi && EditorAi.renderAiTasks) EditorAi.renderAiTasks();
  }

  return {
    openSettings, closeSettings, switchSetTab, markDirty,
    saveSettings, testSettings, fetchModelList,
    switchProvider, setAsDefault,
    openProviderManage, closeProviderManage, renderProviderManage, renderProviderToolbar,
    setProvTab, toggleProvTab,
    createProvider, addPreset, renameProvider, duplicateProvider, deleteProvider, setDefaultProvider,
    openAgentEdit, saveAgentEdit, deleteAgentEdit, toggleAgentEnabled,
    renderCustomAgentList, agentEditMode,
    renderHotkeys, onHkListClick, hkKeydown, hkResetAll,
    startCapture, cancelCapture, isCapturing: () => !!hkCapturing   // 供 editor.js 判断是否正在录制（避免录制时 ? 误弹快捷键面板）
  };
})();

if (typeof window !== "undefined") window.EditorSettings = EditorSettings;
if (typeof globalThis !== "undefined") globalThis.EditorSettings = EditorSettings;
if (typeof module !== "undefined" && module.exports) module.exports = EditorSettings;
