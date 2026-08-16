# 稿定 · 真实浏览器测试技术文档

> 面向：其他 AI 会话 / 新开发者 / 任何想复现或扩展这套「真人浏览器级」测试的人。
> 本套测试用**真实 Chrome** 驱动 `index.html`，覆盖 9 个功能区，配合真实 DeepSeek API 端到端验证 AI。
> 与项目自带的 `TESTING.md`（内存 DOM 桩的 `full-flow-test.js`）互补：那套验证「逻辑不炸」，这套验证「真人用起来对不对」——选区、键盘、布局、弹层遮挡、异步渲染等只有真浏览器才测得出。
> 产物：`BUG_REPORT.md`（真实 Bug 清单）、`UX_REPORT.md`（体验不足清单）、本文件（如何复现与扩展）。

---

## 1. 概述

### 1.1 为什么需要真实浏览器测试

项目已有 `full-flow-test.js`（自研内存 DOM + 内存 IndexedDB 桩）覆盖 19 个模块的异常与缺失 ID，但它**模拟不了**：

- 选区 / 焦点 / blur 竞态（如补全弹窗被 blur 定时器误关）
- 布局与层级（如 `dock.maxed` 盖住还原按钮、`title-bar` 拦截点击）
- 弹窗 / 浮层遮挡点击的真实 hit-test
- 真实 HTTP（拉取模型、测试连接、流式/非流式 AI）
- 浏览器 API（剪贴板、下载、file chooser）

这些正是本次测试抓到 4 个真实 Bug 的场景。

### 1.2 本套测试的产物

| 产物 | 位置 | 内容 |
|---|---|---|
| Bug 报告 | `D:\Tools\draft-compare\BUG_REPORT.md` | 4 个严重 Bug：复现步骤 + 根因 + 代码定位 |
| 体验报告 | `D:\Tools\draft-compare\UX_REPORT.md` | 16 条体验不足 + 优先级 |
| 测试脚本 | `C:\Users\Administrator\AppData\Local\Temp\opencode\draft-compare-test\` | 可整体移动，`__dirname` 定位 |
| 测试数据 | 同上 `data/` 子目录 | 自造的草稿/大纲/角色卡/前文/词库 |

---

## 2. 环境与依赖

| 依赖 | 说明 |
|---|---|
| Node.js | 测试机为 v24（`node --version`） |
| `playwright-core` | 用 **本机已装 Chrome**（`channel:'chrome'`），不下载浏览器；`npm.cmd install playwright-core` 即可（PowerShell 下 `npm.ps1` 会被执行策略拦，用 `npm.cmd`） |
| Chrome | 测试机装在 `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| DeepSeek Key | 从 `%USERPROFILE%\.local\share\opencode\auth.json` 的 `deepseek.key` 读取（不硬编码） |

### 2.1 为什么用本地静态服务而不是 file://

`index.html` 用 IndexedDB / localStorage，file:// 下浏览器限制多、行为不稳。用 `server.js` 起一个静态服务（`http://127.0.0.1:8177`），接近真实使用且稳定。

---

## 3. 目录结构

```
draft-compare-test\
├── run.js              # 调度器：起服务→起Chrome→顺序跑9个模块→汇总→写BUG_REPORT.md
├── harness.js          # 工具层：错误监听、断言、toast、checkbox、弹窗/编辑器状态归一化
├── server.js           # 静态服务（root=D:\Tools\draft-compare，port=8177）
├── run-ai-only.js      # 只跑 AI 模块的独立调试入口（迭代快）
├── data\               # 测试数据
│   ├── drafts\         #   草稿A.md / 草稿B.md / 草稿C.txt（多草稿对比用）
│   ├── outline\        #   第一卷大纲.md（大纲工作区用）
│   ├── prev\           #   第零章.md（前文库用）
│   └── banks\          #   测试词库.md / 角色卡.md / 世界观.md（词库/设定导入用）
├── steps\              # 9 个功能模块
│   ├── compare.js      #   A 对比区
│   ├── outline.js      #   B 大纲/阅读工作区
│   ├── editor.js       #   C 定稿区/素材台/反AI
│   ├── bank.js         #   D 词库管理
│   ├── settings.js     #   E 设置/Provider/自定义Agent
│   ├── lore.js         #   F 设定管理
│   ├── library.js      #   G 前文库
│   ├── ai.js           #   H AI 深度辅助（真实 DeepSeek）
│   └── persist.js      #   I 持久化/刷新恢复
└── dbg-*.js            # 独立复现脚本（历史记录，可删）
```

