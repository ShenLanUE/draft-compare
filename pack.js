"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
// 版本号从 manifest.json 读取，避免写死漂移
const VER = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(os.tmpdir(), "gaoding-pack", "稿定");

const FILES = [
  "manifest.json",
  "background.js",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/diff.js",
  "js/banks.js",
  "js/banks-data.js",
  "js/store.js",
  "js/suggest.js",
  "js/lint.js",
  "js/hotkeys.js",
  "js/editor.js",
  "js/editor-settings.js",
  "js/editor-ai.js",
  "js/bankmanager.js",
  "js/llm.js",
  "js/modelpicker.js",
  "js/agent.js",
  "js/loremanager.js",
  "js/library.js",
  "js/mdoutline.js",
  "js/util.js",
  "js/constants.js",
  "js/ui.js",
  "js/bus.js",
  "js/appstate.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png"
];

// 内置词库：可从源目录自动同步（node pack.js 时用 BANKS_SRC 指向 vault 词库源）
const BANKS_SRC = process.env.BANKS_SRC || path.join(ROOT, "banks");

// 1) 先构建预解析 bundle（js/banks-data.js）
console.log("构建词库 bundle...");
execFileSync(process.execPath, [path.join(ROOT, "tools", "build-banks-data.js")], {
  env: { ...process.env, BANKS_SRC: BANKS_SRC },
  stdio: "inherit"
});

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    const d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.error("缺少文件:", f); process.exit(1); }
  const dst = path.join(STAGE, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

if (fs.existsSync(BANKS_SRC)) {
  console.log("同步内置词库:", BANKS_SRC);
  copyDir(BANKS_SRC, path.join(STAGE, "banks"));
} else {
  console.warn("警告：未找到 banks 目录，打出的包将不含内置词库");
}

fs.mkdirSync(DIST, { recursive: true });
const zip = path.join(DIST, "稿定-v" + VER + ".zip");
if (fs.existsSync(zip)) fs.rmSync(zip);

execFileSync("powershell", [
  "-NoProfile", "-Command",
  "Compress-Archive -Path '" + STAGE + "' -DestinationPath '" + zip + "' -CompressionLevel Optimal -Force"
], { stdio: "inherit" });

fs.rmSync(STAGE, { recursive: true, force: true });
console.log("打包完成:");
console.log("  " + zip);
console.log("包含文件: " + FILES.join(", ") + ", banks/");
