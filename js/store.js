"use strict";
/* store.js — IndexedDB 封装 + 设置。
   存：bank 词库条目 / golden 黄金句 / anti 规则 / 常用词句(fav) / 定稿草稿(draft) / 设置(settings) */

const Store = (function () {

  const DB_NAME = "draft-compare-v2";
  const STORES = ["bank", "golden", "anti", "fav", "draft", "meta", "secret", "character", "setting", "library", "docs"];
  // 必需表清单：老版本库里缺新加的表（character/setting/library/docs）时，open() 会自动以更高版本重开补表
  const REQUIRED_STORES = STORES.slice();
  let db = null;
  let secretCache = {};   // { openai: key, anthropic: key }，内存缓存供同步读取

  function createStores(d) {
    if (!d.objectStoreNames.contains("bank")) d.createObjectStore("bank", { keyPath: "id" });
    if (!d.objectStoreNames.contains("golden")) d.createObjectStore("golden", { keyPath: "id" });
    if (!d.objectStoreNames.contains("anti")) d.createObjectStore("anti", { keyPath: "id" });
    if (!d.objectStoreNames.contains("fav")) d.createObjectStore("fav", { keyPath: "id", autoIncrement: true });
    if (!d.objectStoreNames.contains("draft")) d.createObjectStore("draft", { keyPath: "id" });
    if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
    if (!d.objectStoreNames.contains("secret")) d.createObjectStore("secret", { keyPath: "id" });
    if (!d.objectStoreNames.contains("character")) d.createObjectStore("character", { keyPath: "id" });
    if (!d.objectStoreNames.contains("setting")) d.createObjectStore("setting", { keyPath: "id" });
    if (!d.objectStoreNames.contains("library")) d.createObjectStore("library", { keyPath: "id" });
    if (!d.objectStoreNames.contains("docs")) d.createObjectStore("docs", { keyPath: "id" });
  }

  function openAt(version) {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, version);
      req.onupgradeneeded = () => createStores(req.result);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  // 无版本打开：永不高版本降级（IndexedDB 规定只能以更大版本升级，低于当前版本会抛 VersionError）
  function openLatest() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME);
      req.onupgradeneeded = () => createStores(req.result);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function open() {
    if (db) return db;
    let d = await openLatest();
    // 自愈：老库缺新表 → 以「当前版本+1」重开，触发 onupgradeneeded 补表（createStores 幂等，数据保留）
    if (REQUIRED_STORES.some(s => !d.objectStoreNames.contains(s))) {
      const ver = d.version;
      try { d.close(); } catch (e) { }
      d = await openAt(ver + 1);
    }
    db = d;
    return db;
  }

  function tx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  async function all(store) {
    await open();
    return new Promise((res, rej) => {
      const r = tx(store, "readonly").getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  }

  async function putAll(store, items) {
    await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, "readwrite");
      const os = t.objectStore(store);
      items.forEach(it => os.put(it));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }

  async function remove(store, ids) {
    await open();
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = db.transaction(store, "readwrite");
      const os = t.objectStore(store);
      list.forEach(id => os.delete(id));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }

  async function clear(store) {
    await open();
    return new Promise((res, rej) => {
      const r = tx(store, "readwrite").clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }

  async function count(store) {
    await open();
    return new Promise((res, rej) => {
      const r = tx(store, "readonly").count();
      r.onsuccess = () => res(r.result || 0);
      r.onerror = () => rej(r.error);
    });
  }

  async function getMeta(key) {
    await open();
    return new Promise((res, rej) => {
      const r = tx("meta", "readonly").get(key);
      r.onsuccess = () => res(r.result ? r.result.value : null);
      r.onerror = () => rej(r.error);
    });
  }
  async function setMeta(key, value) {
    await open();
    return new Promise((res, rej) => {
      const r = tx("meta", "readwrite").put({ key, value });
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }

  /* ---------- 草稿（定稿区内容） ---------- */

  async function saveDraft(text) {
    return putAll("draft", [{ id: "current", text, ts: Date.now() }]);
  }
  async function loadDraft() {
    const arr = await all("draft");
    return arr.find(d => d.id === "current") || null;
  }

  /* ---------- 常用词句 ---------- */

  async function saveFavs(lines) {
    await open();
    const items = lines.map((t, i) => ({ text: t, ts: Date.now(), idx: i }));
    // 单事务内 clear + put，避免半写
    return new Promise((res, rej) => {
      const t = db.transaction("fav", "readwrite");
      const os = t.objectStore("fav");
      os.clear();
      items.forEach(it => os.put(it));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }
  async function addFav(text) {
    const t = String(text).trim();
    if (!t) return;
    const cur = await all("fav");
    if (cur.some(f => f.text === t)) return;
    return putAll("fav", [{ text: t, ts: Date.now(), idx: cur.length }]);
  }
  async function loadFavs() {
    const arr = await all("fav");
    return arr.sort((a, b) => (a.idx || 0) - (b.idx || 0)).map(f => f.text);
  }

  /* ---------- 密钥（API Key 存 IndexedDB，不进 localStorage） ---------- */

  function getSecret(id) { return secretCache[id] || ""; }
  async function saveSecret(id, key) {
    key = String(key == null ? "" : key);
    secretCache[id] = key;
    await open();
    return new Promise((res, rej) => {
      const r = tx("secret", "readwrite").put({ id, key });
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
  async function loadSecrets() {
    await open();
    return new Promise((res, rej) => {
      const r = tx("secret", "readonly").getAll();
      r.onsuccess = () => {
        secretCache = {};
        for (const it of r.result || []) secretCache[it.id] = it.key || "";
        migrateLegacySecrets();
        res(secretCache);
      };
      r.onerror = () => rej(r.error);
    });
  }
  // 旧版 localStorage 里的 llmOpenAI.key / llmAnthropic.key → 搬到 secret store，并从 settings 剥离
  function migrateLegacySecrets() {
    let raw = null;
    try { raw = localStorage.getItem(LS_SETTINGS); } catch (e) { }
    if (!raw) return;
    let s = null;
    try { s = JSON.parse(raw); } catch (e) { s = null; }
    if (!s) return;
    let dirty = false;
    for (const prov of ["openai", "anthropic"]) {
      const key = prov === "openai" ? "llmOpenAI" : "llmAnthropic";
      const conf = s[key];
      if (conf && conf.key) {
        if (!secretCache[prov]) secretCache[prov] = conf.key;
        delete conf.key;
        dirty = true;
        saveSecret(prov, secretCache[prov]);
      }
    }
    if (dirty) {
      try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (e) { }
    }
  }

  /* ---------- 设置 ---------- */

  const LS_SETTINGS = "draft-compare-settings";
  let settings = null;

  // 内置 Provider 预设（一键添加；OpenAI 兼容 / Anthropic 两种接口类型）
  const PROVIDER_PRESETS = {
    deepseek:    { name: "DeepSeek",    type: "openai",    base: "https://api.deepseek.com/v1",                           model: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"] },
    openai:      { name: "OpenAI",      type: "openai",    base: "https://api.openai.com/v1",                             model: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4o"] },
    anthropic:   { name: "Anthropic",   type: "anthropic", base: "https://api.anthropic.com",                             model: "claude-sonnet-4-20250514", models: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"] },
    qwen:        { name: "通义千问",      type: "openai",    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",    model: "qwen-plus", models: ["qwen-plus", "qwen-turbo"] },
    glm:         { name: "智谱 GLM",     type: "openai",    base: "https://open.bigmodel.cn/api/paas/v4",                 model: "glm-4-flash", models: ["glm-4-flash", "glm-4-plus"] },
    kimi:        { name: "Kimi",        type: "openai",    base: "https://api.moonshot.cn/v1",                           model: "moonshot-v1-8k", models: ["moonshot-v1-8k", "moonshot-v1-32k"] },
    openrouter:  { name: "OpenRouter",  type: "openai",    base: "https://openrouter.ai/api/v1",                         model: "", models: [] },
    siliconflow: { name: "硅基流动",      type: "openai",    base: "https://api.siliconflow.cn/v1",                       model: "Qwen/Qwen2.5-7B-Instruct", models: ["Qwen/Qwen2.5-7B-Instruct"] },
    ollama:      { name: "Ollama",      type: "openai",    base: "http://localhost:11434/v1",                            model: "qwen2.5", models: ["qwen2.5", "llama3.1"] },
    lmstudio:    { name: "LM Studio",   type: "openai",    base: "http://localhost:1234/v1",                             model: "", models: [] },
    groq:        { name: "Groq",        type: "openai",    base: "https://api.groq.com/openai/v1",                      model: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
    ark:         { name: "火山方舟",      type: "openai",    base: "https://ark.cn-beijing.volces.com/api/v3",            model: "doubao-lite-32k", models: ["doubao-lite-32k", "doubao-pro-32k"] }
  };

  // 归一化单个 Provider：保证 models 数组 + note 字符串
  function normalizeProvider(p) {
    if (!p || typeof p !== "object") return p;
    const models = (Array.isArray(p.models) && p.models.length) ? p.models : (p.model ? [p.model] : []);
    return Object.assign({}, p, { models, note: p.note || "" });
  }
  function normalizeProviders(providers) {
    const out = {};
    for (const id of Object.keys(providers || {})) out[id] = normalizeProvider(providers[id]);
    return out;
  }

  function defaultSettings() {
    return {
      llmEnabled: false,
      activeProvider: "deepseek",              // 当前默认 provider id
      activeModels: {},                        // { [providerId]: 该 Provider 记忆的默认模型 }（空=取 models[0]/model）
      providers: seedPresets(),                // { [id]: { id, name, type, base, models, note, stream } }
      agentModels: defaultAgentModels(),       // 各子 Agent 模型绑定（跟随 Agent，Trae 式）
      customAgents: [],                        // 用户自定义 Agent [{id,name,systemPrompt,...}]
      agentCfg: {                              // Agent 配置（全局一份）
        systemNote: "",                        // 追加到基座提示词的写作偏好
        taskNotes: { polish: "", continue: "", expand: "", rewrite: "" },
        useMaterial: true,                     // 检索词句库素材
        useLore: true,                         // 注入角色卡/设定
        usePrev: true,                         // 注入前文情节
        autoResearch: true,                    // 素材不足自动补搜
        temperature: 0.7,
        maxWriteTokens: 1200
      },
      llmRules: { t1: true, t2: true, t3: true, ctx: true, pattern: true, freq: true },
      catLabels: {},                           // 分类显示名覆盖 { slug: 显示名 }
      autoSuggest: false,                      // 句尾自动弹候选（默认关）
      ctxLimit: 0,                             // AI 上下文长度上限（字，0=不限）
      libSegs: 4,                              // 前文检索段数（0=不检索前文）
      libPins: [],                             // 前文命中钉选 [{id,i}]
      libBlocks: [],                           // 前文命中排除 [{id,i}]
      aiHotkeys: true,                         // Alt+P/E/R 快捷键开关
      relIncludeLex: false,                    // 设定 related 搜索是否含词库
      loreCats: [],                            // 设定分类列表（空 = 内置默认 14 类）
      catExtra: {},                            // 分类级自定义模板字段 { [cat]: [{label,type}] }
      editorFontSize: 13.5,                    // 定稿区字号（px）
      starred: [],                             // 词库星标收藏（F-04）
      recentEmos: [],                          // 情绪选择器最近使用（UX-07）
      hotkeys: {},                             // 用户自定义快捷键 { [action]: {key,ctrl,shift,alt,meta} | null }（v2.15）
      ui: { dockOpen: true, dockMax: false, materialOn: true, problemsCollapsed: false, aiTabOpen: false },
      bankMode: "bundled"                      // bundled | custom
    };
  }
  function seedPresets() {
    const p = {};
    for (const id of Object.keys(PROVIDER_PRESETS)) {
      p[id] = normalizeProvider(Object.assign({ id, stream: false }, PROVIDER_PRESETS[id]));
    }
    return p;
  }

  // 子 Agent 模型绑定（跟随 Agent，Trae 式；null = 跟随当前默认）
  function defaultAgentModels() {
    return { planner: null, material: { mode: "local" }, writer: null, reviewer: { enabled: false } };
  }
  function normalizeAgentModels(am) {
    const m = (am && typeof am === "object") ? am : {};
    const norm = (x) => (x && x.providerId) ? { providerId: x.providerId, model: x.model || "" } : null;
    return {
      planner: norm(m.planner),
      material: (m.material && typeof m.material === "object") ? Object.assign({ mode: "local" }, m.material) : { mode: "local" },
      writer: norm(m.writer),
      reviewer: (m.reviewer && typeof m.reviewer === "object") ? Object.assign({ enabled: false }, m.reviewer) : { enabled: false }
    };
  }
  function normalizeCustomAgents(list) {
    if (!Array.isArray(list)) return [];
    return list.map(a => ({
      id: String(a.id || "c" + Math.random().toString(36).slice(2, 8)),
      name: String(a.name || "未命名"),
      systemPrompt: String(a.systemPrompt || ""),
      useMaterial: a.useMaterial !== false,
      useLore: a.useLore !== false,
      usePrev: a.usePrev !== false,
      pipeline: a.pipeline !== false,
      providerId: a.providerId || "",
      model: a.model || "",
      temperature: (a.temperature != null ? a.temperature : 0.7),
      maxTokens: (a.maxTokens || 1200),
      enabled: a.enabled !== false
    })).filter(a => a.name);
  }
  function getSettings() {
    if (settings) return settings;
    try {
      const s = localStorage.getItem(LS_SETTINGS);
      settings = migrateSettings(s ? JSON.parse(s) : {});
    } catch (e) {
      settings = defaultSettings();
    }
    return settings;
  }
  function getProviders() { return getSettings().providers || {}; }
  function activeProviderId() {
    const s = getSettings();
    const keys = Object.keys(s.providers || {});
    return (s.activeProvider && keys.includes(s.activeProvider)) ? s.activeProvider : (keys[0] || "deepseek");
  }
  // 某 Provider 的默认模型：优先 activeModels 记忆，其次 provider.model，再取 models[0]
  function activeModel(pid) {
    pid = pid || activeProviderId();
    const s = getSettings();
    const p = s.providers[pid] || {};
    const models = (Array.isArray(p.models) && p.models.length) ? p.models : (p.model ? [p.model] : []);
    const remembered = (s.activeModels || {})[pid];
    if (remembered && models.includes(remembered)) return remembered;
    if (p.model && models.includes(p.model)) return p.model;
    return models[0] || p.model || "";
  }

  // 旧版（v2.0/2.1：llmProvider/llmOpenAI/llmAnthropic/llmStream）→ provider 注册表
  function migrateSettings(d) {
    if (!d || !d.providers) {
      const providers = seedPresets();
      const legacyOpen = d.llmOpenAI || {};
      const legacyAnth = d.llmAnthropic || {};
      let active = "deepseek";
      const stream = !!d.llmStream;
      if (d.llmProvider === "anthropic") {
        active = "anthropic";
        if (legacyAnth.base || legacyAnth.model) {
          providers.anthropic = { id: "anthropic", name: "Anthropic", type: "anthropic", base: legacyAnth.base || "", model: legacyAnth.model || "", stream };
        }
      } else if (legacyOpen.base || legacyOpen.model) {
        providers.openai = { id: "openai", name: "OpenAI 兼容", type: "openai", base: legacyOpen.base || "", model: legacyOpen.model || "", stream };
        active = "openai";
      } else {
        providers.deepseek.stream = stream;
      }
      let mergedProviders = providers;
      const mergedLlm = mergeLlmModels({ providers, llmModels: d.llmModels });
      if (mergedLlm) mergedProviders = mergedLlm;
      return {
        llmEnabled: !!d.llmEnabled,
        activeProvider: active,
        activeModels: {},
        providers: normalizeProviders(mergedProviders),
        agentModels: normalizeAgentModels(d.agentModels),
        customAgents: normalizeCustomAgents(d.customAgents),
        agentCfg: Object.assign({}, defaultSettings().agentCfg, d.agentCfg || {}),
        llmRules: Object.assign({ t1: true, t2: true, t3: true, ctx: true, pattern: true, freq: true }, d.llmRules || {}),
        catLabels: Object.assign({}, d.catLabels || {}),
        autoSuggest: !!d.autoSuggest,
        ctxLimit: parseInt(d.ctxLimit, 10) > 0 ? parseInt(d.ctxLimit, 10) : 0,
        libSegs: Math.max(0, Math.min(10, parseInt(d.libSegs, 10) || 4)),
        libPins: Array.isArray(d.libPins) ? d.libPins : [],
        libBlocks: Array.isArray(d.libBlocks) ? d.libBlocks : [],
        aiHotkeys: d.aiHotkeys !== false,
        relIncludeLex: !!d.relIncludeLex,
        loreCats: Array.isArray(d.loreCats) ? d.loreCats : [],
        catExtra: (d.catExtra && typeof d.catExtra === "object") ? d.catExtra : {},
        editorFontSize: (parseFloat(d.editorFontSize) > 0) ? parseFloat(d.editorFontSize) : 13.5,
        starred: Array.isArray(d.starred) ? d.starred : [],
        recentEmos: Array.isArray(d.recentEmos) ? d.recentEmos : [],
        hotkeys: (d.hotkeys && typeof d.hotkeys === "object") ? d.hotkeys : {},
        ui: Object.assign({ dockOpen: true, dockMax: false, materialOn: true, problemsCollapsed: false, aiTabOpen: false }, d.ui || {}),
        bankMode: d.bankMode || "bundled"
      };
    }
    // 已是最新结构：补全缺失预设 + 归一化 + 迁移旧字段
    const s = Object.assign(defaultSettings(), d);
    for (const id of Object.keys(PROVIDER_PRESETS)) {
      if (!s.providers[id]) s.providers[id] = normalizeProvider(Object.assign({ id, stream: false }, PROVIDER_PRESETS[id]));
    }
    s.providers = normalizeProviders(s.providers);
    // 旧 activeModel（全局单值）→ activeModels 按 Provider 记忆
    s.activeModels = normalizeActiveModels(s.activeModels);
    if (d.activeModel && s.activeProvider && !s.activeModels[s.activeProvider]) {
      s.activeModels[s.activeProvider] = d.activeModel;
    }
    delete s.activeModel;
    // 旧 llmModels 拉取缓存 → 并入手填/导入的 provider.models（只做一次性迁移）
    const merged = mergeLlmModels(s);
    if (merged) s.providers = merged;
    s.agentModels = normalizeAgentModels(s.agentModels);
    s.customAgents = normalizeCustomAgents(s.customAgents);
    s.agentCfg = Object.assign({}, defaultSettings().agentCfg, s.agentCfg || {});
    s.llmRules = Object.assign({ t1: true, t2: true, t3: true, ctx: true, pattern: true, freq: true }, s.llmRules || {});
    s.catLabels = Object.assign({}, s.catLabels || {});
    s.libSegs = Math.max(0, Math.min(10, parseInt(s.libSegs, 10) || 4));
    s.libPins = Array.isArray(s.libPins) ? s.libPins : [];
    s.libBlocks = Array.isArray(s.libBlocks) ? s.libBlocks : [];
    s.aiHotkeys = s.aiHotkeys !== false;
    s.relIncludeLex = !!s.relIncludeLex;
    s.loreCats = Array.isArray(s.loreCats) ? s.loreCats : [];
    s.catExtra = (s.catExtra && typeof s.catExtra === "object") ? s.catExtra : {};
    s.editorFontSize = (parseFloat(s.editorFontSize) > 0) ? parseFloat(s.editorFontSize) : 13.5;
    s.ui = Object.assign({ dockOpen: true, dockMax: false, materialOn: true, problemsCollapsed: false, aiTabOpen: false }, s.ui || {});
    return s;
  }
  // 旧 llmModels { [id]: {base,list} } → 合并进 provider.models（无则补入），避免双源
  function mergeLlmModels(s) {
    const old = s.llmModels;
    if (!old || typeof old !== "object") return null;
    let dirty = false;
    const provs = Object.assign({}, s.providers || {});
    for (const [id, v] of Object.entries(old)) {
      const list = Array.isArray(v) ? v : (v && Array.isArray(v.list) ? v.list : null);
      if (!list || !list.length) continue;
      const p = provs[id];
      if (!p) continue;
      const cur = (Array.isArray(p.models) ? p.models : (p.model ? [p.model] : []));
      const merged = cur.concat(list.filter(m => !cur.includes(m)));
      provs[id] = Object.assign({}, p, { models: merged });
      dirty = true;
    }
    return dirty ? provs : null;
  }
  function normalizeActiveModels(am) {
    const out = {};
    if (am && typeof am === "object") {
      for (const [pid, m] of Object.entries(am)) if (typeof m === "string" && m) out[pid] = m;
    }
    return out;
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings || defaultSettings())); } catch (e) { }
  }
  function updateSettings(patch) {
    // 防止 key 误入 localStorage（一律走 secret store）
    if (patch && patch.providers) {
      for (const id of Object.keys(patch.providers)) {
        if (patch.providers[id] && "key" in patch.providers[id]) delete patch.providers[id].key;
      }
    }
    settings = Object.assign(getSettings(), patch);
    saveSettings();
    return settings;
  }

  /* ---------- 备份 / 全量快照（单一数据源，避免各模块手写 store 清单） ---------- */

  async function allStores() {
    const out = {};
    for (const s of STORES) out[s] = await all(s);
    return out;
  }
  function getRawSettings() {
    try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || "null"); } catch (e) { return null; }
  }
  // 备份快照：全表数据 + 设置（provider 与 secret 表都剥离 API Key），由备份导出统一调用
  async function snapshot() {
    const [data, settingsRaw] = await Promise.all([allStores(), Promise.resolve(getRawSettings())]);
    if (settingsRaw && settingsRaw.providers) {
      for (const pid of Object.keys(settingsRaw.providers)) {
        if (settingsRaw.providers[pid]) delete settingsRaw.providers[pid].key;
      }
    }
    // secret 表存明文 API Key，绝不进入快照（allStores 保留全表仅供内部/测试用）
    delete data.secret;
    return { settings: settingsRaw, stores: data };
  }

  return {
    open, all, putAll, remove, clear, count,
    getMeta, setMeta,
    saveDraft, loadDraft,
    saveFavs, addFav, loadFavs,
    getSecret, saveSecret, loadSecrets,
    getSettings, saveSettings, updateSettings,
    allStores, getRawSettings, snapshot,
    stores: () => STORES.slice(),
    providerPresets: () => PROVIDER_PRESETS,
    getProviders, activeProviderId, activeModel, normalizeProvider, normalizeProviders
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Store;
if (typeof globalThis !== "undefined") globalThis.Store = Store;