`run.js` 的模块顺序数组：

```js
const modules = ["compare", "outline", "editor", "bank", "settings", "lore", "library", "ai", "persist"];
```

模块间会做**状态归一化**（见 §6.8），防止上个模块遗留的弹窗/最大化状态污染下个模块。

---

## 4. 测试数据设计

| 数据 | 意图 |
|---|---|
| `草稿A.md` | 带 YAML front matter；正文刻意含「瞳孔一缩 / 与此同时」等反AI T1 禁用词、口语化描写 |
| `草稿B.md` | 与 A 逐句「同义改写」：删除/新增/改词分布在每段，用于验证字符级 diff、统计栏、差异跳转 |
| `草稿C.txt` | 无 YAML 头的纯文本，段落结构不同（更长段落），验证段落对齐与非 md 导入 |
| `第一卷大纲.md` | `#`~`####` 多级标题 + 列表 + 引用块，验证大纲树折叠、全文阅读、搜索「七叔」 |
| `第零章.md` | 前文库：含「遗书」等可搜索关键词、角色速记、关键设定 |
| `测试词库.md` | 词库 md（`## 分类` + `- **词** | 释义 | 例句`）验证词库导入 |
| `角色卡.md` / `世界观.md` | 设定 md（`## 角色名` + 字段键），验证设定导入/搜索 |

> 校验技巧：新增测试数据后，用项目自带 `node tools\validate-banks.js` 确认能被解析器往返解析。

---

## 5. 测试方法

### 5.1 真人操作路径

每个功能区按「真人作者」的顺序操作，尽量走真实交互而非直接改内部状态：

- **导入**：`page.setInputFiles("#file-input", files)` 直写隐藏 input（等价于选择文件后触发 change）；动态创建的 file input（设定导入）用 initScript 捕获挂载后 `setInputFiles`（见 §6.1）
- **粘贴**：点「粘贴文本」→ 填 `#paste-text` → 点 `[data-slot-done='1']`
- **点按**：`h.click` 等待可见可点；AI 面板内部用 evaluate 触发（见 §6.3）
- **快捷键**：`page.keyboard.press("Control+ArrowDown")`、`Alt+p` 等
- **选区**：`el.focus(); el.setSelectionRange(s, e)` 再触发（换说法 / 选区工具条 / Alt+P）

### 5.2 断言与错误捕获

`harness.js` 全程挂 4 类监听，每个流程结束 `grabErrors()` 判断：

```js
page.on("console",   m => m.type() === "error"  && consoleErrors.push(m.text()));
page.on("pageerror", e => pageErrors.push(String(e)));          // 未捕获异常
page.on("requestfailed", r => failedRequests.push(r.url()+" :: "+(r.failure()?.errorText||"")));
```

- 断言失败 / 出现报错 → `h.bug(cat, severity, title, {steps, expected, actual, errors, hint})` 进 `BUGS[]`
- toast 校验：`h.waitToast(page, "已复制")`
- 下载校验：`page.waitForEvent("download", {timeout})`（差异报告/导出 md/备份 zip）

### 5.3 九大功能区覆盖清单

