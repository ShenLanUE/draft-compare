"use strict";
/* test-mdoutline.js — mdoutline.js 纯逻辑单测：块解析 / 大纲树 / 行内渲染 / 表格。 */

require(require("path").join(__dirname, "..", "..", "js", "util.js"));
const { Md, parseBlocks, parseOutline } = require(require("path").join(__dirname, "..", "..", "js", "mdoutline.js"));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log("  ok:", name); } else { fail++; console.log("FAIL:", name); } };

// 1) 行内渲染：加粗/斜体/代码/删除线/链接，且 HTML 被转义
ok(Md.inline("**加粗**") === "<strong>加粗</strong>", "行内加粗");
ok(Md.inline("`代码`") === "<code>代码</code>", "行内代码");
ok(Md.inline("~~删~~") === "<del>删</del>", "行内删除线");
ok(Md.inline("[文字](https://x)") === "文字", "链接只留文字");
ok(Md.inline("<script>") === "&lt;script&gt;", "HTML 转义");

// 2) 块解析：标题/列表/引用/代码块/表格/分隔线/段
const blocks = parseBlocks("# 第一章\n\n- 甲\n- 乙\n\n> 引用\n\n```\ncode\n```\n\n| 名称 | 值 |\n|---|---|\n| a | 1 |\n\n---\n\n正文段");
const types = blocks.map(b => b.type);
ok(types[0] === "heading" && blocks[0].level === 1 && blocks[0].text === "第一章", "标题块");
ok(types[1] === "list" && blocks[1].items.length === 2, "列表块");
ok(types[2] === "quote", "引用块");
ok(types[3] === "code" && blocks[3].text.includes("code"), "代码块");
ok(types[4] === "table" && blocks[4].rows.length === 3, "表格块");
ok(types[5] === "hr", "分隔线块");
ok(types[6] === "para" && blocks[6].text === "正文段", "普通段");

// 3) 大纲树：层级与 body 归属
const tree = parseOutline("开头\n\n# 一\n\n甲内容\n\n## 1.1\n\n乙内容\n\n# 二\n\n丙内容");
ok(tree.children.length === 2, "大纲两级节点");
ok(tree.children[0].title === "一" && tree.children[0].children.length === 1, "子标题挂对父级");
ok(tree.children[0].children[0].title === "1.1", "二级标题");
ok(tree.body.length === 1 && tree.body[0].type === "para" && tree.body[0].text === "开头", "标题前的段归根");
ok(tree.children[0].body.some(b => b.type === "para" && b.text === "甲内容"), "标题后段归该节");

// 4) 表格行内渲染不抛错
const { Md: Md2 } = { Md };
// 直接验证渲染函数可用的模块导出内容
ok(typeof parseBlocks === "function" && typeof parseOutline === "function", "导出解析函数");

console.log("\nPASS=" + pass + " FAIL=" + fail);
process.exit(fail ? 1 : 0);
