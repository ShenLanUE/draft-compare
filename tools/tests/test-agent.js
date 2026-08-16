"use strict";
require(require("path").join(__dirname, "..", "..", "js", "diff.js"));   // agent buildPrev 用 Diff.similarity
require(require("path").join(__dirname, "..", "..", "js", "bus.js"));    // AppState 依赖
require(require("path").join(__dirname, "..", "..", "js", "appstate.js"));
const lexicon = [
  { type: "lexicon", category: "micro-action", word: "咽口水", terms: ["咽口水", "咽了咽口水"], gloss: "喉结滚动", example: "他咽了口口水", hint: "", antiAI: null },
  { type: "lexicon", category: "micro-action", word: "手指绞着衣角", terms: ["手指绞着衣角"], gloss: "紧张小动作", example: "她绞着衣角", antiAI: null },
  { type: "lexicon", category: "emotion", word: "心口发紧", terms: ["心口发紧"], gloss: "紧张情绪", antiAI: "单章≤3次" },
  { type: "lexicon", category: "micro-expression", word: "眉心微蹙", terms: ["眉心微蹙"], gloss: "小神态" },
  { type: "golden", category: "emotion", book: "某书", original: "他攥紧的拳头里全是冷汗", why: "画面感强", how: "紧张时用" }
];
globalThis.Suggest = {
  searchAll: (q, o) => lexicon.filter(e => ((e.word || "") + " " + (e.original || "")).includes(q)).map(e => ({ ...e })),
  byEmotion: (emo, o) => emo === "紧张" ? lexicon.filter(e => e.category === "emotion").map(e => ({ ...e })) : []
};
globalThis.Banks = { catLabel: c => ({ "micro-action": "小动作", "micro-expression": "小神态", "emotion": "情绪" }[c] || c) };
// 共享状态（agent 通过 AppState 读取角色/设定与前文库）
global.window = {};
const seedLore = {
  characters: [{ name: "林晚", appearance: "黑长直，左眼角泪痣", personality: "外冷内热", relationships: "李恪的青梅" }],
  settings: [{ name: "青云宗", category: "门派", description: "北境第一大修仙宗门" }]
};
const seedLib = {
  chapters: [
    { title: "第 3 章", text: "他坐在窗边，手指轻轻扣着桌面，喉结上下滚了滚，咽了咽口水。\n\n她始终没说话。" },
    { title: "第 5 章", text: "青云宗的山门在晨雾里若隐若现，剑鸣声由远及近。" }
  ]
};
globalThis.AppState.setLore(seedLore.characters, seedLore.settings);
globalThis.AppState.setLibrary(seedLib.chapters, null);
const storeCfg = {
  llmEnabled: true, libSegs: 4,
  agentCfg: { systemNote: "", taskNotes: {}, useMaterial: true, useLore: true, usePrev: true, autoResearch: true, temperature: 0.7, maxWriteTokens: 1200 }
};
globalThis.Store = {
  getSettings: () => storeCfg,
  getProviders: () => ({ qwen: { name: "Qwen" }, deepseek: { name: "DeepSeek" }, glm: { name: "GLM" }, kimi: { name: "Kimi" } })
};

let llmCalls = [], planCall = 0;
globalThis.LLM = {
  enabled: () => true,
  chat: async (msgs, opts) => {
    llmCalls.push({ type: "chat" });
    const user = msgs[1].content;
    if (user.includes("搜索关键词")) {
      planCall++;
      if (planCall === 1) return "[]";   // 第一轮无效 → 兜底 + 触发补搜
      return '[{"kw":"咽口水","type":"小动作"},{"kw":"心口发紧","type":"情绪"},{"kw":"眉心微蹙","type":"小神态"}]';
    }
    if (user.includes("已检索到的词句库素材")) return "版本一\n\n版本二";
    return "回复";
  },
  streamChat: async (msgs, opts) => { llmCalls.push({ type: "stream" }); return "流式正文"; },
  splitVersions: (t) => String(t).split(/\n+/).map(s => s.trim()).filter(Boolean),
  activeProvider: () => ({ stream: false })
};

