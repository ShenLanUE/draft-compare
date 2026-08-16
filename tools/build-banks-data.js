"use strict";
/* build-banks-data.js — 把 banks/ 词库 md 预解析成 js/banks-data.js（file:// 与扩展都可加载）。
   用法：node tools/build-banks-data.js
   可选：$env:BANKS_SRC="词库源目录" 指向更新的词库后再构建（pack.js 打包前会自动执行） */
const fs = require("fs");
const path = require("path");
const Banks = require("../js/banks.js");

const ROOT = path.join(__dirname, "..");
const BANKS = process.env.BANKS_SRC || path.join(ROOT, "banks");
const OUT = path.join(ROOT, "js", "banks-data.js");

const FILES = {
  lexicon: [
    "action-body.md", "appearance.md", "attire.md", "battle.md", "dialogue.md", "emotion.md",
    "environment.md", "expression.md", "figure-posture.md", "micro-action.md",
    "micro-expression.md", "realm-world.md", "romance.md", "system-flow.md", "xianxia.md"
  ],
  "golden-sentences": [
    "battle.md", "dialogue.md", "emotion.md", "entrance.md", "environment.md",
    "micro-action.md", "micro-expression.md", "payoff.md"
  ],
  "anti-ai": ["common-rules.md", "anti-ai-writing.md", "boundary-cases.md"]
};

const bundle = {
  version: 2,
  generated: new Date().toISOString().slice(0, 10),
  lexicon: [], golden: [], anti: []
};

for (const kind of Object.keys(FILES)) {
  for (const name of FILES[kind]) {
    const fp = path.join(BANKS, kind, name);
    if (!fs.existsSync(fp)) { console.warn("缺少文件:", fp); continue; }
    const md = fs.readFileSync(fp, "utf-8");
    try {
      if (kind === "lexicon") bundle.lexicon.push(...Banks.parseLexicon(md, name));
      else if (kind === "golden-sentences") bundle.golden.push(...Banks.parseGolden(md, name));
      else bundle.anti.push(...Banks.parseAntiRules(md).map(r => ({ type: "anti", ...r })));
    } catch (e) { console.warn("解析失败:", name, e.message); }
  }
}

bundle.lexicon = bundle.lexicon.map((e, i) => ({ ...e, id: "L" + i }));
bundle.golden = bundle.golden.map((e, i) => ({ ...e, id: "G" + i }));
bundle.anti = bundle.anti.map((e, i) => ({ ...e, id: "A" + i }));

const out = "/* 自动生成：node tools/build-banks-data.js（pack.js 打包前自动执行） */\n" +
  "window.BANK_BUNDLE = " + JSON.stringify(bundle) + ";\n";

fs.writeFileSync(OUT, out, "utf-8");
console.log("词库 bundle 已生成:", OUT);
console.log("  词库 " + bundle.lexicon.length + " · 黄金句 " + bundle.golden.length + " · 规则 " + bundle.anti.length);
console.log("  大小 " + (fs.statSync(OUT).size / 1024 / 1024).toFixed(2) + " MB");