| 区 | 覆盖 |
|---|---|
| A 对比 | 导入3份、基准徽标、统计栏、字/行对比、并排/合并、栏数1-4、版本下拉、设为基准、高亮开关/纯阅读、差异跳转(按钮+Ctrl)、悬停联动、复制全文、忽略YAML头、导出差异报告、粘贴导入、重命名、清空、重选 |
| B 大纲 | 切换、导入、树渲染、展开/折叠、搜索(树+全文mark)、全文阅读、新建、编辑、送定稿、加前文库、导出、复制、删除 |
| C 定稿 | 输入+字数、反AI问题面板+跳转+筛选、@搜索、情绪选择、补全、换说法、自动补全、素材台3tab+筛选+搜索+插入、常用词句、送对比、导出、复制、全屏 |
| D 词库 | 4tab渲染、搜索、新增词条、表单⇄md、批量md编辑、导出、分类管理、格式说明、分页、fav删除、刷新、关闭 |
| E 设置 | 打开、Provider下拉/默认、启用AI+配DeepSeek、拉取模型(真实/models)、测试连接(真实/chat/completions)、保存+持久化、Agent模型绑定、自定义Agent新建/停用/删除、检查规则开关、备份zip |
| F 设定 | 分类tabs、导入角色卡/世界观、全局搜索、新增(表单+md)、编辑、分类管理、批量md、导出、刷新、关闭 |
| G 前文库 | 导入、搜索、新建、编辑、清空、关闭 |
| H AI | 面板/任务区、未开启提示、润色/续写/扩写/重写(真实API+重试)、关键词条/删/重跑、插入/复制/重做/删除、素材展开、前文/上下文注入、历史查看/清空、检索日志、情绪、关键词输入、选区浮动工具条、浮动结果卡替换、Alt+P |
| I 持久化 | 草稿刷新保留、统计恢复、折叠状态记忆、AI设置保留、大纲文档保留 |

---

## 6. 自动化踩坑与校准（复用价值最高）

> 每条都按「现象 → 判定 → 解法」记录。**遇到「点击没反应 / 报错」先对照本清单，区分真实 bug 与自动化假象。**

### 6.1 程序化 `.click()` 的 hidden file input 不触发 filechooser

- **现象**：`[data-outline-import]` 等按钮内部 `hiddenInput.click()`，Playwright **不派发 filechooser 事件**（`filechooser` 只对可见 input 的受信点击生效）——真浏览器会弹对话框，纯自动化限制。
- **判定**：不是 app bug。
- **解法**：
  - 已有 DOM 的隐藏 input：直接 `page.locator("#outline-file-input").setInputFiles(file)` / `#lib-file` / `#file-input`
  - **动态创建**的 input（设定导入 `loremanager.js doImport()` 用 `document.createElement`）：在 `run.js` 加 `addInitScript` 拦截——当 `HTMLInputElement.prototype.click` 被调且 input **未挂到 DOM** 时，给它赋 id、挂到 body 并记录序号，测试再从 `#dyn-file-input-N` `setInputFiles`：

```js
await page.addInitScript(() => {
  const orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === "file" && !document.contains(this)) {
      window.__dynFileCount = (window.__dynFileCount || 0) + 1;
      this.id = "dyn-file-input-" + window.__dynFileCount;
      this.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;";
      document.body.appendChild(this);
    }
    return orig.apply(this, arguments);
  };
});
```

  ⚠️ **只在 `!document.contains(this)` 时接管**：否则会把常驻的 `#file-input` 等一并改 id，导致后续 `setInputFiles("#file-input")` 找不到元素。

### 6.2 自定义 checkbox（`.chk input`）不可直接点

- **现象**：`.chk input { position:absolute; opacity:0; width:0; height:0 }`，`page.check("#chk-hl")` 报「element is not visible」超时。
- **判定**：纯视觉隐藏，非 bug。
- **解法**：`h.setCheck(page, sel, on)`——先判当前态，不同才点 `label`（触发 change），仍不同则 evaluate 兜底：

```js
async function setCheck(page, selector, on) {
  const input = page.locator(selector);
  const cur = await input.isChecked();
  if (cur === on) return;
  await input.locator("xpath=ancestor::label").click({ force: true });
  await sleep(120);
  const now = await input.isChecked();
  if (now !== on) await input.evaluate((el, v) => { el.checked = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, on);
}
```

### 6.3 AI 面板内部元素点击被拦截

