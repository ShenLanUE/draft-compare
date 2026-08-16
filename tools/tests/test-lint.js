"use strict";
/* test-lint.js — 反AI扫描单测：T1/T2/T3/句式/语境/词频。 */

const Lint = require(require("path").join(__dirname, "..", "..", "js", "lint.js"));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok:", name); } else { fail++; console.log("FAIL:", name); } };

const anti = [
  { level: "T1", terms: ["仿佛"], replacement: "像" },
  { level: "T2", terms: ["咽口水"] },
  { level: "ctx", terms: ["忽然"], thresh: { max: 3, per: "500字" } }
];
const freqRules = [
  { terms: ["攥衣角"], max: 2 }
];
Lint.compile(anti, freqRules);

const text = "他仿佛愣住，仿佛想说什么。他咽口水，又咽口水，喉头滚动，攥衣角，攥衣角攥得发皱。忽然雷响，忽然雨落，忽然风声，忽然灯灭。";
const diags = Lint.scan(text);

const has = (cat) => diags.some(d => d.cat === cat);
ok(has("t1"), "T1 禁用词命中");
ok(has("t2"), "T2 同段聚集命中");
ok(has("ctx"), "语境敏感（忽然>3次）命中");
ok(has("freq"), "词库⚠频率（攥衣角>2次）命中");

// pattern 句式
Lint.compile([], []);
const p1 = Lint.scan("他不是走了，而是留下了。");
ok(p1.some(d => d.cat === "pattern"), "句式模板（不是…而是…）命中");
const p2 = Lint.scan("她心中涌起一阵难过。");
ok(p2.some(d => d.cat === "pattern" && d.severity === "warn"), "心中涌起抽象情绪命中");

// T3 了密度
Lint.compile([], []);
const t3 = Lint.scan("他拿了剑，看了她，笑了一下，点了点头，说了声好。");
ok(t3.some(d => d.cat === "t3"), "T3 了密度提示命中");

// 干净文本无命中
const clean = Lint.scan("他攥紧拳头，指节泛白。她别过脸去。");
ok(!clean.some(d => d.severity === "error"), "干净文本无 error");

console.log("\nPASS=" + pass + " FAIL=" + fail);
process.exit(fail ? 1 : 0);
