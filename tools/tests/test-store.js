"use strict";
const makeReq = (result) => {
  const req = { result, onsuccess: null, onerror: null, error: null };
  setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
  return req;
};
globalThis.indexedDB = {
  open: () => {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => ({ put: () => makeReq(null) }),
      transaction: (name, mode) => {
        const t = { oncomplete: null, onerror: null };
        setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 0);
        return { objectStore: (n) => ({ getAll: () => makeReq([]), put: () => makeReq(null) }) };
      }
    };
    const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    setTimeout(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
    return req;
  }
};
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] != null ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok:", name); } else { fail++; console.log("FAIL:", name); } };
function freshStore() {
  delete require.cache[require.resolve(require("path").join(__dirname, "..", "..", "js", "store.js"))];
  return require(require("path").join(__dirname, "..", "..", "js", "store.js"));
}

(async () => {
  // ===== 场景1：旧版结构迁移 =====
  localStorage._d = {};
  localStorage.setItem("draft-compare-settings", JSON.stringify({
    llmEnabled: true, llmProvider: "openai",
    llmOpenAI: { base: "https://my-proxy/v1", model: "m1", key: "sk-LEGACY" },
    llmStream: true,
    llmModels: { openai: ["m1", "m2"], anthropic: [] }
  }));
  let Store = freshStore();
  await Store.loadSecrets();
  const s1 = Store.getSettings();
  ok(Store.getSecret("openai") === "sk-LEGACY", "旧 key 迁入 secret(openai)");
  ok(Object.keys(s1.providers).length >= 12, "预设全量种子: " + Object.keys(s1.providers).length);
  ok(s1.activeProvider === "openai", "activeProvider=openai（旧配置非空）");
  ok(s1.providers.openai.base === "https://my-proxy/v1" && s1.providers.openai.model === "m1", "旧配置进 providers.openai");
  ok(s1.providers.openai.stream === true, "llmStream 迁到 provider.stream");
  ok(Array.isArray(s1.providers.openai.models) && s1.providers.openai.models.includes("m2"), "旧模型缓存合并进 provider.models（去双源）");
  ok(s1.providers.deepseek.base.includes("deepseek"), "deepseek 预设存在");

  // 空配置旧格式 → 映射 deepseek 预设
  localStorage._d = {};
  localStorage.setItem("draft-compare-settings", JSON.stringify({ llmEnabled: true, llmProvider: "openai", llmOpenAI: {}, llmStream: false }));
  Store = freshStore();
  const s1b = Store.getSettings();
  ok(s1b.activeProvider === "deepseek", "空配置旧格式 → activeProvider=deepseek");
  ok(Store.activeProviderId() === "deepseek", "activeProviderId 解析");

  // ===== 场景2：新格式 passthrough + 补预设 + key 防泄漏 =====
  localStorage._d = {};
  localStorage.setItem("draft-compare-settings", JSON.stringify({
    llmEnabled: false, activeProvider: "deepseek",
    providers: { deepseek: { id: "deepseek", name: "DeepSeek", type: "openai", base: "https://x", model: "m", stream: false } },
    llmModels: {}
  }));
  Store = freshStore();
  const s2 = Store.getSettings();
  ok(s2.providers.deepseek.base === "https://x", "新格式保留用户配置");
  ok(!!s2.providers.groq && !!s2.providers.ark, "缺失预设自动补齐");

  // 用完整 providers 对象 update，key 应被剥离
  Store.updateSettings({ providers: Object.assign({}, s2.providers, { x: { id: "x", name: "X", type: "openai", base: "b", key: "SHOULD-NOT" } }) });
  const raw = JSON.parse(localStorage.getItem("draft-compare-settings"));
  ok(!("key" in raw.providers.x), "updateSettings 剥离 provider.key");

  // activeProvider 失效回退首个
  Store.updateSettings({ activeProvider: "ghost" });
  ok(Store.activeProviderId() === "deepseek", "activeProvider 失效时回退首个");

  // saveSecret 往返
  await Store.saveSecret("deepseek", "sk-DS");
  ok(Store.getSecret("deepseek") === "sk-DS", "saveSecret 写入缓存");

  // 预设 12 家
  const presets = Store.providerPresets();
  const required = ["deepseek", "openai", "anthropic", "qwen", "glm", "kimi", "openrouter", "siliconflow", "ollama", "lmstudio", "groq", "ark"];
  ok(Object.keys(presets).length === 12 && required.every(id => presets[id]), "12 家预设齐全");

  // 6) 多模型/备注/activeModels/agentModels/agentCfg（干净状态）
  localStorage._d = {};
  Store = freshStore();
  const prov6 = Store.getProviders();
  ok(Array.isArray(prov6.deepseek.models) && prov6.deepseek.models.includes("deepseek-reasoner"), "预设带多模型列表");
  ok(prov6.deepseek.note === "", "预设 note 默认空");
  ok(Store.activeModel() === "deepseek-chat", "activeModel 取 models[0]");
  Store.updateSettings({ activeModels: { deepseek: "deepseek-reasoner" } });
  ok(Store.activeModel("deepseek") === "deepseek-reasoner", "activeModels 按 Provider 记忆");
  ok(Store.activeModel() === "deepseek-reasoner", "activeModel() 无参取当前默认 Provider");
  Store.updateSettings({ agentModels: { writer: { providerId: "deepseek", model: "deepseek-reasoner" } } });
  ok(Store.getSettings().agentModels.writer.model === "deepseek-reasoner", "agentModels 存取");
  Store.updateSettings({ agentCfg: { systemNote: "测试" } });
  ok(Store.getSettings().agentCfg.systemNote === "测试", "agentCfg 可设置");

  // 7) 旧格式迁移 → 带 models/新设置
  localStorage._d = {};
  localStorage.setItem("draft-compare-settings", JSON.stringify({ llmProvider: "openai", llmOpenAI: { base: "https://x", model: "m1" } }));
  Store = freshStore();
  const s7 = Store.getSettings();
  ok(Array.isArray(s7.providers.openai.models) && s7.providers.openai.models[0] === "m1", "旧 model 迁入 models");
  ok(s7.agentModels && typeof s7.agentCfg === "object" && s7.agentCfg.useLore === true && Array.isArray(s7.customAgents), "旧格式补齐新设置");

  // 8) 老库缺新表（character/setting/library）→ open() 自愈补表，且老数据保留
  {
    const oldData = {
      bank: { b1: { id: "b1", type: "lexicon", word: "老词" } },
      golden: {},
      anti: {},
      fav: {},
      draft: { current: { id: "current", text: "草稿" } },
      meta: {},
      secret: {}
    };
    let curVer = 1;
    const makeReq2 = (result) => { const r = { result, onsuccess: null, onerror: null, error: null }; setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0); return r; };
    global.indexedDB = {
      open: (name, version) => {
        const db = {
          version: curVer,
          objectStoreNames: { contains: n => n in oldData },
          createObjectStore: n => { oldData[n] = oldData[n] || {}; return {}; },
          transaction: (sname, mode) => {
            if (!(sname in oldData)) throw new Error("NotFoundError: " + sname);
            const t = { oncomplete: null, onerror: null };
            t.objectStore = (n) => ({
              getAll: () => makeReq2(Object.values(oldData[n] || {})),
              put: (v) => { const k = (v.id != null ? v.id : v.key != null ? v.key : v.text); oldData[n] = oldData[n] || {}; oldData[n][k] = v; return makeReq2(null); },
              clear: () => { oldData[n] = {}; return makeReq2(null); },
              count: () => makeReq2(Object.keys(oldData[n] || {}).length),
              get: k => makeReq2(oldData[n] ? oldData[n][k] : null),
              delete: k => { if (oldData[n]) delete oldData[n][k]; return makeReq2(null); }
            });
            queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); });
            return t;
          },
          close: () => {}
        };
        const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        setTimeout(() => {
          // 模拟真实浏览器：以低于当前版本的版本号打开 → VersionError（IndexedDB 规范）
          if (typeof version === "number" && version < curVer) {
            const err = new Error("VersionError");
            err.name = "VersionError";
            if (req.onerror) req.onerror({ target: { error: err } });
            return;
          }
          req.result = db;
          if (typeof version === "number" && version > curVer) { curVer = version; if (req.onupgradeneeded) req.onupgradeneeded(); }
          if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
      }
    };
    Store = freshStore();
    const libAll = await Store.all("library");
    ok(Array.isArray(libAll), "老库缺 library → open() 自愈后读取不抛错");
    await Store.putAll("library", [{ id: "l1", title: "第1章", text: "正文", ts: 1 }]);
    ok((await Store.count("library")) === 1, "老库补表后 library 可写入");
    ok(Array.isArray(await Store.all("character")), "老库缺 character → 自愈后读取不抛错");
    ok(Array.isArray(await Store.all("setting")), "老库缺 setting → 自愈后读取不抛错");
    const drafts = await Store.all("draft");
    ok(drafts.some(d => d.id === "current" && d.text === "草稿"), "自愈升级后老数据（草稿）保留");
    const banks = await Store.all("bank");
    ok(banks.some(b => b.id === "b1" && b.word === "老词"), "自愈升级后老数据（词库）保留");
  }

  // 9) 回归：老库已自愈到更高版本（如 v3，因新增 docs 表），重载后再 open() 不得抛 VersionError
  {
    const data = {};
    const ALL = ["bank", "golden", "anti", "fav", "draft", "meta", "secret", "character", "setting", "library", "docs"];
    ALL.forEach(s => data[s] = {});
    let curVer = 3;   // 模拟上次会话已把库升到 v3
    const mkReq = (result) => { const r = { result, onsuccess: null, onerror: null, error: null }; setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0); return r; };
    global.indexedDB = {
      open: (name, version) => {
        const db = {
          version: curVer,
          objectStoreNames: { contains: n => n in data },
          createObjectStore: n => { data[n] = data[n] || {}; return {}; },
          transaction: (sname, mode) => {
            if (!(sname in data)) throw new Error("NotFoundError: " + sname);
            const t = { oncomplete: null, onerror: null };
            t.objectStore = (n) => ({
              getAll: () => mkReq(Object.values(data[n] || {})),
              put: (v) => { const k = v.id != null ? v.id : v.text; data[n] = data[n] || {}; data[n][k] = v; return mkReq(null); },
              count: () => mkReq(Object.keys(data[n] || {}).length)
            });
            queueMicrotask(() => { if (t.oncomplete) t.oncomplete(); });
            return t;
          },
          close: () => {}
        };
        const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        setTimeout(() => {
          // 低于当前版本打开 → 抛 VersionError（真实浏览器行为；旧实现硬编码版本号会死在这）
          if (typeof version === "number" && version < curVer) {
            const err = new Error("VersionError");
            err.name = "VersionError";
            if (req.onerror) req.onerror({ target: { error: err } });
            return;
          }
          req.result = db;
          if (typeof version === "number" && version > curVer) { curVer = version; if (req.onupgradeneeded) req.onupgradeneeded(); }
          if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
      }
    };
    Store = freshStore();
    let threw = null;
    try {
      await Store.all("docs");
    } catch (e) { threw = e; }
    ok(threw === null, "DB 已在更高版本后重载，open() 不抛 VersionError");
    await Store.putAll("docs", [{ id: "d1", name: "大纲", text: "# 一", ts: 1 }]);
    ok((await Store.all("docs")).length === 1, "docs 表可正常写入");
  }

  console.log("\nPASS=" + pass + " FAIL=" + fail);
  process.exit(fail ? 1 : 0);
})();