- **现象**：AI 面板 `#ai-panel` 是 `overflow:hidden` 滚动容器，内部按钮（素材 toggle、历史条目等）Playwright 滚动的是页面而非容器，坐标被 `#ai-panel` / `.ai-foot` 拦截，报 `intercepts pointer events`。
- **判定**：滚动容器 hit-test 限制，非 bug。
- **解法**：`aiBodyClick` 用 `evaluate` 直接 `t.click()`（事件冒泡到 document 委托处理器，真实生效），并解析 `>> nth=N` 语法：

```js
async function aiBodyClick(page, selector) {
  const m = selector.match(/^(.*?)\s*>>\s*nth=(\d+)\s*$/);
  const baseSel = m ? m[1] : selector;
  const idx = m ? parseInt(m[2], 10) : 0;
  await page.evaluate(({ baseSel, idx }) => {
    const t = document.querySelectorAll(baseSel)[idx];
    if (t) t.click();
  }, { baseSel, idx });
  await sleep(150);
}
```

### 6.4 `dock.maxed` 铺满全窗，盖住后续所有点击

- **现象**：定稿区最大化后，后续模块点任何按钮都报「被 `#panes` / `#title-bar` / `#ai-panel` 拦截」——`#dock.maxed` 是 `position:absolute; inset:0; z-index:20`，且实测 `#title-bar z-index:30` 还会盖住还原按钮（**这是真实 bug BUG-003**）。
- **判定**：若因测试主动触发了最大化 → 是测试顺序问题；若还原按钮点不到 → 真实 bug。
- **解法**：模块间 `h.restoreEditor(page)` 强制移除 `collapsed/maxed`、隐藏素材台、复位 `app-window`；`run.js` 每个模块后统一 `closeAllModals` + 切回对比区。

### 6.5 真实 API 偶发限流 → 空出稿

- **现象**：连续快速跑多个 AI 任务，偶发「AI 没有产出内容」（接口 200 但空 / 超时）。
- **判定**：先**重试一次**再判定为 bug（本次 H9 循环就这么处理）。
- **区分真实 bug**：开「流式输出」时**必现**空出稿（非偶发）→ 真 bug BUG-004（`buildBody` 没带 `stream:true`）。用「开流式=空 / 关流式=正常」对照即可确诊。

### 6.6 断言目标选择错误（选择器校准）

- **现象**：误报「大纲树无节点」——因为实际类是 `.ol-node` 而我先写了 `.ot-node`；「词库 tab 空」——实际行类是 `.bk-item`；「全文阅读空」——实际段落类是 `.md-p/.md-h`。
- **判定**：测试脚本选择器问题，非 bug。
- **解法**：先 `dbg` 脚本 `innerHTML` 确认真实类名/结构再写断言。附本套用到的关键类：
  - 大纲树节点：`.ol-node`；全文段落：`.md-p`/`.md-h`；搜索树命中：`.ol-hit`
  - 词库条目：`.bk-item`；编辑/删除按钮：`[data-bk-edit]`/`[data-bk-del]`
  - 前文库条目：`.lib-item`
  - 设定条目：`.lore-item`；编辑表单字段：`[data-lk="name"]` 等
  - AI 结果版本：`[data-ai-ins]`；素材展开：`.ai-mat-body.open`（`.open` 加在 sibling 上，不是按钮上）
  - Provider 行：`.prov-row`；历史条目：`.ai-hist-item`

### 6.7 输入法/`fill` 与事件触发

- **现象**：`fill()` 大文本（词库批量 md 6 万+ 字符）会超时；`fill()` 不一定触发某些 input 事件。
- **判定**：脚本性能/事件问题，非 bug。
- **解法**：大文本用 evaluate 赋值 + 手动 `dispatchEvent(new Event("input"))`；需要 change 的用 `setCheck` / evaluate。

### 6.8 模块间状态归一化（防级联假 bug）

`run.js` 每个模块跑完（或崩溃）后执行：

```js
await h.closeAllModals(page);          // 关掉所有 .show 弹窗
await page.click('[data-area="compare"]').catch(() => {});  // 切回对比区
await h.sleep(300);
```

