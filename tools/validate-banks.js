"use strict";
/* 校验 banks.js 解析器对内置词库的解析结果 */
const fs = require("fs");
const path = require("path");
const Banks = require("../js/banks.js");

const ROOT = path.join(__dirname, "..", "banks");
let total = { lexicon: 0, golden: 0, anti: 0 };
const byCat = {};
const problems = [];
const bannedFromBanks = new Set();
let freqRules = 0;

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
    if (!f.endsWith(".md")) continue;
    const md = fs.readFileSync(fp, "utf-8");
    if (/^#\s*.*(README|说明|来源|维护)/.test(f)) continue;
    if (dir.endsWith("lexicon")) {
      const es = Banks.parseLexicon(md, f);
      total.lexicon += es.length;
      byCat[f] = es.length;
      for (const e of es) {
        if (!e.word) problems.push(`[${f}] 空词: ${e.gloss}`);
        if (!e.gloss && !e.example && !e.hint) problems.push(`[${f}] 空条目: ${e.word}`);
        if (e.antiAI) {
          const fr = Banks.freqRule(e.antiAI);
          if (fr && (fr.max !== null || fr.whole)) freqRules++;
          Banks.bannedPhrasesOf(e.antiAI).forEach(p => bannedFromBanks.add(p));
        }
      }
    } else if (dir.endsWith("golden-sentences")) {
      const es = Banks.parseGolden(md, f);
      total.golden += es.length;
      byCat["golden/" + f] = es.length;
      for (const e of es) {
        if (!e.original) problems.push(`[${f}] 缺原句`);
        if (!e.why) problems.push(`[${f}] 缺好在哪里: ${(e.original||"").slice(0,12)}`);
        if (!e.how) problems.push(`[${f}] 缺怎么用: ${(e.original||"").slice(0,12)}`);
      }
    } else if (dir.endsWith("anti-ai")) {
      const rs = Banks.parseAntiRules(md);
      total.anti += rs.length;
      byCat["anti/" + f] = rs.length;
    }
  }
}
walk(ROOT);

console.log("== 词库条数 ==");
for (const k of Object.keys(byCat).sort()) console.log("  " + k.padEnd(24), byCat[k]);
console.log("\n== 合计 ==");
console.log("  lexicon:", total.lexicon, " golden:", total.golden, " anti 规则:", total.anti);
console.log("  ⚠ 频率规则提取:", freqRules, " 从词库禁词提取:", bannedFromBanks.size, "个");
console.log("\n== 问题 ==");
if (problems.length) { problems.slice(0, 40).forEach(p => console.log("  " + p)); console.log("  ...共", problems.length, "条"); }
else console.log("  无");

console.log("\n== 样例 ==");
const sample = (cat, n) => {
  const dir = path.join(ROOT, cat);
  const f = fs.readdirSync(dir).find(x => x.endsWith(".md") && !x.includes("README"));
  if (!f) return;
  const md = fs.readFileSync(path.join(dir, f), "utf-8");
  const es = cat === "lexicon" ? Banks.parseLexicon(md, f) : Banks.parseGolden(md, f);
  console.log(JSON.stringify(es[n] || es[0], null, 1).slice(0, 900));
};
console.log("--- lexicon 样例 ---"); sample("lexicon", 0);
console.log("--- golden 样例 ---"); sample("golden-sentences", 0);

/* 角色卡 / 设定自检（无内置文件，用样例验证解析与识别） */
const SAMPLE_CHAR = "# 角色卡\n\n## 林晚\n- **别名**：晚晚 / 阿晚\n- **性别**：女\n- **外貌**：黑长直，左眼角泪痣\n- **示例对话**：\n  > \"随你。\"她别过脸。\n  > 见他不说话，她又补一句：\"…汤要凉了。\"\n";
const SAMPLE_SET = "# 设定\n\n## 青云宗\n- **类别**：门派\n- **设定**：北境第一大修仙宗门\n- **相关**：林晚、李恪\n";
const cArr = Banks.parseCharacters(SAMPLE_CHAR, "样例角色.md");
const sArr = Banks.parseSettings(SAMPLE_SET, "样例设定.md");
console.log("\n== 角色卡/设定自检 ==");
console.log("  角色卡解析:", cArr.length, "条 |", JSON.stringify(cArr[0] && cArr[0].name), "| 示例对话:", JSON.stringify(cArr[0] && cArr[0].examples));
console.log("  设定解析:", sArr.length, "条 |", JSON.stringify(sArr[0] && sArr[0].name), "| 类别:", JSON.stringify(sArr[0] && sArr[0].category));
console.log("  序列化往返:", (Banks.parseCharacters(Banks.serializeCharacters(cArr), "x.md").length === cArr.length));
console.log("  detectBank:", Banks.detectBank(SAMPLE_CHAR, "x.md"), "/", Banks.detectBank(SAMPLE_SET, "y.md"), "/", Banks.detectBank("# 角色卡\n## A\n- **外貌**：x", "personas.md"));
