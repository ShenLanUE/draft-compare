"use strict";
/* editor.js — 定稿区（手写正文 + 建议补全 + 反AI检查 + 素材台 + 常用词句） */

const Editor = (function () {

  const el = id => document.getElementById(id);

  let emotion = "紧张";
  let kind = "";                 // "" | action | expression
  let dataReady = false;
  let dockOpen = true;
  let dockMax = false;
  let materialOn = false;
  let autoSuggestOn = false;     // 句尾自动补全（默认关）
  let problemFilter = "";        // "" | error | warn
  // 语义为"指导语"而非具体替换词的 fix 不参与一键替换（N-05）
  const FIXABLE_GUIDE = /(参考|换成|删减|控制|保留|身体|精简|直接|删除|避免|改写|白描|重写)/;

  /* ---- 候选弹出 ---- */
  let popupMode = "";            // search | emo | replace | complete
  let popupItems = [];
  let popupSel = 0;
  let popupRange = null;         // 插入时的替换范围 {start,end}
  let popupTitle = "";           // 候选弹窗模式标题（换说法等，N-02 区分补全/替换）
  let streamCtrl = null;         // AI 流式 AbortController
  let aiLiveIdx = -1;            // 流式"AI 改写中…"条目下标

  /* ---- 计时器 ---- */
  let saveTimer = null;
  let lintTimer = null;
  let pauseTimer = null;         // 停顿自动补全
  let lastSavedText = null;      // F-08：上次落盘的文本（interval 脏检查用，未变不写盘）

  function ta() { return el("editor-ta"); }

  /* ================= 初始化 ================= */

  function init() {
    bind();
    renderAiMenuModels();
    autoSuggestOn = !!(Store.getSettings().autoSuggest);
    const chk = el("chk-autosuggest");
    if (chk) chk.checked = autoSuggestOn;
    applyUiState();
    applyEditorFont();
    if (window.EditorAi && EditorAi.loadAiHistory) EditorAi.loadAiHistory();
    if (document.body.classList.contains("compact")) materialOn = false;
    Store.loadDraft().then(d => {
      if (d && d.text) {
        ta().value = d.text;
        const c = d.text.replace(/\s/g, "").length;
        toast("已恢复上次草稿（约 " + c + " 字）");
      }
      Store.loadFavs().then(f => { StoreFavsCache = f; Suggest.setFavs(f); refreshFavBtn(); });
      if (dataReady) populateEmotions();
      updateWordCount();
      scheduleLint();
    });
    // 默认打开素材台（紧凑/侧边栏模式除外）：右侧栏目开箱即见；尊重记忆状态
    if (!document.body.classList.contains("compact")) {
      if (materialOn !== false) {
        materialOn = true;
        el("material-panel").hidden = false;
        el("btn-material").classList.add("on");
        refreshMaterial();
      }
    }
    // 首次打开给一条引导
    Store.getMeta("hint-shown").then(v => {
      if (!v) {
        Store.setMeta("hint-shown", 1);
        toast("定稿区：输入 @ 搜词库 · 「补全」弹候选 · 选中文字「换说法」");
      }
    });
    // 首次 AI 引导
    Store.getMeta("hint-ai").then(v => {
      if (!v) {
        Store.setMeta("hint-ai", 1);
        toast("选中文字即弹「润色/扩写/重写」工具条，Alt+P/E/R 也可触发");
      }
    });
    // F-08：定稿区定时自动保存（30s 兜底，配合 input 防抖 + 失焦落盘）；文本未变不重复写盘
    setInterval(() => { if (ta() && ta().value && ta().value !== lastSavedText) saveNow(); }, 30000);
  }

  // 折叠/面板状态的记忆与还原
  function applyUiState() {
    const ui = (Store.getSettings().ui) || {};
    // UX-11：首次使用素材台默认收起（避免挤占编辑空间），之后尊重记忆状态
    materialOn = (ui.materialOn === undefined) ? false : ui.materialOn;
    if (ui.dockOpen === false) { dockOpen = false; el("dock").classList.add("collapsed"); }
    if (ui.dockMax) { dockMax = true; el("dock").classList.add("maxed"); materialOn = true; el("material-panel").hidden = false; }
    if (ui.problemsCollapsed) el("problems-wrap").classList.add("collapsed");
  }
  function setUi(patch) {
    if (!window.Store) return;
    Store.updateSettings({ ui: Object.assign({}, (Store.getSettings().ui) || {}, patch) });
  }
  function applyEditorFont() {
    const fs = parseFloat((Store.getSettings().editorFontSize) || 13.5);
    if (fs > 0) {
      const ed = ta();
      if (ed) ed.style.fontSize = fs + "px";
    }
  }
  // 设置保存后同步「自动补全」开关与定时器（editor-settings 调用）
  function setAutoSuggest(v) {
    autoSuggestOn = !!v;
    const chk = el("chk-autosuggest");
    if (chk) chk.checked = autoSuggestOn;
    if (!autoSuggestOn) clearTimeout(pauseTimer);
  }

  function updateWordCount() {
    const c = el("editor-count");
    if (c) c.textContent = ta().value.replace(/\s/g, "").length + " 字";
  }

  /* ================= 数据接入（app.js 加载完词库后调用） ================= */

  function setData() {
    dataReady = Suggest.hasData();
    populateEmotions();
    // 数据就绪后无条件刷新素材台（修正"先开素材台再等词库"时空白的 bug）
    if (dataReady && materialOn) refreshMaterial();
  }
  function refreshFavBtn() {
    const n = Suggest.getCounts().fav;
    const lb = el("fav-btn-label");
    if (lb) lb.textContent = "常用词句" + (n ? " " + n : "");
  }

  /* ================= 事件绑定 ================= */

  function bind() {
    el("btn-emo").addEventListener("click", e => {
      e.stopPropagation();
      populateEmotions();   // 每次打开重建：让「最近使用」与当前词库同步
      togglePopup(el("emo-pop"));
    });
    document.addEventListener("click", e => {
      if (!e.target.closest(".emo-wrap")) closePopup(el("emo-pop"));
      if (!e.target.closest("#suggest-popup") && !e.target.closest("#editor-ta")) hideSuggest(true);
      if (!e.target.closest("#sel-toolbar") && !e.target.closest("#editor-ta")) hideSelToolbar();
    });
    el("emo-pop").addEventListener("click", e => {
      const it = e.target.closest("[data-emo]");
      if (!it) return;
      const v = it.getAttribute("data-emo");
      emotion = v === "__all__" ? "" : v;
      el("emo-cur").textContent = emotion ? emotion : "全部";
      closePopup(el("emo-pop"));
      refreshMaterial();
      EditorAi.syncAiEmo();
      if (v !== "__all__") rememberEmotion(v);
    });

    document.querySelectorAll("#seg-kind button").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#seg-kind button").forEach(x => x.classList.toggle("active", x === b));
        kind = b.getAttribute("data-kind") || "";
        refreshMaterial();
      });
    });

    // 「补全」按钮：弹「常用词句 + 情绪候选 + 上下文匹配」（stopPropagation 防 document 点外部关闭）
    // mousedown 防夺焦：避免点击夺走 textarea 焦点 → blur 定时器把刚弹出的候选关掉（BUG-002）
    el("btn-suggest").addEventListener("mousedown", e => e.preventDefault());
    el("btn-suggest").addEventListener("click", e => {
      e.stopPropagation();
      if (!dataReady) { toast("词库加载中…"); return; }
      openComplete();
    });
    // 「自动补全」开关
    const chkAuto = el("chk-autosuggest");
    if (chkAuto) {
      chkAuto.checked = autoSuggestOn;
      chkAuto.addEventListener("change", e => {
        autoSuggestOn = e.target.checked;
        Store.updateSettings({ autoSuggest: autoSuggestOn });
        if (!autoSuggestOn) clearTimeout(pauseTimer);
      });
    }

    el("btn-fav").addEventListener("click", openFavModal);
    el("btn-material").addEventListener("click", toggleMaterial);
    // stopPropagation：阻止点击冒泡到 document 的 hideSuggest，否则刚弹出的换说法弹窗立刻被关（与 btn-suggest 同理）
    el("btn-replace").addEventListener("click", e => { e.stopPropagation(); doReplace(); });
    el("btn-ai").addEventListener("click", e => {
      e.stopPropagation();
      renderAiMenuModels();
      EditorAi.toggleAiTab();
    });
    const aiModelSel = el("ai-model-sel");
    if (aiModelSel) aiModelSel.addEventListener("change", e => {
      const v = e.target.value || "";
      if (!v) return;
      const [pid, model] = v.split("||");
      const am = Object.assign({}, (Store.getSettings().activeModels) || {});
      if (model) am[pid] = model;
      Store.updateSettings({ activeProvider: pid, activeModels: am });
      renderAiMenuModels();
      toast("已切换默认模型（未绑定的 Agent 跟随此模型）");
    });
    // AI 写作面板：行为开关 + 温度（写同一 Store.agentCfg，与设置面板同步）
    ["ai-cfg-material", "ai-cfg-lore", "ai-cfg-prev", "ai-cfg-auto"].forEach(id => {
      const c = el(id);
      if (c) c.addEventListener("change", () => EditorAi.syncAiCfgFromUI());
    });
    const aiTemp = el("ai-cfg-temp");
    if (aiTemp) aiTemp.addEventListener("change", () => EditorAi.syncAiCfgFromUI());
    // AI 历史筛选（UX-09）
    const aiHistKw = el("ai-hist-kw");
    if (aiHistKw) aiHistKw.addEventListener("input", () => EditorAi.setHistKw(aiHistKw.value));
    const aiHistType = el("ai-hist-type");
    if (aiHistType) aiHistType.addEventListener("change", () => EditorAi.setHistType(aiHistType.value));
    el("btn-settings").addEventListener("click", () => EditorSettings.openSettings());
    el("btn-send-cmp").addEventListener("click", sendToCompare);
    el("btn-export").addEventListener("click", exportDraft);
    el("btn-copy-draft").addEventListener("click", copyDraft);
    el("btn-editor-collapse").addEventListener("click", toggleDock);
    el("btn-editor-max").addEventListener("click", toggleMax);
    const bm = el("btn-bank-manage"), bh = el("btn-bank-help");
    if (bm) bm.addEventListener("click", () => window.BankManager && BankManager.open());
    if (bh) bh.addEventListener("click", () => window.BankManager && BankManager.openHelp && BankManager.openHelp());

    // 编辑器
    const ed = ta();
    ed.addEventListener("input", onInput);
    ed.addEventListener("keydown", onKeydown);
    ed.addEventListener("scroll", () => { if (popupMode) positionPopup(); positionSelToolbar(); });
    ed.addEventListener("focus", () => { editorFocused = true; });
    ed.addEventListener("blur", () => {
      editorFocused = false;
      saveNow();   // F-08：失焦即落盘，避免刷新丢失
      setTimeout(() => { if (popupMode !== "replace") hideSuggest(true); }, 150);
    });
    // 选区浮动工具条：鼠标/键盘/选区变化后弹出
    ed.addEventListener("mousedown", () => { selMouseDown = true; editorFocused = true; });
    ed.addEventListener("mouseup", () => { selMouseDown = false; scheduleSelToolbar(); });
    ed.addEventListener("keyup", e => {
      if (ta().selectionStart !== ta().selectionEnd) scheduleSelToolbar();
      else hideSelToolbar();
    });
    // selectionchange：覆盖拖动结束在框外 / 双击 / Shift+方向 等所有选区变化
    document.addEventListener("selectionchange", () => {
      if (editorFocused && document.activeElement === ta() && ta().selectionStart !== ta().selectionEnd) scheduleSelToolbar();
    });
    // 兜底：拖选结束时 mouseup 若落在文本框外，也能识别到选区（仅在编辑器聚焦时）
    document.addEventListener("mouseup", e => {
      selMouseDown = false;
      if (editorFocused && !e.target.closest("#sel-toolbar") && ta().selectionStart !== ta().selectionEnd) scheduleSelToolbar();
    });
    // 工具条按钮 mousedown 不夺焦点（保住选区，防 blur 竞态关掉弹层）
    const selBar = el("sel-toolbar");
    if (selBar) selBar.addEventListener("mousedown", e => e.preventDefault());
    const floatCard = el("ai-float");
    if (floatCard) floatCard.addEventListener("mousedown", e => { if (e.target.closest("button") && !e.target.closest("#af-hdr")) e.preventDefault(); });
    // 浮动结果卡：拖动头部
    const afHdr = el("af-hdr");
    if (afHdr) afHdr.addEventListener("mousedown", e => {
      const card = el("ai-float");
      if (!card || !card.classList.contains("on")) return;
      const rect = card.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      const wr = el("editor-wrap").getBoundingClientRect();
      function mv(ev) {
        let l = ev.clientX - wr.left - offX, t = ev.clientY - wr.top - offY;
        l = Math.max(0, Math.min(wr.width - card.offsetWidth, l));
        t = Math.max(0, Math.min(wr.height - card.offsetHeight, t));
        card.style.left = l + "px"; card.style.top = t + "px";
      }
      function up() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
    // 中文输入法组字结束也触发保存/检查/补全（组字中的 input 事件是 isComposing=true 被跳过）
    ed.addEventListener("compositionend", () => {
      scheduleSave();
      scheduleLint();
      updateWordCount();
      handleAtSearch();
      if (popupMode && popupMode !== "search") hideSuggest();
      if (autoSuggestOn && !popupMode) {
        const last = ta().value[ta().selectionStart - 1];
        if (last === "。" || last === "！" || last === "？" || last === "；") maybeAutoSuggest(true);
        schedulePauseSuggest();
      }
    });

    // 问题面板过滤（stopPropagation 防止冒泡触发头部折叠）
    document.querySelectorAll("#prob-filter button").forEach(b => {
      b.addEventListener("click", e => {
        e.stopPropagation();
        document.querySelectorAll("#prob-filter button").forEach(x => x.classList.toggle("active", x === b));
        problemFilter = b.getAttribute("data-pf") || "";
        renderProblems(lastAllDiags);
      });
    });

    // 素材台
    document.querySelectorAll("#mat-tabs button").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#mat-tabs button").forEach(x => x.classList.toggle("active", x === b));
        refreshMaterial();
      });
    });
    // mat-search 输入统一走下方防抖监听（487 行），避免重复渲染
    el("material-body").addEventListener("click", onMaterialClick);

    // 问题面板
    el("problems").addEventListener("click", e => {
      const fx = e.target.closest("[data-problem-fix]");
      if (fx) { applyProblemFix(+fx.getAttribute("data-problem-fix")); return; }
      const it = e.target.closest("[data-diag]");
      if (it) jumpToProblem(+it.getAttribute("data-diag"));
    });
    el("problems-hdr").addEventListener("click", () => {
      el("problems-wrap").classList.toggle("collapsed");
      setUi({ problemsCollapsed: el("problems-wrap").classList.contains("collapsed") });
    });
    // N-05 / F-05：问题面板「全部修复」「导出报告」（stopPropagation 防触发头部折叠）
    const fixAllBtn = el("problems-fix-all"), expBtn = el("problems-export");
    if (fixAllBtn) fixAllBtn.addEventListener("click", e => { e.stopPropagation(); applyAllFixes(); });
    if (expBtn) expBtn.addEventListener("click", e => { e.stopPropagation(); exportProblemsReport(); });

    // 弹窗
    el("fav-mask").addEventListener("click", closeFavModal);
    el("settings-mask").addEventListener("click", () => EditorSettings.closeSettings());
    const shortcutMask = el("shortcut-mask");
    if (shortcutMask) shortcutMask.addEventListener("click", () => el("shortcut-modal").classList.remove("show"));
    // F-03 快捷键面板「快捷键」动作 / Esc 关闭挂 document 级：仅在焦点不在输入类元素时响应，
    // 避免在正文里打半角问号等字符时误触发（绑定可由用户在设置「快捷键」面板自定义）
    document.addEventListener("keydown", e => {
      const sm = el("shortcut-modal");
      if (!sm) return;
      if (e.key === "Escape" && sm.classList.contains("show")) {
        e.preventDefault(); sm.classList.remove("show"); return;
      }
      if (Hotkeys.actionFor(e) === "shortcut_panel") {
        // 录制快捷键中不弹面板（? 常被用来录制，避免面板盖住设置弹窗）
        if (window.EditorSettings && EditorSettings.isCapturing && EditorSettings.isCapturing()) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
        if (!sm.classList.contains("show")) { e.preventDefault(); sm.classList.add("show"); }
      }
    });
    document.addEventListener("click", e => {
      if (e.target.closest("[data-star]")) { toggleStar(e.target.closest("[data-star]").getAttribute("data-star")); return; }
      if (e.target.closest("[data-fav-cancel]")) closeFavModal();
      else if (e.target.closest("[data-shortcut-close]")) { const sm = el("shortcut-modal"); if (sm) sm.classList.remove("show"); }
      else if (e.target.closest("[data-fav-save]")) saveFavs();
      else if (e.target.closest("[data-fav-import]")) el("fav-file").click();
      else if (e.target.closest("[data-settings-cancel]")) EditorSettings.closeSettings();
      else if (e.target.closest("[data-settings-save]")) EditorSettings.saveSettings();
      else if (e.target.closest("[data-settings-test]")) EditorSettings.testSettings();
      else if (e.target.closest("[data-settings-models]")) EditorSettings.fetchModelList();
      else if (e.target.closest("[data-backup-export]")) exportBackupZip();
      else if (e.target.closest("[data-diff-report]")) exportDiffReport();
      else if (e.target.closest("[data-ai-close]")) {
        EditorAi.closeAiTab();
      }
      else if (e.target.closest("[data-ai-ins]")) {
        const b = e.target.closest("[data-ai-ins]");
        const range = b.hasAttribute("data-ai-start") && b.getAttribute("data-ai-start") !== ""
          ? { start: +b.getAttribute("data-ai-start"), end: +b.getAttribute("data-ai-end") }
          : EditorAi.getRange();
        EditorAi.insertVersion(+b.getAttribute("data-ai-ins"), range);
      }
      else if (e.target.closest("[data-ai-ins-all]")) { EditorAi.insertAll(); }
      else if (e.target.closest("[data-af-ins-all]")) { EditorAi.insertAll(); }
      else if (e.target.closest("[data-ai-task]")) {
        EditorAi.openAiTab();
        EditorAi.runAiTask(e.target.closest("[data-ai-task]").getAttribute("data-ai-task"));
      }
      else if (e.target.closest("[data-ai-mat]")) {
        const mm = e.target.closest("[data-ai-mat]");
        const p = mm.nextElementSibling;
        if (p) p.classList.toggle("open");
      }
      else if (e.target.closest("[data-ai-prev]") || e.target.closest("[data-ai-ctx]")) {
        const b = e.target.closest("[data-ai-prev]") || e.target.closest("[data-ai-ctx]");
        const p = b.nextElementSibling;
        if (p) p.classList.toggle("open");
      }
      else if (e.target.closest("[data-ai-prev-off]")) {
        const b = e.target.closest("[data-ai-prev-off]");
        if (window.LibManager && LibManager.toggleActive) LibManager.toggleActive(b.getAttribute("data-ai-prev-off"));
      }
      else if (e.target.closest("[data-ai-copy]")) { EditorAi.copyVersion(+e.target.closest("[data-ai-copy]").getAttribute("data-ai-copy")); }
      else if (e.target.closest("[data-ai-regen]")) { EditorAi.regen(); }
      else if (e.target.closest("[data-ai-del]")) { EditorAi.delAiVersion(+e.target.closest("[data-ai-del]").getAttribute("data-ai-del")); }
      else if (e.target.closest("[data-ai-goto-settings]")) { EditorSettings.openSettings("svc"); }
      else if (e.target.closest("[data-ai-clear-hist]")) { EditorAi.clearAiHistory(); }
      else if (e.target.closest("[data-ai-hist]")) { EditorAi.viewAiHistory(+e.target.closest("[data-ai-hist]").getAttribute("data-ai-hist")); }
      else if (e.target.closest("[data-ai-kwdel]")) { EditorAi.kwDel(+e.target.closest("[data-ai-kwdel]").getAttribute("data-ai-kwdel")); }
      else if (e.target.closest("[data-ai-kwrun]")) { EditorAi.kwRun(); }
      else if (e.target.closest("[data-ai-pin]")) { EditorAi.toggleLibPin(e.target.closest("[data-ai-pin]").getAttribute("data-ai-pin")); }
      else if (e.target.closest("[data-ai-block]")) { EditorAi.toggleLibBlock(e.target.closest("[data-ai-block]").getAttribute("data-ai-block")); }
      else if (e.target.closest("[data-sel-ai]")) {
        EditorAi.runAiFromSelection(e.target.closest("[data-sel-ai]").getAttribute("data-sel-ai"));
      }
      else if (e.target.closest("[data-sel-close]")) { hideSelToolbar(); }
      else if (e.target.closest("[data-af-close]")) { EditorAi.closeFloating(); }
      else if (e.target.closest("[data-af-cancel]")) { EditorAi.cancelFloat(); }
      else if (e.target.closest("[data-af-detail]")) { EditorAi.openDetail(); }
      else if (e.target.closest("[data-af-ins]")) { EditorAi.floatAction("ins", +e.target.closest("[data-af-ins]").getAttribute("data-af-ins")); }
      else if (e.target.closest("[data-af-copy]")) { EditorAi.floatAction("copy", +e.target.closest("[data-af-copy]").getAttribute("data-af-copy")); }
      else if (e.target.closest("[data-af-regen]")) { EditorAi.floatAction("regen", +e.target.closest("[data-af-regen]").getAttribute("data-af-regen")); }
      else if (e.target.closest("[data-af-del]")) { EditorAi.floatAction("del", +e.target.closest("[data-af-del]").getAttribute("data-af-del")); }
      else if (e.target.closest("[data-af-hdr]")) { /* drag handled separately */ }
      else if (e.target.closest("[data-agent-new]")) { EditorSettings.openAgentEdit(""); }
      else if (e.target.closest("[data-agent-edit]")) { EditorSettings.openAgentEdit(e.target.closest("[data-agent-edit]").getAttribute("data-agent-edit")); }
      else if (e.target.closest("[data-agent-del]")) {
        const ab = e.target.closest("[data-agent-del]");
        EditorSettings.deleteAgentEdit(ab.getAttribute("data-agent-del"));
      }
      else if (e.target.closest("[data-agent-toggle]")) { EditorSettings.toggleAgentEnabled(e.target.closest("[data-agent-toggle]").getAttribute("data-agent-toggle")); }
      else if (e.target.closest("[data-agent-save]")) { EditorSettings.saveAgentEdit(); }
      else if (e.target.closest("[data-agent-cancel]") || e.target.closest("[data-agent-mask]")) { el("agent-modal").classList.remove("show"); }
      else if (e.target.closest("[data-amode]")) {
        const ab = e.target.closest("[data-amode]");
        const mw = el("agent-edit-mode");
        if (mw) mw.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === ab));
      }
      else if (e.target.closest("[data-provider-manage]")) { EditorSettings.openProviderManage(); }
      else if (e.target.closest("[data-set-default]")) { EditorSettings.setAsDefault(); }
      else if (e.target.closest("[data-provider-new]")) { EditorSettings.openProviderManage(); EditorSettings.setProvTab("new"); }
      else if (e.target.closest("[data-provider-close]") || e.target.closest("[data-provider-mask]")) { EditorSettings.closeProviderManage(); }
      else if (e.target.closest("[data-provider-create]")) { EditorSettings.createProvider(); }
      else if (e.target.closest("[data-provider-preset]")) { EditorSettings.toggleProvTab("preset"); }
      else if (e.target.closest("[data-preset]")) { EditorSettings.addPreset(e.target.closest("[data-preset]").getAttribute("data-preset")); }
      else if (e.target.closest("[data-prov-act]")) {
        const pa = e.target.closest("[data-prov-act]");
        const pid = pa.getAttribute("data-prov-id");
        const act = pa.getAttribute("data-prov-act");
        if (act === "default") EditorSettings.setDefaultProvider(pid);
        else if (act === "rename") EditorSettings.renameProvider(pid);
        else if (act === "dup") EditorSettings.duplicateProvider(pid);
        else if (act === "del") EditorSettings.deleteProvider(pid);
      }
    });
    const setProvSel = el("set-provider");
    if (setProvSel) setProvSel.addEventListener("change", e => EditorSettings.switchProvider(e.target.value));
    document.addEventListener("click", e => {
      const nt = e.target.closest("#prov-new-type button");
      if (nt) document.querySelectorAll("#prov-new-type button").forEach(b => b.classList.toggle("active", b === nt));
    });
    ["set-base", "set-model", "set-key"].forEach(id => {
      const n = el(id);
      if (n) n.addEventListener("input", () => EditorSettings.markDirty());
    });
    const clIn = el("set-ctxlimit");
    if (clIn) clIn.addEventListener("input", () => EditorSettings.markDirty());
    const lsIn = el("set-libsegs");
    if (lsIn) lsIn.addEventListener("input", () => EditorSettings.markDirty());
    ["set-models", "set-note", "cfg-systemnote", "cfg-note-polish", "cfg-note-continue", "cfg-note-expand", "cfg-note-rewrite", "cfg-temperature", "cfg-maxtokens"].forEach(id => {
      const nn = el(id);
      if (nn) nn.addEventListener("input", () => EditorSettings.markDirty());
    });
    ["agent-model-planner", "agent-model-material", "agent-model-writer", "agent-model-reviewer", "agent-material-mode", "agent-reviewer-on",
      "cfg-usematerial", "cfg-uselore", "cfg-useprev", "cfg-autoresearch"].forEach(id => {
      const nn = el(id);
      if (nn) nn.addEventListener("change", () => EditorSettings.markDirty());
    });
    ["set-stream", "set-llm", "set-autosuggest", "set-model"].forEach(id => {
      const n = el(id);
      if (n) n.addEventListener("change", () => EditorSettings.markDirty());
    });
    document.querySelectorAll("#settings-modal .set-rules input").forEach(n => {
      n.addEventListener("change", () => EditorSettings.markDirty());
    });
    el("fav-file").addEventListener("change", importFavFile);

    // 设置面板 tab
    document.querySelectorAll("#settings-modal .set-tab").forEach(b => {
      b.addEventListener("click", () => EditorSettings.switchSetTab(b.getAttribute("data-set-tab")));
    });
    // 快捷键设置（v2.15：用户可自定义，即时保存）
    const hkList = el("hotkeys-list");
    if (hkList) hkList.addEventListener("click", (e) => EditorSettings.onHkListClick(e));
    const hkReset = el("hotkeys-reset");
    if (hkReset) hkReset.addEventListener("click", () => EditorSettings.hkResetAll());
    document.addEventListener("keydown", (e) => EditorSettings.hkKeydown(e));

    // 素材台搜索防抖
    let matSearchTimer = null;
    el("mat-search").addEventListener("input", () => {
      clearTimeout(matSearchTimer);
      matSearchTimer = setTimeout(() => refreshMaterial(), 150);
    });

    // 分割条
    el("splitter").addEventListener("mousedown", startSplitter);
    el("splitter").addEventListener("dblclick", toggleDock);
  }

  function togglePopup(p) {
    // open 类挂在 .emo-wrap 容器上（CSS: .emo-wrap.open .emo-pop）
    const w = p && p.parentElement ? p.parentElement : p;
    const open = w.classList.contains("open");
    closePopup(el("emo-pop"));
    if (!open) w.classList.add("open");
  }
  function closePopup(p) { if (p && p.parentElement) p.parentElement.classList.remove("open"); }

  /* ================= 草稿保存 ================= */

  function onInput(e) {
    // 组字中也同步保存/检查（更及时），但补全/搜索只在组字结束后触发
    scheduleSave();
    scheduleLint();
    updateWordCount();
    hideSelToolbar();
    if (window.EditorAi && EditorAi.isFloating()) EditorAi.closeFloating();   // 用户手改原文 → 旧结果失效，关闭浮动卡
    if (e.isComposing) return;
    handleAtSearch();
    if (popupMode && popupMode !== "search") hideSuggest();
    // 自动补全：句尾标点立即触发；停顿 1.2s 触发
    if (autoSuggestOn && !popupMode) {
      const last = ta().value[ta().selectionStart - 1];
      if (last === "。" || last === "！" || last === "？" || last === "；") maybeAutoSuggest(true);
      schedulePauseSuggest();
    }
  }

  function schedulePauseSuggest() {
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => maybeAutoSuggest(false), C.PAUSE_SUGGEST);
  }

  function maybeAutoSuggest(force) {
    if (!autoSuggestOn) return;
    if (popupMode) return;
    if (atQuery()) return;                 // @ 搜索激活中不干扰
    const ed = ta();
    const caret = ed.selectionStart;
    const v = ed.value;
    const before = v.slice(0, caret).trim();
    if (!before) return;
    if (!force) {
      // 停顿触发：光标在文末（之后无内容）即可，不要求句尾标点（更接近 IDE）
      if (v.slice(caret).trim()) return;
    }
    openComplete();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { lastSavedText = ta().value; Store.saveDraft(ta().value); }, C.SAVE_DELAY);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    lastSavedText = ta().value;
    Store.saveDraft(ta().value);
  }

  /* ================= 光标坐标 ================= */

  // 镜像 div 的 CSS（与编辑器逐属性一致，保证光标测量准确）；caretCoords / caretCoordsAt 共用
  function mirrorCss(ed, cs) {
    return [
      "position:absolute", "visibility:hidden", "left:-9999px", "top:0", "z-index:-1",
      "white-space:pre-wrap", "word-wrap:break-word", "overflow-wrap:break-word",
      "font:" + cs.font, "font-size:" + cs.fontSize, "line-height:" + cs.lineHeight,
      "letter-spacing:" + cs.letterSpacing, "padding:" + cs.padding, "border:" + cs.border,
      "box-sizing:border-box", "width:" + ed.clientWidth + "px"
    ].join(";");
  }
  function caretCoords() {
    const ed = ta();
    const cs = getComputedStyle(ed);
    const mirror = el("caret-mirror");
    mirror.style.cssText = mirrorCss(ed, cs);
    mirror.textContent = ed.value.slice(0, ed.selectionStart);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    const mr = marker.getBoundingClientRect();
    const tr = ed.getBoundingClientRect();
    marker.remove();
    // 减去滚动偏移：光标视觉位置随滚动上移
    return { x: mr.left - tr.left, y: mr.top - tr.top - ed.scrollTop };
  }
  // 在指定 index 测坐标、返回 #editor-wrap 相对坐标；完全不改动 ed.selection（避免打断框选/触发 selectionchange 循环）
  function caretCoordsAt(index) {
    const ed = ta();
    const idx = (index == null) ? ed.selectionStart : index;
    const cs = getComputedStyle(ed);
    const mirror = el("caret-mirror");
    mirror.style.cssText = mirrorCss(ed, cs);
    mirror.textContent = ed.value.slice(0, idx);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    const mr = marker.getBoundingClientRect();
    const wr = el("editor-wrap").getBoundingClientRect();
    marker.remove();
    return { x: mr.left - wr.left, y: mr.top - wr.top - ed.scrollTop };
  }
  function lineHeightPx() {
    const lh = getComputedStyle(ta()).lineHeight;
    const v = parseFloat(lh);
    if (v) return v;
    return parseFloat(getComputedStyle(ta()).fontSize) * 1.5;
  }
  function positionPopup() {
    const p = el("suggest-popup");
    if (p.hidden) return;
    const wr = el("editor-wrap");
    const c = caretCoordsAt();
    const lh = lineHeightPx();
    const ph = p.offsetHeight || 320;
    let top = c.y + lh;
    // 下方放不下就放到光标上方（防止被定稿区底部裁掉）
    if (top + ph > wr.clientHeight - 4 && c.y - ph - 6 > 0) top = c.y - ph - 6;
    p.style.left = Math.max(0, c.x - 10) + "px";
    p.style.top = Math.max(0, top) + "px";
  }

  /* ================= 候选弹出 ================= */

  function hideSuggest(removeAnchor) {
    const p = el("suggest-popup");
    p.hidden = true;
    if (streamCtrl) { streamCtrl.abort(); streamCtrl = null; aiLiveIdx = -1; }
    // 关闭 @ 搜索时顺手删掉 @及其查询词，避免下次输入又自动弹出来"关不掉"
    if (removeAnchor && popupMode === "search" && popupRange) {
      try {
        const ed = ta();
        const start = popupRange.start;
        const end = Math.max(start + 1, popupRange.end);
        if (ed.value[start] === "@") ed.setRangeText("", start, end, "start");
      } catch (e) { }
    }
    popupMode = "";
    popupItems = [];
    popupRange = null;
  }

  function showSuggest(items, mode, range, title) {
    const p = el("suggest-popup");
    popupMode = mode;
    popupItems = items;
    popupSel = 0;
    popupRange = range || null;
    popupTitle = title || "";    // 模式标题（换说法带「替换…」标题，N-02）
    if (!items.length) { hideSuggest(); return; }
    p.hidden = false;
    renderPopup();
    positionPopup();
    p.scrollTop = 0;
  }

  function renderPopup() {
    const p = el("suggest-popup");
    const h = popupItems.slice(0, 40).map((it, i) =>
      '<div class="sug-item' + (i === popupSel ? " sel" : "") + '" data-i="' + i + '">' +
        (it.badge ? '<span class="sug-badge">' + it.badge + '</span>' : "") +
        '<span class="sug-main">' + esc(it.text) + '</span>' +
        (it.sub ? '<span class="sug-sub">' + esc(it.sub) + '</span>' : "") +
      '</div>').join("");
    p.innerHTML =
      (popupTitle ? '<div class="sug-mode">' + esc(popupTitle) + '</div>' : "") +
      '<div class="sug-hint">' + (popupMode === "replace" ? "↑↓ 选择 · Enter 替换 · Esc 关闭" : "↑↓ 选择 · Enter 插入 · Esc 关闭") + '</div>' +
      '<div class="sug-list">' + h + '</div>';
    p.querySelector(".sug-list").addEventListener("mousedown", e => {
      const it = e.target.closest("[data-i]");
      if (it) commit(+it.getAttribute("data-i"));
    });
  }

  function moveSel(d) {
    const n = popupItems.length;
    popupSel = (popupSel + d + n) % n;
    renderPopup();
    const lst = el("suggest-popup").querySelector(".sug-list");
    const cur = lst.querySelector(".sel");
    if (cur && cur.offsetTop + cur.offsetHeight > lst.clientHeight) cur.scrollIntoView({ block: "nearest" });
  }

  function commit(i) {
    if (i == null) i = popupSel;
    const it = popupItems[i];
    if (!it) return;
    if (it.range) insertText(it.payload, it.range);
    else insertText(it.payload, popupRange);
    hideSuggest();
  }

  function insertText(text, range) {
    if (text == null || text === "") return;
    const ed = ta();
    const start = range ? range.start : ed.selectionStart;
    const end = range ? range.end : ed.selectionEnd;
    ed.focus();
    ed.setSelectionRange(start, end);
    // 用 execCommand 保 Ctrl+Z 撤销；失败回退 setRangeText
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { }
    if (!ok) { ed.setRangeText(text, start, end, "end"); ed.dispatchEvent(new Event("input", { bubbles: true })); }
    ed.focus();
    scheduleSave();
    updateWordCount();
    scheduleLint();
  }

  /* ---- 触发：@ 全局搜索 ---- */

  function atQuery() {
    const ed = ta();
    const caret = ed.selectionStart;
    const before = ed.value.slice(0, caret);
    // 只认"行首或前字符非文字"的 @，排除邮箱/提及等（如 a@b.com、@所有人）
    let idx = before.lastIndexOf("@");
    while (idx >= 0) {
      const prev = idx === 0 ? "" : before[idx - 1];
      if (!/[A-Za-z0-9_\u4e00-\u9fa5]/.test(prev)) break;
      idx = before.lastIndexOf("@", idx - 1);
    }
    if (idx === -1) return null;
    const seg = before.slice(idx + 1);
    if (/[\n\r]/.test(seg) || seg.length > 30) return null;
    return { start: idx, end: caret, q: seg };
  }

  function handleAtSearch() {
    const q = atQuery();
    if (q) {
      // 空查询（刚输入 @）不弹任何东西，只等继续打字；@ 保留在文本里
      if (!q.q) { if (popupMode === "search") hideSuggest(); return; }
      const items = searchToItems(Suggest.searchAll(q.q, { limit: 40 }), q.q);
      showSuggest(items, "search", { start: q.start, end: q.end });
    } else if (popupMode === "search") {
      hideSuggest();
    }
  }

  function searchToItems(entries, q) {
    const items = [];
    for (const e of entries) {
      if (e.type === "golden") continue;               // 黄金句不插入，走素材台
      if (e.tag === "fav") {
        items.push({ text: e.word, sub: "我的常用", badge: "常用", payload: e.word });
      } else {
        // 变体（"咽口水 / 咽了咽口水"）拆成可分别插入的选项
        const terms = (e.terms && e.terms.length) ? e.terms : [e.word];
        for (const t of terms) {
          items.push({
            text: t,
            sub: e.gloss || e.example || "",
            badge: Banks.catLabel(e.category),
            payload: t,
            warn: e.antiAI
          });
        }
      }
      if (items.length >= 40) break;
    }
    return items;
  }

  /* ---- 触发：补全（常用词句 + 情绪候选 + 上下文匹配） ---- */

  function openComplete() {
    const items = [];
    const seen = new Set();
    const pushItem = (it) => {
      const k = it.text;
      if (seen.has(k)) return;
      seen.add(k);
      items.push(it);
    };
    // 0) 收藏词条置顶（F-04）
    for (const w of starredWords()) pushItem({ text: w, sub: "我的收藏", badge: "收藏", payload: w });
    // 1) 常用词句（始终显示）
    for (const f of StoreFavsCache || []) pushItem({ text: f, sub: "我的常用", badge: "常用", payload: f });
    // 2) 情绪候选（选「全部」→ 浏览词库兜底）
    const es = emotion ? Suggest.byEmotion(emotion, { type: kind, limit: 20 }) : Suggest.byEmotion("", { limit: 20 });
    for (const e of es) {
      const terms = (e.terms && e.terms.length) ? e.terms : [e.word];
      for (const t of terms) pushItem({ text: t, sub: e.gloss || "", badge: Banks.catLabel(e.category), payload: t, warn: e.antiAI });
    }
    // 3) 句尾上下文匹配：取光标前最后 6 个字搜词库
    const caret = ta().selectionStart;
    const tail = ta().value.slice(Math.max(0, caret - 6), caret).replace(/[\s。！？，,]/g, "");
    if (tail) {
      for (const e of Suggest.searchAll(tail, { limit: 15 })) {
        if (e.type === "golden" || e.tag === "fav") continue;
        const terms = (e.terms && e.terms.length) ? e.terms : [e.word];
        for (const t of terms) pushItem({ text: t, sub: e.gloss || "", badge: Banks.catLabel(e.category), payload: t, warn: e.antiAI });
      }
    }
    showSuggest(items.slice(0, 40), "complete", null);
    if (!items.length) toast("暂无可用词条：可添加「常用词句」或选一个情绪");
  }

  /* ---- 触发：选区换一种说法（本地情绪词 + LLM 整句） ---- */

  const EMOTION_WORDS = ["紧张", "愤怒", "生气", "难过", "伤心", "害怕", "恐惧", "惊讶", "震惊", "开心", "高兴", "尴尬", "羞愧", "后悔", "委屈", "担心", "焦虑", "绝望", "心动", "喜欢", "厌恶", "烦", "气", "痛", "怕", "慌"];

  function doReplace() {
    const ed = ta();
    if (ed.selectionStart === ed.selectionEnd) { toast("先选中要替换的文字"); return; }
    const start = ed.selectionStart, end = ed.selectionEnd;
    const sel = ed.value.slice(start, end);
    const local = buildLocalReplacements(sel, start);
    if (local.hint) toast("正在替换句中『" + local.hint + "』");
    const items = local.items.map(r => ({
      text: r.text, sub: r.sub, badge: r.badge, payload: r.text, range: r.range
    }));
    if (!items.length) toast("没找到合适的替换，试试选中单个情绪词，或开启 AI 改写");
    showSuggest(items, "replace", null, "替换「" + sel + "」为：");   // N-02：与补全弹窗视觉区分
    // LLM 增强（整句改写）
    if (LLM.enabled()) startAiReplace(sel, start, end, local.cands);
  }

  // 本地候选：句中情绪词 → 该情绪的小动作/神态/词汇，只替换句中那个词；无情绪词 → 整段相似匹配
  function buildLocalReplacements(sel, start) {
    let hit = null;
    for (const w of EMOTION_WORDS) {
      const idx = sel.indexOf(w);
      if (idx >= 0) { hit = { word: w, absStart: start + idx, absEnd: start + idx + w.length }; break; }
    }
    const items = [], cands = [];
    if (hit) {
      const es = Suggest.byEmotion(hit.word, { limit: 15 });
      for (const e of es) {
        const terms = (e.terms && e.terms.length) ? e.terms : [e.word];
        for (const t of terms.slice(0, 3)) {
          items.push({ text: t, sub: e.gloss || "", badge: Banks.catLabel(e.category), payload: t, range: { start: hit.absStart, end: hit.absEnd } });
          cands.push(t);
        }
      }
      if (!items.length) {
        for (const r of Suggest.replacements(hit.word, { limit: 6 })) {
          items.push({ text: r.text, sub: r.src || "替换", badge: "替换", payload: r.text, range: { start: hit.absStart, end: hit.absEnd } });
          cands.push(r.text);
        }
      }
    } else {
      for (const r of Suggest.replacements(sel, { limit: 8 })) {
        items.push({ text: r.text, sub: (r.gloss || r.src || "") + (r.example ? " " + r.example.slice(0, 30) : ""), badge: "词库", payload: r.text, range: { start, end: start + sel.length } });
        cands.push(r.text);
      }
    }
    return { items, cands, hint: hit ? hit.word : null };
  }

  // LLM 整句改写：注入上下文+当前情绪+本地素材；流式实时显示
  function startAiReplace(sel, start, end, cands) {
    const before = ta().value.slice(0, start);
    const ctxM = before.match(/([^。！？\n]*[。！？][^。！？\n]*[。！？][^。！？\n]*)$/);
    const context = (ctxM ? ctxM[1] : "") + "【待改写】";
    const stream = !!(LLM.activeProvider() && LLM.activeProvider().stream);
    const ctrl = new AbortController();
    streamCtrl = ctrl;
    const opts = { signal: ctrl.signal };
    if (stream) {
      opts.stream = true;   // 必须传给 rewriteSelection，它据此决定走 streamChat（此前漏设 → 永远非流式 + 数组再 split 错乱）
      aiLiveIdx = popupItems.length;
      popupItems.push({ text: "AI 改写中…", sub: "", badge: "AI", payload: null, range: { start, end }, live: true });
      renderPopup();
      opts.onDelta = (full) => {
        const it = popupItems[aiLiveIdx];
        if (!it) return;
        it.text = full.slice(-600);
        it.sub = full.length + " 字…";
        const node = el("suggest-popup").querySelector('[data-i="' + aiLiveIdx + '"] .sug-main');
        if (node) node.textContent = it.text;
        const sNode = el("suggest-popup").querySelector('[data-i="' + aiLiveIdx + '"] .sug-sub');
        if (sNode) sNode.textContent = it.sub;
      };
      LLM.rewriteSelection(sel, context, emotion, cands, opts)
        .then(full => {
          popupItems.splice(aiLiveIdx, 1);
          // 流式返回 string，非流式返回数组；都兼容
          const vers = Array.isArray(full) ? full : LLM.splitVersions(full);
          let at = aiLiveIdx; aiLiveIdx = -1;
          for (const v of vers) popupItems.splice(at++, 0, { text: v, sub: "AI 整句改写", badge: "AI", payload: v, range: { start, end } });
          renderPopup();
        })
        .catch(err => {
          if (err && err.name === "AbortError") return;   // 用户关闭/取消，不提示
          if (popupItems[aiLiveIdx] && popupItems[aiLiveIdx].live) popupItems.splice(aiLiveIdx, 1);
          aiLiveIdx = -1;
          renderPopup();
          toast("AI 改写失败：" + err.message);
        });
    } else {
      LLM.rewriteSelection(sel, context, emotion, cands, opts)
        .then(vers => {
          for (const v of vers) popupItems.push({ text: v, sub: "AI 整句改写", badge: "AI", payload: v, range: { start, end } });
          renderPopup();
        })
        .catch(err => { if (err && err.name === "AbortError") return; toast("AI 改写失败：" + err.message); });
    }
  }

  /* ---- 键盘 ---- */

  function onKeydown(e) {
    if (e.isComposing) return;
    if (popupMode) {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); hideSuggest(true); }
      return;
    }
    if (e.key === "Escape") {
      if (window.EditorAi && EditorAi.isFloating()) { e.preventDefault(); EditorAi.closeFloating(); return; }
      if (selToolOn) { e.preventDefault(); hideSelToolbar(); return; }
    }
    // 用户可自定义快捷键（hotkeys.js）：仅处理编辑器作用域动作，其余交给 document 级处理
    const act = Hotkeys.actionFor(e);
    if (act === "ai_polish" || act === "ai_expand" || act === "ai_rewrite") {
      if (Store.getSettings().aiHotkeys !== false) {
        e.preventDefault();
        hideSelToolbar();
        const k = { ai_polish: "polish", ai_expand: "expand", ai_rewrite: "rewrite" }[act];
        const ed = ta();
        if (ed.selectionStart !== ed.selectionEnd) EditorAi.runAiFromSelection(k);
        else EditorAi.runAiTask(k);
      }
      return;
    }
    if (act === "complete") { e.preventDefault(); if (dataReady) openComplete(); return; }
    if (act === "replace") { e.preventDefault(); doReplace(); return; }
  }

  /* ================= 反AI检查 ================= */

  function scheduleLint() {
    clearTimeout(lintTimer);
    // 超长草稿降频，避免每 300ms 全量扫描卡顿
    const delay = ta().value.length > 20000 ? C.LINT_DELAY_LONG : C.LINT_DELAY;
    lintTimer = setTimeout(runLint, delay);
  }

  function runLint() {
    if (!dataReady) { renderProblems([], true); return; }
    const diags = Lint.scan(ta().value);
    renderProblems(diags);
  }

  let lastAllDiags = [];
  let lastDiags = [];
  function renderProblems(diags, noData) {
    lastAllDiags = diags || [];
    const list = el("problems");
    const sum = el("problems-sum");
    if (noData) { sum.textContent = "未载入词库"; list.innerHTML = '<div class="p-empty">先载入词库（导入 / 内置）才有反AI检查</div>'; return; }
    // 规则开关 + 面板过滤
    const rules = Store.getSettings().llmRules || {};
    const shown = (diags || []).filter(d => rules[d.cat] !== false && (!problemFilter || d.severity === problemFilter));
    const hiddenN = (diags || []).length - shown.length;
    lastDiags = shown;
    const s = Lint.summary(shown);
    if (!shown.length) { sum.textContent = "✓ 无问题" + (hiddenN ? "（已过滤 " + hiddenN + " 条）" : ""); sum.className = "ok"; }
    else { sum.textContent = (s.err ? "错误 " + s.err + " · " : "") + (s.warn ? "警告 " + s.warn + " · " : "") + "提示 " + s.info + (hiddenN ? " · 已过滤 " + hiddenN + " 条" : ""); sum.className = "has"; }
    const icons = { error: "✗", warn: "!", info: "i" };
    list.innerHTML = shown.map((d, i) =>
      '<div class="p-item ' + d.severity + '" data-diag="' + i + '">' +
        '<span class="p-ic">' + icons[d.severity] + '</span>' +
        '<span class="p-txt">' + d.line + ':' + d.col + ' ' + esc(d.message) + '</span>' +
        (d.fix ? '<span class="p-fix">' + esc(d.fix) + '</span>' : "") +
        (d.cat === "t1" && d.fix && !FIXABLE_GUIDE.test(d.fix) && d.fix.length <= 20
          ? '<button class="m-ins p-fixbtn" data-problem-fix="' + i + '" title="一键替换为「' + esc(d.fix) + '」">替换</button>'
          : "") +
      '</div>').join("") || '<div class="p-empty">没有发现反AI问题</div>';
    el("problems-wrap").classList.toggle("has-problems", shown.length > 0);
  }

  // T1 禁用词一键替换（lint 已给出具体 replacement 的条目）
  function applyProblemFix(i) {
    const d = lastDiags[i];
    if (!d || d.cat !== "t1" || d.fix == null) return;
    const ed = ta();
    if (d.start < 0 || d.end > ed.value.length) { runLint(); return; }
    ed.focus();
    ed.setSelectionRange(d.start, d.end);
    let ok = false;
    try { ok = document.execCommand("insertText", false, d.fix); } catch (e) { }
    if (!ok) { ed.setRangeText(d.fix, d.start, d.end, "end"); ed.dispatchEvent(new Event("input", { bubbles: true })); }
    scheduleSave();
    updateWordCount();
    scheduleLint();
    toast("已替换为「" + d.fix + "」");
  }

  function jumpToProblem(i) {
    const d = lastDiags[i];
    if (!d) return;
    const ed = ta();
    ed.focus();
    // 精确滚动：光标移到问题起点测视觉 Y → 滚到约 1/3 处 → 选中问题词（视觉行定位，长段落换行也准）
    ed.setSelectionRange(d.start, d.start);
    const c = caretCoords();
    ed.scrollTop += (c.y - ed.clientHeight / 3);
    ed.setSelectionRange(d.start, d.end);
    // 选中高亮闪烁
    ed.classList.remove("flash");
    void ed.offsetWidth;
    ed.classList.add("flash");
    setTimeout(() => ed.classList.remove("flash"), 700);
    // 面板当前项高亮 + 滚动到该项
    document.querySelectorAll("#problems .p-item").forEach(x => x.classList.remove("cur"));
    const item = document.querySelector('#problems .p-item[data-diag="' + i + '"]');
    if (item) {
      item.classList.add("cur");
      if (item.scrollIntoView) item.scrollIntoView({ block: "nearest" });
    }
  }

  // N-05：一键修复所有"可自动替换"的 T1 项（按 start 降序替换，offset 不漂移）
  function applyAllFixes() {
    const fixable = lastDiags.filter(d => d.cat === "t1" && d.fix != null && !FIXABLE_GUIDE.test(d.fix) && d.fix.length <= 20);
    if (!fixable.length) { toast("没有可一键替换的项"); return; }
    if (!confirm("按建议一键替换 " + fixable.length + " 处反AI问题？")) return;
    const ed = ta();
    ed.focus();
    const ops = fixable.map(d => ({ start: d.start, end: d.end, fix: d.fix })).sort((a, b) => b.start - a.start);
    let n = 0;
    for (const o of ops) {
      if (o.start < 0 || o.end > ed.value.length || o.end <= o.start) continue;
      try { ed.setSelectionRange(o.start, o.end); } catch (e) { }
      let ok = false;
      try { ok = document.execCommand("insertText", false, o.fix); } catch (e) { }
      if (!ok) { ed.setRangeText(o.fix, o.start, o.end, "end"); ed.dispatchEvent(new Event("input", { bubbles: true })); }
      n++;
    }
    scheduleSave();
    updateWordCount();
    scheduleLint();
    toast("已一键替换 " + n + " 处");
  }

  // F-05：导出本次反AI检查报告 md
  function exportProblemsReport() {
    const diags = lastAllDiags;
    const ed = ta();
    if (!diags.length) { toast("没有可导出的反AI问题"); return; }
    const lines = [
      "# 反AI 检查报告",
      "",
      "> 生成：" + new Date().toLocaleString() + " · 正文约 " + ed.value.replace(/\s/g, "").length + " 字",
      ""
    ];
    for (const d of diags) {
      const snip = String(ed.value.slice(Math.max(0, d.start - 8), d.end + 8) || "").replace(/\s+/g, " ");
      lines.push("- `L" + d.line + ":" + d.col + "` [" + d.severity + "] " + d.message +
        (d.fix ? "（建议：" + d.fix + "）" : "") + " · `…" + snip + "…`");
    }
    U.download(lines.join("\n"), "反AI检查报告-" + new Date().toISOString().slice(0, 10) + ".md");
  }

  /* ================= 情绪选择器 ================= */

  function populateEmotions() {
    const opts = Suggest.emotionOptions();
    if (!opts.length) return;
    // UX-07：情绪选择器加搜索过滤 + 「最近使用」置顶
    const recents = (Store.getSettings().recentEmos || []).filter(e => opts.indexOf(e) >= 0);
    const recentBlock = recents.length
      ? '<div class="emo-group recent"><span class="emo-recent-badge">最近</span>最近使用</div>' + recents.map(e => '<div class="emo-item" data-emo="' + esc(e) + '">' + esc(e) + '</div>').join("")
      : "";
    el("emo-pop").innerHTML =
      '<div class="emo-search"><input type="text" id="emo-filter" placeholder="搜索情绪…" autocomplete="off"></div>' +
      recentBlock +
      '<div class="emo-group">全部情绪</div>' +
      '<div class="emo-item" data-emo="__all__">全部</div>' +
      opts.map(o => '<div class="emo-item" data-emo="' + esc(o) + '">' + esc(o) + '</div>').join("");
    const f = el("emo-filter");
    if (f) f.addEventListener("input", () => {
      const q = f.value.trim();
      el("emo-pop").querySelectorAll(".emo-item").forEach(it => {
        it.hidden = !!(q && it.textContent.indexOf(q) < 0);
      });
    });
  }
  function rememberEmotion(v) {
    const s = Store.getSettings();
    const recents = (s.recentEmos || []).filter(x => x !== v);
    recents.unshift(v);
    if (recents.length > 5) recents.length = 5;
    Store.updateSettings({ recentEmos: recents });
  }

  /* ================= 素材台 ================= */

  function toggleMaterial() {
    materialOn = !materialOn;
    el("material-panel").hidden = !materialOn;
    el("btn-material").classList.toggle("on", materialOn);
    if (materialOn) refreshMaterial();
    setUi({ materialOn: !!materialOn });
  }

  function activeMatTab() {
    const b = document.querySelector("#mat-tabs button.active");
    return b ? b.getAttribute("data-mat") : "browse";
  }

  function refreshMaterial() {
    if (!materialOn) return;
    const body = el("material-body");
    if (!dataReady) { body.innerHTML = '<div class="p-empty">词库加载中…</div>'; return; }
    try {
      renderMaterialTab();
    } catch (e) {
      body.innerHTML = '<div class="p-empty">渲染出错：' + esc(e && e.message || e) + '</div>';
    }
  }

  function renderMaterialTab() {
    const body = el("material-body");
    const tab = activeMatTab();
    const q = el("mat-search").value.trim();
    if (tab === "browse") {
      let items;
      // 显式搜索时按全局搜（和 @ 一致），不受当前情绪筛选影响
      if (q) items = Suggest.searchAll(q, { limit: 60 });
      else items = Suggest.byEmotion(emotion, { type: kind, limit: 80 });
      // 变体（"咽口水 / 咽了咽口水"）拆成可分别插入的词条
      const flat = [];
      for (const e of items) {
        if (e.type === "lexicon" && e.terms && e.terms.length > 1) {
          for (const t of e.terms) flat.push(Object.assign({}, e, { word: t, terms: [t] }));
        } else flat.push(e);
      }
      items = flat;
      if (!items.length) { body.innerHTML = '<div class="p-empty">没有匹配（换情绪或清空筛选）</div>'; return; }
      // F-04：收藏词条置顶（一次性 Set，避免比较器内反复读 settings）
      const starredSet = new Set(starredWords());
      items.sort((a, b) => (starredSet.has(b.word) ? 1 : 0) - (starredSet.has(a.word) ? 1 : 0));
      body.innerHTML = items.map((e, i) => {
        if (e.type === "golden") return "";
        const isFav = e.tag === "fav";
        const main = e.word;
        const gloss = isFav ? "我的常用词句" : (e.gloss || "");
        const extra = (e.example ? '<div class="m-ex">例句：' + esc(e.example) + '</div>' : "") +
                      (e.hint ? '<div class="m-hint">提示：' + esc(e.hint) + '</div>' : "") +
                      (e.antiAI ? '<div class="m-anti">⚠ ' + esc(e.antiAI) + '</div>' : "");
        return '<div class="mat-item" data-ins="' + esc(main) + '">' +
          '<div class="m-head"><b>' + esc(main) + '</b>' +
          '<button class="m-star' + (isStarred(main) ? " on" : "") + '" data-star="' + esc(main) + '" title="收藏/取消收藏">★</button>' +
          '<span class="m-badge">' + (isFav ? "常用" : Banks.catLabel(e.category)) + '</span></div>' +
          (gloss ? '<div class="m-gloss">' + esc(gloss) + '</div>' : "") +
          extra + '<button class="m-ins">插入</button></div>';
      }).join("");
    } else if (tab === "golden") {
      let gs = goldenCache;
      if (q) gs = gs.filter(g => (g.original && g.original.includes(q)) || (g.category && g.category.includes(q)) || Banks.catLabel(g.category).includes(q) || (g.book && g.book.includes(q)));
      goldenShown = gs;
      if (!gs.length) { body.innerHTML = '<div class="p-empty">暂无黄金句（输入关键词可筛选）</div>'; return; }
      const shown = gs.slice(0, 120);
      body.innerHTML = shown.map((g, i) =>
        '<div class="mat-item golden">' +
          '<div class="m-head"><span class="m-badge">' + esc(Banks.catLabel(g.category)) + '</span>' +
          '<button class="m-star' + (isStarred(g.original) ? " on" : "") + '" data-star="' + esc(g.original) + '" title="收藏/取消收藏">★</button>' +
          '<span class="m-book">' + esc(g.book || "") + '</span></div>' +
          '<div class="m-orig">' + esc(g.original) + '</div>' +
          (g.why ? '<div class="m-hint">好在哪里：' + esc(g.why) + '</div>' : "") +
          (g.how ? '<div class="m-hint">怎么用：' + esc(g.how) + '</div>' : "") +
          '<button class="m-copy" data-copy-golden="' + i + '">复制原句</button>' +
        '</div>').join("") +
        (gs.length > 120 ? '<div class="p-empty">仅显示前 120 条，输入关键词筛选更多</div>' : "");
    } else if (tab === "fav") {
      const fs = StoreFavsCache || [];
      body.innerHTML = fs.length ? fs.map((t, i) =>
        '<div class="mat-item fav"><div class="m-head"><b>' + esc(t) + '</b></div>' +
        '<button class="m-ins" data-ins="' + esc(t) + '">插入</button>' +
        '<button class="m-del" data-del-fav="' + i + '">删</button></div>').join("")
        : '<div class="p-empty">还没有常用词句，点「常用词句」按钮添加</div>';
    }
  }

  let goldenCache = [];
  let goldenShown = [];
  let StoreFavsCache = [];

  /* ---- F-04：词库星标收藏 ---- */
  function starredWords() { return (Store.getSettings().starred || []); }
  function isStarred(w) { return starredWords().indexOf(w) >= 0; }
  function toggleStar(word) {
    const cur = starredWords();
    const idx = cur.indexOf(word);
    const next = idx >= 0 ? cur.filter(w => w !== word) : cur.concat([word]);
    Store.updateSettings({ starred: next });
    refreshMaterial();
    toast(idx >= 0 ? "已取消收藏「" + word + "」" : "已收藏「" + word + "」");
  }

  function onMaterialClick(e) {
    const st = e.target.closest("[data-star]");
    if (st) return;   // 星标由 document 委托处理；这里仅挡掉误判成 data-ins 插入
    const ins = e.target.closest("[data-ins]");
    if (ins) { insertText(ins.getAttribute("data-ins")); return; }
    const cp = e.target.closest("[data-copy-golden]");
    if (cp) {
      const g = goldenShown[+cp.getAttribute("data-copy-golden")];
      if (g) copyText(g.original);
      return;
    }
    const del = e.target.closest("[data-del-fav]");
    if (del) {
      const i = +del.getAttribute("data-del-fav");
      const arr = (StoreFavsCache || []).slice();
      arr.splice(i, 1);
      saveFavsArray(arr);
    }
  }

  /* 黄金句数据由 app.js 注入缓存 */
  function setGoldenCache(list) { goldenCache = list || []; }

  /* ================= 常用词句 ================= */

  function openFavModal() {
    el("fav-text").value = (StoreFavsCache || []).join("\n");
    el("fav-modal").classList.add("show");
    setTimeout(() => el("fav-text").focus(), 50);
  }
  function closeFavModal() { el("fav-modal").classList.remove("show"); }

  function saveFavs() {
    const lines = el("fav-text").value.split(/\n+/).map(s => s.trim()).filter(Boolean);
    saveFavsArray(lines);
    closeFavModal();
    toast("常用词句已保存，参与补全");
  }
  function saveFavsArray(arr) {
    StoreFavsCache = arr;
    Store.saveFavs(arr).then(() => { Suggest.setFavs(arr); refreshFavBtn(); refreshMaterial(); });
  }
  function importFavFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const lines = String(r.result).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      saveFavsArray(lines);
      closeFavModal();
      toast("已导入 " + lines.length + " 条常用词句");
    };
    r.readAsText(f, "utf-8");
    e.target.value = "";
  }

  /* ==== 设置面板 / Provider / 自定义 Agent 已拆分至 editor-settings.js ==== */

  // AI 面板顶部：当前默认 Provider·Model 快速切换（统一分组选择器；settings 子模块也复用）
  function renderAiMenuModels() {
    const sel = el("ai-model-sel");
    if (!sel) return;
    const pid = Store.activeProviderId();
    const curModel = Store.activeModel(pid);
    ModelPicker.fill(sel, { selected: pid + "||" + curModel });
  }

  /* ==== AI 面板 / 浮动结果卡 / 历史 已拆分至 editor-ai.js ==== */

  // 取光标前最后一句（去尾标点）
  function lastSentence(s) {
    const m = String(s || "").match(/([^。！？\n]{2,80})[。！？]?\s*$/);
    return m ? m[1].trim() : "";
  }
  // 取光标前最后一段
  function lastParagraph(s) {
    const paras = String(s || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    return paras[paras.length - 1] || "";
  }

  /* ================= 选区浮动工具条（AI 润色主入口） ================= */

  let selToolOn = false;     // 选区浮动工具条是否打开
  let selToolTimer = null;
  let selMouseDown = false;  // 文本框内是否正在按住拖选（拖动中不弹工具条）
  let editorFocused = false; // 定稿编辑器是否获得焦点（避免幽灵弹出）

  function showSelToolbar() {
    try {
      const ed = ta();
      const s0 = ed.selectionStart, s1 = ed.selectionEnd;
      if (s1 <= s0 || popupMode || (window.EditorAi && EditorAi.isFloating()) || el("dock-body").classList.contains("show-ai") || !editorFocused) {
        hideSelToolbar(); return;
      }
      // 正在拖动框选：推迟到松手再弹，避免打断
      if (selMouseDown) { scheduleSelToolbar(); return; }
      const selText = ed.value.slice(s0, s1);
      if (!String(selText).trim()) { hideSelToolbar(); return; }
      const bar = el("sel-toolbar");
      if (!bar) return;
      const cs = caretCoordsAt(s1);
      const wr = el("editor-wrap");
      const lh = lineHeightPx();
      bar.classList.add("on");
      const bw = bar.offsetWidth || 220, bh = bar.offsetHeight || 32;
      let left = Math.max(2, (isFinite(cs.x) ? cs.x : 8) - bw / 2);
      if (left + bw > wr.clientWidth - 4) left = Math.max(2, wr.clientWidth - bw - 4);
      let top = (isFinite(cs.y) ? cs.y : 8) - bh - 8;
      if (top < 2) top = (isFinite(cs.y) ? cs.y : 8) + lh + 6;
      if (top + bh > wr.clientHeight - 4) top = Math.max(2, wr.clientHeight - bh - 4);
      bar.style.left = left + "px";
      bar.style.top = top + "px";
      // AI 未开启：AI 按钮灰显引导
      const aiOn = !!LLM.enabled();
      bar.querySelectorAll("[data-sel-ai]").forEach(b => {
        b.classList.toggle("ai-off", !aiOn && b.getAttribute("data-sel-ai") !== "replace");
        if (!aiOn && b.getAttribute("data-sel-ai") !== "replace") {
          b.title = "AI 未开启：点右上角设置配置";
        }
      });
      const first = bar.querySelector("[data-sel-ai]");
      if (first) first.title = (LLM.enabled() ? "AI 润色（Alt+P）" : "AI 未开启，去设置") + " · 选中 " + (s1 - s0) + " 字";
      selToolOn = true;
    } catch (e) {
      console.warn("[选区工具条] 显示失败：", e);
      hideSelToolbar();
    }
  }
  function hideSelToolbar() {
    selToolOn = false;
    const bar = el("sel-toolbar");
    if (bar) bar.classList.remove("on");
  }
  function positionSelToolbar() {
    if (selToolOn && el("sel-toolbar").classList.contains("on")) showSelToolbar();
  }
  function scheduleSelToolbar() {
    clearTimeout(selToolTimer);
    selToolTimer = setTimeout(showSelToolbar, C.SEL_TOOL_DEBOUNCE);
  }

  /* ================= 定稿区布局 ================= */

  function toggleDock() {
    dockOpen = !dockOpen;
    el("dock").classList.toggle("collapsed", !dockOpen);
    setUi({ dockOpen: !!dockOpen });
  }
  function toggleMax() {
    dockMax = !dockMax;
    el("dock").classList.toggle("maxed", dockMax);
    el("dock").classList.remove("collapsed");
    dockOpen = true;
    if (dockMax) { materialOn = true; el("material-panel").hidden = false; }
    setUi({ dockMax: !!dockMax, dockOpen: true, materialOn: !!materialOn });
  }
  function startSplitter(e) {
    e.preventDefault();
    const dockEl = el("dock");
    if (dockEl.classList.contains("collapsed")) { dockEl.classList.remove("collapsed"); dockOpen = true; }
    const startY = e.clientY;
    const startH = dockEl.offsetHeight;
    function move(ev) {
      const h = startH + (startY - ev.clientY);
      dockEl.style.height = Math.max(120, Math.min(window.innerHeight - 260, h)) + "px";
      dockEl.classList.add("user-h");
    }
    function up() { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  /* ================= 导出 / 复制 / 送对比 ================= */

  function exportDraft() {
    const t = ta().value;
    if (!t.trim()) { toast("定稿区是空的"); return; }
    const blob = new Blob([t], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "定稿.md";
    a.click();
    toast("已导出 定稿.md");
    URL.revokeObjectURL(a.href);
  }
  function copyDraft() {
    const t = ta().value;
    if (!t.trim()) { toast("定稿区是空的"); return; }
    copyText(t);
  }
  // 大纲工作区联动：把文字插入定稿编辑器光标处
  function sendText(text) {
    const ed = ta();
    const caret = ed.selectionStart;
    const v = ed.value;
    const insert = String(text == null ? "" : text) + (v && caret > 0 ? "\n\n" : "");
    ed.focus();
    ed.setSelectionRange(caret, caret);
    let ok = false;
    try { ok = document.execCommand("insertText", false, insert); } catch (e) { }
    if (!ok) { ed.setRangeText(insert, caret, caret, "end"); ed.dispatchEvent(new Event("input", { bubbles: true })); }
    scheduleSave();
    updateWordCount();
  }
  function sendToCompare() {
    const t = ta().value;
    if (!t.trim()) { toast("定稿区是空的"); return; }
    if (typeof AppBridge.addVersion === "function") {
      const vi = AppBridge.addVersion("定稿", t);
      if (vi != null && typeof AppBridge.revealVersion === "function") AppBridge.revealVersion(vi);
      toast("定稿已送入对比区（快照）");
    } else toast("对比区不可用");
  }

  /* ================= 备份导出 / 差异报告 ================= */

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  // 最小 ZIP（Stored 无压缩）实现
  function buildZip(files) {
    const encoder = new TextEncoder();
    const crcTable = (function () {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
      return t;
    })();
    const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const now = new Date();
    const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    const localParts = [], centralParts = [];
    let offset = 0;
    for (const f of files) {
      const data = encoder.encode(f.content);
      const name = encoder.encode(f.name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, dt, true); dv.setUint16(12, dd, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      local.set(name, 30); local.set(data, 30 + name.length);
      localParts.push(local);
      const c = new Uint8Array(46 + name.length);
      const cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dt, true); cv.setUint16(14, dd, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      c.set(name, 46);
      centralParts.push(c);
      offset += local.length;
    }
    const centralSize = centralParts.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    const total = localParts.reduce((s, p) => s + p.length, 0) + centralSize + 22;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of localParts) { out.set(p, o); o += p.length; }
    for (const c of centralParts) { out.set(c, o); o += c.length; }
    out.set(eocd, o);
    return new Blob([out], { type: "application/zip" });
  }
  function exportBackupZip() {
    if (!window.Store || !window.Banks) { toast("存储不可用"); return; }
    toast("正在打包备份…");
    Store.snapshot().then(snap => {
      const S = snap.stores;
      const files = [
        { name: "settings.json", content: JSON.stringify(snap.settings || {}, null, 2) },
        { name: "词库-lexicon.md", content: Banks.serializeLexicon(S.bank) },
        { name: "黄金句-golden.md", content: Banks.serializeGolden(S.golden) },
        { name: "反AI规则-anti.md", content: Banks.serializeAnti(S.anti) },
        { name: "常用词句-fav.txt", content: Banks.serializeFav(S.fav.map(f => f.text)) },
        { name: "角色卡.md", content: Banks.serializeCharacters(S.character) },
        { name: "设定.md", content: Banks.serializeSettings(S.setting) },
        { name: "前文库.md", content: (S.library || []).map(c => "## " + (c.title || "未命名") + "\n\n" + (c.text || "") + "\n").join("\n") },
        { name: "大纲文档.md", content: (S.docs || []).map(d => "## " + (d.name || "未命名") + "\n\n" + (d.text || "") + "\n").join("\n") }
      ];
      downloadBlob(buildZip(files), "稿定备份-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + ".zip");
      toast("备份已导出（不含 API Key）");
    }).catch(e => toast("导出失败：" + ((e && e.message) || e)));
  }
  function exportDiffReport() {
    if (window.AppBridge && AppBridge.exportDiffReport) AppBridge.exportDiffReport();
    else toast("对比区暂无可用数据");
  }

  /* ================= 小工具 ================= */

  const esc = U.esc;
  const toast = U.toast;
  const copyText = U.copyText;

  return {
    init, setData,
    setGoldenCache,
    refreshMaterial,
    saveNow, saveFavsArray, openFavModal,
    sendText,
    getEmotion: () => emotion,
    setEmotion: v => { emotion = v; el("emo-cur").textContent = v; },
    // 内部桥（供 editor-settings / editor-ai 等子模块复用，避免重复定义）
    _: {
      el, esc, toast, copyText, ta,
      renderAiMenuModels,
      applyEditorFont, applyUiState, setUi, setAutoSuggest,
      scheduleLint,
      insertText, hideSuggest, hideSelToolbar,
      showSelToolbar, scheduleSelToolbar, positionSelToolbar,
      caretCoordsAt, lineHeightPx,
      lastSentence, lastParagraph,
      doReplace, getEmotion: () => emotion
    }
  };
})();

window.Editor = Editor;