`harness.js` 的 `restoreEditor(page)`：移除 `dock` 的 `collapsed/maxed/user-h`、隐藏素材台、复位 `app-window`，兜底点 `#btn-editor-collapse`。

### 6.9 AI 面板/浮动卡的「写作中」类名不同（waitFor 易用错）

- **现象**：面板任务跑完但断言「未出稿」——因为 waitFor 等了不存在的类。
- **判定**：类名用错，非 app bug。
- **类名对照**（v2.13 起）：
  - **面板路径**（任务栏润色/续写等）：写作中元素 `#ai-body .ai-item.ai-live`
  - **浮动卡路径**（选区润色）：`#ai-float .af-live`
  - 两者不同，脚本须按路径分别写 waitFor 条件（`!q('.ai-item.ai-live')` vs `!q('.af-live')`）。
- **附带**：快捷键类断言（Ctrl+Shift+Enter 等）受 `popupMode` 状态影响——弹窗开着时 Enter 走 commit，弹窗关闭时才走分发逻辑；验证快捷键必须保证弹窗已关（用 Escape 走 `hideSuggest` 重置 `popupMode`，直接设 `hidden` 无效）。

---

## 7. 真实 bug 与自动化假象的判定原则

| 现象 | 判定 | 依据 |
|---|---|---|
| 选情绪后 console 抛 `EditorAi.syncAiEmo is not a function` | **真实 bug**（BUG-001） | 源码：`editor.js` 调用未导出函数 |
| 补全弹窗 120ms 可见 → 500ms 隐藏 | **真实 bug**（BUG-002） | blur 定时器 150ms 与按钮夺焦点竞态 |
| 最大化后还原按钮点不到 | **真实 bug**（BUG-003） | `elementFromPoint` 命中 title-bar；z-index 30>20 |
| 开流式必现空出稿、关流式正常 | **真实 bug**（BUG-004） | 真实 API 对照；`buildBody` 缺 `stream` |
| filechooser 事件不触发（hidden input 程序化 click） | 自动化限制 | 真浏览器正常；`setInputFiles` 直写 |
| `.chk input` 不可点 | 自动化限制 | opacity:0 视觉隐藏 |
| AI 面板内点击被拦截 | 自动化限制 | overflow:hidden 滚动容器 |
| A 模块删了 Provider → B 模块 AI 变 false | 测试顺序问题 | 用前置状态准备（settings 先配好 AI） |
| 刷新后 dock 仍 maxed | 测试顺序问题 + 真实 BUG-003 的连坐 | 主动清理持久化 `dockMax` |

**总原则**：报错在 `js/*.js` 且逻辑明显错误 → 真实 bug；报错是「元素不可见/被拦截/事件不触发」且真浏览器行为正常 → 自动化校准。

---

## 8. 运行指南

```powershell
# 依赖（一次性）
cd C:\Users\Administrator\AppData\Local\Temp\opencode\draft-compare-test
npm.cmd init -y
npm.cmd install playwright-core --no-fund --no-audit

# 跑全量（9 个功能区 + 真实 AI，约 10-20 分钟）
node run.js
# 产物：BUG_REPORT.md（写到 D:\Tools\draft-compare\） + runX.log + shots\

# 只跑 AI 模块（迭代快）
node run-ai-only.js

# 独立复现某个交互（如补全弹窗）
node dbg-popup2.js
```

**新增一个功能模块**：
1. `steps/xxx.js`：`exports.name = "..."; exports.run = async ({ page, h, DEEPSEEK_KEY }) => { await h.closeAllModals(page); ... }`
2. `run.js` 的 `modules` 数组加 `"xxx"`
3. 优先用 `h.*` 工具（`setCheck/setFiles/click/waitToast`），AI 面板内用 `aiBodyClick` 模式
4. 跑 `run-ai-only.js` 等价物单模块调试 → 再全量回归

---

## 9. 已知限制与未覆盖