const Agent = require(require("path").join(__dirname, "..", "..", "js", "agent.js"));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok:", name); } else { fail++; console.log("FAIL:", name); } };

(async () => {
  // 1) parsePlan
  let p = Agent.parsePlan('[{"kw":"眼眶发酸","type":"小动作"},{"kw":"僵住","type":"小神态"}]');
  ok(p.length === 2 && p[0].kw === "眼眶发酸" && p[0].type === "小动作", "parsePlan JSON 数组");
  p = Agent.parsePlan("关键词：咽口水、眉心微蹙");
  ok(p.length === 2 && p[0].kw === "咽口水", "parsePlan 行式兜底");
  p = Agent.parsePlan("");
  ok(p.length === 0, "parsePlan 空输入→空");

  // 2) buildMaterial：检索 + 去重 + 格式化 + ⚠ 标记
  const mat = Agent.buildMaterial([{ kw: "咽口水", type: "小动作" }, { kw: "心口发紧", type: "情绪" }], "紧张");
  ok(mat.count >= 3, "素材命中: " + mat.count);
  ok(mat.text.includes("[小动作] 咽口水"), "格式化含分类+词条");
  ok(mat.text.includes("⚠单章"), "⚠ 反AI 标记保留");
  ok(mat.log.some(l => l.includes("🔍 搜索「咽口水」")), "日志含检索过程");

  // 3) 自动兜底关键词
  const ap = Agent.autoPlan("他站在原地，手一直抖。", "紧张");
  ok(ap.some(x => x.kw === "紧张"), "autoPlan 含情绪词");

  // 4) run 全流程：规划→检索→补搜→写作
  const logs = [];
  const res = await Agent.run("续写下一段", { context: "他攥着拳，", emotion: "紧张", kind: "action" }, { onLog: (m) => logs.push(m) });
  ok(res.versions.length === 2, "写作切出版本数");
  ok(res.materials.includes("咽口水"), "素材含真实词条");
  ok(res.count >= 3, "补搜后素材达标: " + res.count);
  ok(llmCalls.some(c => c.type === "chat"), "使用 chat（非流式）");
  ok(logs.some(l => l.includes("补充一轮搜索")), "触发补搜");
  ok(logs.some(l => l.includes("🔍 搜索「咽口水」")), "检索日志出现");

  // 5) run 流式路径
  const res2 = await Agent.run("续写下一段", { context: "他攥着拳，", emotion: "紧张", kind: "" }, { stream: true });
  ok(llmCalls.some(c => c.type === "stream"), "stream 模式调用 streamChat");
  ok(res2.versions.length === 1 && res2.versions[0] === "流式正文", "流式结果");

  // 6) 角色卡/设定全量注入
  const lastWrite = llmCalls.filter(c => c.type === "stream")[0] || llmCalls.filter(c => c.type === "chat")[0];
  ok(logs.some(l => l.includes("已注入角色卡 1 条 · 设定 1 条")), "日志报告注入数量");
  // 直接在 run 里捕获写入提示词做断言
  let loreInjected = false, prevInjected = false;
  const origChat = LLM.chat;
  globalThis.LLM.chat = async (msgs) => {
    const u = msgs[1].content;
    if (u.includes("【本作角色卡】") && u.includes("林晚") && u.includes("青云宗")) loreInjected = true;
    if (u.includes("【前文情节】") && u.includes("第 3 章") && u.includes("咽了咽口水")) prevInjected = true;
    return "版本一\n\n版本二";
  };
  await Agent.run("续写下一段", { context: "他咽了咽口水，把话吞了回去。", emotion: "紧张", kind: "" }, {});
  globalThis.LLM.chat = origChat;
  ok(loreInjected, "写作提示词注入角色卡+设定");
  ok(prevInjected, "写作提示词注入前文情节（跨章节检索）");

  // 7) 任务路由 + agentCfg（系统指令/任务指令/温度/输出上限 + 任务码修复）
  storeCfg.agentCfg.systemNote = "古风文风，多用短句";
  storeCfg.agentCfg.taskNotes = { polish: "多用白描", continue: "", expand: "", rewrite: "" };
  let writePromptSeen = "", lastConf = null, lastOpts = null, planCalls = 0, systemSeen = "";
  globalThis.LLM.chat = async (msgs, opts, conf) => {
    const u = msgs[1].content;
    if (u.includes("搜索关键词")) { planCalls++; return '[{"kw":"眼眶","type":"小神态"}]'; }
    lastConf = conf; lastOpts = opts; writePromptSeen = u; systemSeen = msgs[0].content;
    return "版本一\n\n版本二";
  };
  await Agent.run("polish", { context: "她站在原地。", emotion: "难过", kind: "" }, { route: { providerId: "deepseek", model: "deepseek-reasoner" } });
  ok(lastConf && lastConf.providerId === "deepseek" && lastConf.model === "deepseek-reasoner", "路由 conf 传给 LLM");
  ok(writePromptSeen.includes("给出 2-3 个改写版本"), "polish 任务用改写版本指令（任务码匹配修复）");
  ok(systemSeen.includes("古风文风，多用短句"), "系统提示词注入用户偏好（systemNote）");
  ok(writePromptSeen.includes("本任务额外要求：\n多用白描"), "写作提示词注入任务额外指令");
  ok(lastOpts && lastOpts.max_tokens === 1200 && lastOpts.temperature === 0.7, "温度/输出上限来自 agentCfg");

  // 8) 行为开关：关闭素材/前文 → 不规划、不注入
  storeCfg.agentCfg.useMaterial = false; storeCfg.agentCfg.usePrev = false; storeCfg.agentCfg.useLore = false;
  planCalls = 0; writePromptSeen = "";
  await Agent.run("continue", { context: "他站在门口。", emotion: "", kind: "" }, {});
  ok(planCalls === 0, "关闭素材/前文后不调规划");
  ok(writePromptSeen.includes("未检索到合适素材"), "关闭素材后素材为空");
  ok(!writePromptSeen.includes("【本作角色卡】"), "关闭后不注入角色卡");
  storeCfg.agentCfg = { systemNote: "", taskNotes: {}, useMaterial: true, useLore: true, usePrev: true, autoResearch: true, temperature: 0.7, maxWriteTokens: 1200 };

  // 9) 多子 Agent：规划/写作/审校 各自用绑定模型 + 素材整理 LLM 模式 + 自定义 Agent
  storeCfg.agentModels = {
    planner: { providerId: "qwen", model: "qwen-turbo" },
    material: { mode: "local" },
    writer: { providerId: "deepseek", model: "deepseek-chat" },
    reviewer: { enabled: true, providerId: "glm", model: "glm-4-flash" }
  };
  const calls = [];
  globalThis.LLM.chat = async (msgs, opts, conf) => {
    const sys = msgs[0].content, u = msgs[1].content;
    calls.push({ conf, sys, u });
    if (u.includes("候选素材")) return "[小动作] 咽口水\n[小动作] 手指绞着衣角";
    if (u.includes("搜索关键词")) return '[{"kw":"咽口水","type":"小动作"},{"kw":"心口发紧","type":"情绪"}]';
    if (sys.includes("审校编辑")) return "审校后的正文。\n\n第二段。";
    return "版本一\n\n版本二";
  };
  await Agent.run("continue", { context: "他推开门。", emotion: "紧张", kind: "" }, {});
  const plannerC = calls.find(c => c.u.includes("搜索关键词"));
  const writerC = calls.find(c => c.u.includes("已检索到的词句库素材") && !c.sys.includes("审校编辑"));
  const reviewerC = calls.find(c => c.sys.includes("审校编辑"));
  ok(plannerC && plannerC.conf.providerId === "qwen", "规划子 Agent 用绑定模型 qwen");
  ok(writerC && writerC.conf.providerId === "deepseek", "写作子 Agent 用绑定模型 deepseek");
  ok(reviewerC && reviewerC.conf.providerId === "glm", "审校子 Agent 用绑定模型 glm");

  // 素材整理 LLM 模式：多一次调用（material agent 模型）
  storeCfg.agentModels.material = { mode: "llm", providerId: "kimi", model: "moonshot-v1-8k" };
  calls.length = 0;
  const matRes = await Agent.run("continue", { context: "他推开门。", emotion: "紧张", kind: "" }, {});
  const matC = calls.find(c => c.u.includes("候选素材"));
  ok(matC && matC.conf.providerId === "kimi", "素材整理 LLM 模式用 material 绑定模型 kimi");
  ok(matRes.materials.includes("咽口水"), "素材整理 LLM 模式结果保留素材");
  storeCfg.agentModels.material = { mode: "local" };
  storeCfg.agentModels.reviewer = { enabled: false };   // 自定义 Agent 测试关掉审校，聚焦自身行为

  // 自定义 Agent：完整管线，用自身模型，系统提示词生效
  storeCfg.customAgents = [
    { id: "c1", name: "古风写手", systemPrompt: "你是古风写手：多用文言对白。", useMaterial: true, useLore: true, usePrev: true, pipeline: true, providerId: "glm", model: "glm-4-flash", temperature: 0.8, maxTokens: 900, enabled: true }
  ];
  calls.length = 0;
  let c1Sys = "", c1Conf = null;
  globalThis.LLM.chat = async (msgs, opts, conf) => {
    const sys = msgs[0].content, u = msgs[1].content;
    if (u.includes("搜索关键词")) return '[{"kw":"咽口水","type":"小动作"}]';
    if (sys.includes("审校编辑")) return "审校后的正文。";
    c1Sys = sys; c1Conf = conf;
    return "古风正文一。\n\n古风正文二。";
  };
  const c1res = await Agent.run("c1", { context: "他推开门。", emotion: "", kind: "" }, {});
  ok(c1Sys.includes("你是古风写手：多用文言对白"), "自定义 Agent 系统提示词生效");
  ok(c1Conf && c1Conf.providerId === "glm", "自定义 Agent 用自身绑定模型 glm");
  ok(c1res.versions.length === 2 && c1res.versions[0].includes("古风"), "自定义 Agent 产出正文");

  // 自定义 Agent：直接写模式 → 跳过规划（无"搜索关键词"调用）
  storeCfg.customAgents.push({ id: "c2", name: "直接写手", systemPrompt: "快写。", useMaterial: true, useLore: true, usePrev: true, pipeline: false, providerId: "", model: "", temperature: 0.7, maxTokens: 1200, enabled: true });
  calls.length = 0;
  globalThis.LLM.chat = async (msgs) => {
    const u = msgs[1].content;
    calls.push({ u });
    return "直出正文。";
  };
  await Agent.run("c2", { context: "他推开门。", emotion: "紧张", kind: "" }, {});
  ok(!calls.some(c => c.u.includes("搜索关键词")), "直接写模式跳过规划调用");

  // 10) parseKeywords 手动关键词
  const pk = Agent.parseKeywords("柳如烟, 眼泪 长剑，七星剑");
  ok(pk.length === 4 && pk[0].kw === "柳如烟", "parseKeywords 拆分隔符");
  ok(Agent.parseKeywords("啊").length === 0, "parseKeywords 过滤过短词");

  // 11) buildPrev 用索引候选定位（构建与 library.rebuildIndex 一致的索引）
  const libSegs = [];
  seedLib.chapters.forEach((ch, ci) => {
    if (!ch.id) ch.id = "T" + ci;
    String(ch.text).split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length >= 10)
      .forEach((p, i) => libSegs.push({ id: ch.id, title: ch.title, active: true, i, text: p }));
  });
  const bg = new Map();
  libSegs.forEach((sg, idx) => {
    const clean = sg.text.replace(/\s+/g, "");
    for (let i = 0; i < clean.length - 1; i++) {
      const b = clean.slice(i, i + 2);
      let s = bg.get(b); if (!s) { s = new Set(); bg.set(b, s); }
      s.add(idx);
    }
  });
  AppState.setLibrary(seedLib.chapters, { segs: libSegs, bigram: bg });
  const pv = Agent.buildPrev([{ kw: "咽口水", type: "" }], "她咽了咽口水", 4);
  ok(pv.used >= 1 && pv.hits.length >= 1 && pv.hits[0].title === "第 3 章", "buildPrev 索引检索命中相关章节");
  ok(Array.isArray(pv.hits) && !!pv.hits[0].id, "buildPrev 返回 hits（含章 id）");
  const seg5 = libSegs.find(s => s.title === "第 5 章");
  seg5.active = false;
  const pv2 = Agent.buildPrev([{ kw: "长老", type: "" }], "", 4);
  ok(!pv2.hits.some(h => h.title === "第 5 章"), "buildPrev 跳过已停用章节");
  seg5.active = true;

  // 12) enrichPlanWithLore：上下文/选区里的角色名 + 设定名，命中设定并入其 related 引用
  const ep = Agent.enrichPlanWithLore([{ kw: "紧张", type: "情绪" }], "林晚走进青云宗。", "林晚深吸一口气");
  ok(ep.some(x => x.kw === "林晚"), "enrichPlanWithLore 并入上下文角色名（含别名/选区）");
  ok(ep.some(x => x.kw === "青云宗"), "enrichPlanWithLore 并入上下文设定名");
  AppState.get().settings[0].related = "掌门令牌";
  const ep2 = Agent.enrichPlanWithLore([{ kw: "青云宗", type: "" }], "他提到青云宗。", "");
  ok(ep2.some(x => x.kw === "掌门令牌"), "命中设定时并入其 related 引用名");
  delete AppState.get().settings[0].related;

  // 13) 手动关键词跳过规划（不调"搜索关键词"）
  let planCallCnt = 0;
  globalThis.LLM.chat = async (msgs) => {
    if (msgs[1].content.includes("搜索关键词")) planCallCnt++;
    return "版本一\n\n版本二";
  };
  await Agent.run("continue", { context: "他推开门。", emotion: "", kind: "", keywords: "咽口水, 门" }, {});
  ok(planCallCnt === 0, "手动关键词跳过规划调用");

  // 14) buildPrev 钉选/排除（opts.pins / opts.blocks）
  const pvPin = Agent.buildPrev([{ kw: "不存在的词", type: "" }], "", 4, { pins: [{ id: "T0", i: 0 }], blocks: [] });
  ok(pvPin.used >= 1 && pvPin.hits[0].title === "第 3 章", "buildPrev 钉选段强制注入（无关键词也返回）");
  const pvBlock = Agent.buildPrev([{ kw: "长老", type: "" }], "", 4, { pins: [], blocks: [{ id: "T1", i: 0 }] });
  ok(!pvBlock.hits.some(h => h.title === "第 5 章"), "buildPrev 排除段不返回");

  // 15) buildLore 按相关度选卡：命中的角色/设定排前面，返回注入名单
  AppState.setLore([
    { name: "林晚", appearance: "青衫", personality: "沉静" },
    { name: "王五", appearance: "麻衣" }
  ], [
    { name: "青云宗", category: "宗门", description: "仙门" },
    { name: "杂货铺", category: "地点", description: "街角小店" }
  ]);
  const lr = Agent.buildLore([{ kw: "林晚", type: "" }, { kw: "青云宗", type: "" }], "林晚走进青云宗。");
  ok(lr.charNames[0] === "林晚", "buildLore 命中的角色排最前");
  ok(lr.setNames[0] === "青云宗", "buildLore 命中的设定排最前");
  ok(lr.text.indexOf("林晚") < lr.text.indexOf("王五"), "buildLore 文本中命中角色在前");
  ok(Array.isArray(lr.charNames) && Array.isArray(lr.setNames), "buildLore 返回注入名单");
  AppState.setLore(seedLore.characters, seedLore.settings);

  console.log("\nPASS=" + pass + " FAIL=" + fail);
  process.exit(fail ? 1 : 0);
})();
