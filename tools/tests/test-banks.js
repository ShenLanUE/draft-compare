"use strict";
/* test-banks.js — banks.js 解析/序列化单测：设定模板字段、extra、续行、往返、角色卡 extra。 */

const Banks = require(require("path").join(__dirname, "..", "..", "js", "banks.js"));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok:", name); } else { fail++; console.log("FAIL:", name); } };

// 1) 设定：分类专属字段（物品：功能/效果 + 材质）解析与往返
const md1 = "## 玄铁剑\n\n- **类别**：物品\n- **功能/效果**：削铁如泥\n- **材质**：玄铁\n- **相关**：林晚\n";
const s1 = Banks.parseSettings(md1, "t.md")[0];
ok(s1 && s1.name === "玄铁剑" && s1.category === "物品", "解析分类专属字段（类别/功能）");
ok(s1.description === "削铁如泥", "功能/效果 → description 键");
ok(s1.material === "玄铁", "材质 → material 键");
ok(s1.related === "林晚", "相关 → related 键");
const md1b = Banks.settingToMd(s1);
const s1b = Banks.parseSettings(md1b, "t.md")[0];
ok(s1b.description === "削铁如泥" && s1b.material === "玄铁" && s1b.related === "林晚", "专属字段 md 往返无损");

// 2) 自定义字段（extra）：未知标签 → extra，含续行
const md2 = "## 剑冢\n\n- **类别**：地点\n- **禁地数**：7\n- **守护者**：\n  老铁匠\n  剑灵\n";
const s2 = Banks.parseSettings(md2, "t.md")[0];
ok(s2.extra && s2.extra["禁地数"] === "7", "未知标签进 extra");
ok(s2.extra && String(s2.extra["守护者"]).includes("剑灵"), "extra 多行续行");
const md2b = Banks.settingToMd(s2);
const s2b = Banks.parseSettings(md2b, "t.md")[0];
ok(s2b.extra["禁地数"] === "7" && String(s2b.extra["守护者"]).includes("剑灵"), "extra 往返无损");

// 3) 门派 chip 字段（主要成员）
const md3 = "## 青云宗\n\n- **类别**：门派\n- **主要成员**：林晚/李恪\n";
const s3 = Banks.parseSettings(md3, "t.md")[0];
ok(s3.members === "林晚/李恪", "chip 字段主要成员解析");
ok(Banks.settingToMd(s3).includes("主要成员"), "chip 字段序列化");

// 4) 角色卡 extra 往返
const mc = "## 林晚\n\n- **外貌**：黑长直\n- **门派**：青云宗\n";
const c = Banks.parseCharacters(mc, "t.md")[0];
ok(c.appearance === "黑长直", "角色卡常规字段");
ok(c.extra && c.extra["门派"] === "青云宗", "角色卡未知标签进 extra");
const c2 = Banks.parseCharacters(Banks.charToMd(c), "t.md")[0];
ok(c2.appearance === "黑长直" && c2.extra["门派"] === "青云宗", "角色卡往返无损");

// 5) 模板字段表暴露
ok(Banks.catFields("物品").some(f => f.key === "material"), "CAT_FIELDS 物品含材质");
ok(Banks.catFields("门派").some(f => f.key === "members" && f.type === "chip"), "CAT_FIELDS 门派含 chip 成员");

// 6) 词库/黄金句往返
const lex = Banks.parseLexicon("## 紧张\n\n- **咽口水** — 喉结滚动\n  例句：他咽了口口水\n", "t.md");
ok(lex.length === 1 && lex[0].word === "咽口水" && lex[0].gloss === "喉结滚动", "词库解析");
const gold = Banks.parseGolden("## 紧张\n\n**原句**：他攥紧的拳头\n**好在哪里**：画面感\n**怎么用**：紧张时\n\n", "t.md");
ok(gold.length === 1 && gold[0].original === "他攥紧的拳头" && gold[0].why === "画面感", "黄金句解析");

console.log("\nPASS=" + pass + " FAIL=" + fail);
process.exit(fail ? 1 : 0);