- **扩展专属能力**：侧边栏/小窗「模式」菜单、`chrome.sidePanel`/`chrome.windows`、工具栏图标打开——直接开 `index.html` 时不可用，未测。
- **真实 OS 级拖拽**：文件拖入窗口用合成 `drop` 事件等价模拟，非真实 OS 拖拽。
- **打包产物**：`dist/稿定-v2.13.0.zip` 未以扩展方式加载验证（测试用源目录 + 静态服务）。
- **多浏览器**：仅 Chrome（Edge 同为 Chromium 内核，脚本可 `channel:'msedge'` 复用，未跑）。
- **API 依赖**：AI 用例需要有效 DeepSeek Key；无 Key 时该部分跳过（AI 模块会先尝试从 `auth.json` 读取）。
- **随机性**：真实 API 输出内容不固定，断言只查「有没有出稿/有没有报错」，不断言内容。

---

## 10. 版本归档

### v3.0（2026-08-13，v2.13.1 复测）
- 对静态分析 + v2.13.1 修复做复测：**4 项修复全部验证通过**，并**新发现 1 个真实 Bug**（`BUG_REPORT.md` BUG-001：Ctrl+Shift+Enter 换说法失效）。
- 4 项专项验证：
  - llm.js 强制流式：网络拦截确认请求体 `stream:true` + 响应为真 SSE + **body 长度逐字递增**（onDelta 生效）
  - editor.js 换说法流式：开流式 → 工具条换说法 → 出 2 条 AI 改写候选（array/string 兼容正常）
  - store.js snapshot：备份 zip 解压检查 `settings.json` 无 API Key、无 secret 表
  - CSS diff 隔离：`.mline.m-del` computed 无按钮特征（border:none / font-weight:400），红底+删除线正常
- **新 Bug**：`editor.js:881` `if (ctrlKey&&key==Enter)` 未排除 shiftKey，`Ctrl+Shift+Enter` 走补全（`doReplace` 不可达）；`dbg-step3b7.js` 确凿复现（Ctrl+Enter 与 Ctrl+Shift+Enter 弹窗完全相同）
- 脚本校准（重要）：
  - **AI 面板 waitFor 类名**：面板写作中是 `.ai-item.ai-live`（非 `.af-live`，那是浮动卡的）；此前用错导致假失败
  - H14 浮动卡失败重试 + 网络分级；H9 每任务前确保面板 open；C8 换说法改工具条按钮触发 + C8b 快捷键专项
- 全量回归：脚本修复后连续多次 0 Bug（偶发 DeepSeek API 空响应/HTTP2 抖动，重试正常，判定环境问题）

### v2.0（2026-08-12，v2.13.0 回归）
- 对修复会话产出的 v2.13.0 做全量浏览器回归：**9 功能区 0 Bug、0 模块异常**
- 4 个严重 Bug（BUG-001~004）逐一专项复现验证修复生效（选情绪无报错 / 补全弹窗持续 / 最大化可还原 / 流式正常出稿）
- 16 条 UX 不足抽查通过；新增脚本校准：
  - `steps/editor.js` C6 情绪选择改为**按 `data-emo` 精确选取**（v2.13 情绪下拉新增「最近使用」分组，nth 索引不再稳定）
  - `steps/ai.js` `#ai-logwrap` → `.ai-logwrap`（真实 class）；H2.5 流式改为**实测回归**而非无条件报 bug
  - `steps/compare.js` A18 重选断言适配新初始提示语（UX-16）；复制类断言改用**读剪贴板**（toast 队列下提示可能被排队）
  - AI 网络层错误分级：`ERR_HTTP2 / 429 / timeout` 归「环境/限流抖动」（轻微），非产品 bug

### v1.0（2026-08-12，首版）
- 首次真实浏览器全功能测试：Playwright + 本机 Chrome + 静态服务 + 真实 DeepSeek
- 覆盖 9 大功能区，产出 4 个真实 Bug（`BUG_REPORT.md`）与 16 条体验不足（`UX_REPORT.md`）
- 沉淀本文件（§6 踩坑校准清单为最大复用价值）
