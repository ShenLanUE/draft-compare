# 稿定 · 测试技术文档

> 面向：其他 AI 会话 / 新开发者。本文说明本项目的**分层测试体系**与**模拟真人循环测试流程**，
> 以及如何运行、如何新增用例、如何区分"真实 bug"与"测试模拟缺口"。
> 变更代码后**必须**按本文第 6 节流程回归，直到全绿再打包。

---

## 1. 测试分层概览

| 层 | 文件 | 作用 | 运行 |
|---|---|---|---|
| 静态检查 | `node --check js/*.js` | 语法 | 改动后必跑 |
| 词库校验 | `tools/validate-banks.js` | 词库/黄金句/反AI/角色卡/设定 解析与识别往返 | 词库改动后跑 |
| 单元测试 | `tools/tests/test-{agent,llm,store,mdoutline,banks,lint}.js` | 逻辑正确性（mock 外部依赖） | `node tools/tests/test-*.js` |
| 模拟真人全量 | `tools/tests/full-flow-test.js` | 以"真实用户"方式驱动整应用（内存 DOM + 内存 IDB） | `node tools/tests/full-flow-test.js` |
| 打包 | `node pack.js` | 出 `dist/稿定-vX.Y.Z.zip` | 收尾必跑 |

**验收标准（收尾清单）**
- [ ] 全部 `js/*.js` `node --check` 通过
- [ ] `test-agent` / `test-llm` / `test-store` / `test-mdoutline` / `test-banks` / `test-lint` 全绿（无 FAIL）
- [ ] `full-flow-test.js` 输出 `全部异常数: 0` 且 `缺失ID: 无`
- [ ] `tools/validate-banks.js` 通过（词库相关改动时）
- [ ] `node pack.js` 成功，`dist/稿定-<最新版本>.zip` 存在且只保留当前版本

---

## 2. 运行方式（复制即用）

```powershell
# 在项目根目录（D:\Tools\draft-compare）下执行：

# 单元测试（全部跑，不要漏）
node tools/tests/test-store.js
node tools/tests/test-llm.js
node tools/tests/test-agent.js
node tools/tests/test-mdoutline.js
node tools/tests/test-banks.js
node tools/tests/test-lint.js

# 模拟真人全量测试（最重，务必最后跑）
node tools/tests/full-flow-test.js

# 静态语法
node --check js\app.js; node --check js\editor.js; node --check js\agent.js
node --check js\llm.js; node --check js\store.js; node --check js\suggest.js
node --check js\banks.js; node --check js\lint.js; node --check js\diff.js
node --check js\modelpicker.js; node --check js\bankmanager.js; node --check js\loremanager.js
node --check js\library.js; node --check js\mdoutline.js

# 词库校验
node tools\validate-banks.js

# 打包
node pack.js
```

> 测试脚本均基于 `__dirname` 定位项目 JS，可整体移动 `tools/` 目录或克隆到任意路径运行。

---

## 3. 单元测试（test-*.js）

- 直接 `require` 项目模块（`store.js` / `llm.js` / `agent.js`），用 mock 替换外部依赖：
  - `global.Store`（`getSettings/getProviders/getSecret/...`）
  - `global.LLM`（`chat/streamChat/enabled/...`，返回预设文本）
  - `global.Suggest` / `global.Banks` / `global.window`（`BankData`、`LibData`）
- `test-store.js` 用 `delete require.cache` 实现"干净实例"多场景测试（迁移、默认、新字段）。
- 断言用 `ok(cond, name)`，结尾 `process.exit(fail ? 1 : 0)`。
- **新增/修改行为时**：在对应 test-*.js 追加场景并断言（迁移字段、路由 conf、agentCfg 生效、开关等）。

---

## 4. 模拟真人全量测试（full-flow-test.js）

### 4.1 目标
不用真实浏览器，用**自研内存 DOM + 内存 IndexedDB**按 `index.html` 脚本顺序加载全部 18 个模块，
以真实用户操作（点按钮、输入、切换、保存）驱动所有功能区，捕获两类问题：
1. **异常**（TypeError / ReferenceError 等）—— 定位到 `元素id@事件` 或 `flow:流程名`
2. **缺失 ID** —— 代码访问了 `index.html` 里不存在的元素

### 4.2 覆盖流程（按字母分组）
| 组 | 覆盖 |
|---|---|
| A 对比区 | 导入草稿、栏数/粒度/模式/纯阅读、基准/清空/多栏、送对比、沉浸放大 |
| B 定稿区 | 输入/反AI、@搜索、补全、换说法、情绪/素材台/常用词句、插入AI结果 |
| C 词库管理 | 4 tab 渲染（词库/黄金句/反AI/常用，无角色设定）、批量md、分类、格式说明、fav删除；设定弹窗新增角色卡/门派设定卡 |
| D/I 设置/Provider | 切换+保存、管理弹窗、新建自定义、复制/删除/预设、多模型保存往返 |
| E/J/N/O AI | 润色/续写/扩写/重写、Agent 模型绑定/被删回落、上下文截断、空素材库、快速切换+标题 |
| F/L 前文库 | 新建/搜索/编辑/删除/清空 |
| M/K 边界 | 纯阅读、未开启AI提示、规则开关、自动补全、流式 |

### 4.3 DOM 桩能力（理解"为什么能测到真实逻辑"）
元素桩（`makeEl`）模拟了这些行为，**缺一不可**：
- `classList` 与 `className` 双向同步（`className` 赋值会写 `_classes`）
- `children` + `_parent` 树；`querySelector/All` 递归匹配
- **事件冒泡到 document**：`fire/click/change/input/keydown` 会同时触发元素自身与 `document` 上的监听器 → 文档级事件委托（`e.target.closest("[data-x]")`）真正生效
- `closest(sel)`：沿 `_parent` 上溯匹配（类 / id / 标签 / `data-*`）
- `getAttribute` / `hasAttribute`：支持 `class`、`id`、`data-xxx`
- `disabled` 语义：带 `disabled` 属性的按钮 `click()` 不响应
- `value/checked/selectionStart/selectionEnd`、`setSelectionRange/setRangeText/execCommand/dispatchEvent`
- `getComputedStyle` / `requestAnimationFrame` 等浏览器全局
- `innerHTML` 赋值会**解析成子节点树**（含 `class`/`id`/`data-*`/`disabled`/`hidden`/`checked`/`value`），动态渲染（词条列表、Provider 行、模型/Agent 绑定选项）都能被 `querySelector` 命中

### 4.4 内存 IndexedDB
- 事务完成用 `queueMicrotask` 触发 `t.oncomplete`（注意：**transaction 必须返回带 `objectStore` 的同一个 `t` 对象**，否则 oncomplete 闭包捕获的不是返回对象 → 永远不 resolve）
- `put/clear/count/get/getAll/delete` 齐全，支持 keyPath `id`
- 种子数据：`BANK_BUNDLE`（词库/黄金句/反AI，带 `tags`）+ 角色/设定/前文写入 IDB 后 `BankLoader.rebuild()` + `LibManager.load()`

### 4.5 断言
- `ok2(cond, name)`：断言失败会 push 到 `errors`（输出 `assert:xxx`）
- 涉及异步（AI 出稿）的流程：`flow(name, async () => {...})`，内部 `await new Promise(r=>setTimeout(r,120))` 等 agent 完成后再断言

---

## 5. 循环测试流程（每次改动后照此执行）

```
┌──────────────────────────────────────────────────────────┐
│ 1. 基线：node tools/tests/full-flow-test.js               │
│    → 必须 0 异常、0 缺失ID                                │
├──────────────────────────────────────────────────────────┤
│ 2. 深度/边界轮：针对"最易出问题 & 最影响体验"功能区补断言   │
│    对比区/定稿区/AI/设置/Provider/词库管理/前文库           │
│    每个区域：正常路径 + 空数据兜底 + 状态被删/改的边界      │
├──────────────────────────────────────────────────────────┤
│ 3. 修 bug：                                               │
│    · 真实 bug → 改 js/*.js                                │
│    · harness 桩缺口 → 给 full-flow-test.js 的 makeEl 补能力 │
├──────────────────────────────────────────────────────────┤
│ 4. 回归：node tools/tests/test-*.js 四个全绿               │
│    + node tools/tests/full-flow-test.js 全绿              │
├──────────────────────────────────────────────────────────┤
│ 5. 影响面确认：若只改了某模块 → 再针对性跑该模块相关流程    │
├──────────────────────────────────────────────────────────┤
│ 6. 收尾：node --check 全部 js + validate-banks + pack.js   │
│    + 确认 dist 只保留当前版本 zip                          │
└──────────────────────────────────────────────────────────┘
       ↕ 循环，直到第 1、2、4 步全绿
```

**区分真实 bug 与 harness 桩缺口（第 3 步的关键判断）**
- 报错在 `js/xxx.js` 且逻辑明显错误（如条件缺失、路径不符）→ 真实 bug，改应用代码
- 报错是 `xxx is not a function` / 点击"没反应"且对应 DOM API 桩没有 → 桩缺口，给 `makeEl` 或全局桩补能力（如 `hasAttribute`、`setSelectionRange`、`dispatchEvent`、`closest`）
- 流程间状态泄漏（如 A 流程删了 deepseek，B 流程却假设它存在）→ 是**测试顺序问题**，不是应用 bug：用 `ensureAIReady()` 等辅助函数保证前置状态

---

## 6. 已知陷阱（新会话务必先读）

1. **流程间共享全局状态**：`full-flow-test.js` 的流程按顺序共享 localStorage / IndexedDB / settings 内存缓存。
   - 某个流程可能删除 Provider（如 I2 删 deepseek）→ 后续 AI 流程的 `LLM.enabled()` 变 false → 提前 return。
   - 对策：AI 相关流程开头调用 `ensureAIReady()`（确保存在一个 base+key 的 active Provider）。
2. **异步 AI 断言**：`Agent.run` 是异步的，`flow` 内点完任务按钮后必须 `await` 一段时间再断言，否则 `seenCtx` 等还是空。
3. **`updateSettings` 是浅合并**：`providers`、`agentCfg` 等都是整块替换（调用方必须传全量对象）；迁移时才与默认值合并。
4. **`data-*` dataset 键**：桩里存的是**完整属性名**（`data-prov-id`），与选择器 `[data-prov-id]`、`getAttribute("data-prov-id")` 保持一致；不要用去前缀后的键。
5. **Agent 模型绑定被删 Provider**：`Agent.agentConf` 会校验 `Store.getProviders()[providerId]` 存在，否则回落当前默认——这是既定行为，别"修"成抛错。
6. **修改 store.js 的 defaultSettings / 迁移**：必须同步更新 `test-store.js` 的迁移与默认断言，否则单测红。
7. **硬编码 IndexedDB 版本号会炸全链**：IndexedDB 规定只能以「大于当前版本」的版本号打开；低于当前版本抛 `VersionError`。`store.js` 的 `open()` 必须无版本打开 + 缺表时「当前版本+1」自愈（不要再写死 `DB_VER`）。`test-store.js` 有重载回归用例（库已升到 v3 后重开不得抛错）。新增数据表必须：`store.js STORES` + `createStores` + 各模块 `AppState`/备份快照（`Store.snapshot()`）自动覆盖，不要手写 store 清单。
8. **架构分层（v2.10 起）**：`util.js`（低层工具）→ `store/banks/diff/lint/suggest/llm`（服务层，纯逻辑）→ `agent/editor/bankmanager/loremanager/library/mdoutline`（领域/UI 模块）→ `app.js`（应用壳 + AppBridge）。跨模块共享数据走 `AppState`（`setLore/setLibrary`）+ `Bus` 事件，**不要新增 `window.*` 可变全局**。新模块记得加入 `index.html` 脚本顺序、`pack.js FILES`、`full-flow-test.js` 的 `order` 数组。

---

## 7. 如何新增测试

**新增单元测试**（适合纯逻辑）：
1. 在 `tools/tests/test-<module>.js` 追加场景，或新建 `test-<module>.js`。
2. mock 该模块的外部依赖（Store/LLM/Suggest/window），`require` 目标模块。
3. 用 `ok(cond, "说明")` 断言，结尾 `console.log("PASS="+pass+" FAIL="+fail); process.exit(fail?1:0);`。
4. 从项目根 `node tools/tests/test-<module>.js` 验证。

**新增模拟真人流程**（适合 UI/交互/状态流）：
1. 在 `full-flow-test.js` 的 IIFE 里、`await flow("DBG...")` 之前插入：
   ```js
   await flow("Z1 我的新场景", async () => {
     getById("btn-xxx").click();
     q('[data-yyy="..."]').click();
     await new Promise(r => setTimeout(r, 120));   // 若涉及异步
     ok2(条件, "说明");
   });
   ```
2. 若需要新 DOM 能力，先在 `makeEl` 或全局桩补，再写流程。
3. 全程断言用 `ok2`；流程结束后看 `flow` 输出的 ✓/✗ 与最终 `全部异常数`。

---

## 8. 附录：桩的演进记录

历次"看起来是 bug 其实是桩缺口"的清单（遇到同类问题直接补）：
- `transaction()` 返回对象与 oncomplete 闭包不一致 → 事务永不完成（改桩）
- 元素无 `_parent` → `closest` 失效 → 事件委托全不生效
- 事件不冒泡到 document → 委托监听不触发
- `getAttribute` / `hasAttribute` 缺失 → `data-*` 读不到
- `setSelectionRange/setRangeText/execCommand/dispatchEvent` 缺失 → insertText 路径崩
- `className` 赋值不回写 `classList` → `querySelector(".x")` 找不到
- 流式/长任务未 await → 断言取到空值

---

## 9. 版本归档

### v2.15.2（快捷键录制守卫修复 + 出包收口）
**本轮改动**
- **录制快捷键时按 `?` 误弹快捷键面板修复**（解决 v2.15.1·静态分析 发现并修复的交互 bug，本轮出包纳入）：`shortcut_panel` 的 document 级 keydown 处理器注册先于录制处理器 `hkKeydown`，录制时按 `?` 会先弹面板盖住设置弹窗，`stopImmediatePropagation` 拦不住更早注册的监听。修复：`editor-settings.js` 暴露 `isCapturing: () => !!hkCapturing`，`editor.js` 命中 `shortcut_panel` 后、开面板前加「录制中不弹」守卫。
- **测试补强**：`full-flow-test.js` HK1 追加——录制中按 `?` 面板不 show；Escape 取消录制后 `isCapturing()` 为 false。
- **zip 收口**：上一轮「v2.15.1·静态分析」只改源码未重打，本轮 `manifest.json` 升 **2.15.2** 重打 `dist/稿定-v2.15.2.zip`，纳入录制守卫修复（zip 里 `?` 真机修复已在 v2.15.1 包内）。

**回归结果（全部通过）**
- `node --check`：23 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（22 模块，含 HK1 录制守卫断言）
- 打包：`dist/稿定-v2.15.2.zip`（含录制守卫 + banks/），旧 `稿定-v2.15.1.zip` 已清理

**待浏览器复测**：快捷键 tab 录制 `?` 不弹面板、真实键盘 `?`（Shift+/）弹面板、改绑/禁用/冲突/恢复默认、素材台搜索单次渲染。

### v2.15.1（快捷键 `?` 真机失效修复 + 出包收口）
**本轮改动**
- **`?` 快捷键真机失效修复**（解决 v2.15.0·静态分析 发现并修复的回归，本轮出包纳入）：`matches` 曾严格比较 `!!e.shiftKey === !!c.shift`，而默认 `shortcut_panel: {key:"?"}` 的 `shift:false`——真实键盘 `?` = `Shift+/`（`shiftKey:true`）→ 永不命中。修复（静态分析落地）：`hotkeys.js` 新增 `isShiftSensitive(key)`（字母/数字/空格/方向/功能键严格区分 shift；标点键忽略，字符本身编码 shift 语义）+ 公共 `comboEq(a,b)` 供 `matches`/`conflictOf` 共用。
- **mat-search 双监听去重**（静态分析落地）：`editor.js` 删即时 `refreshMaterial()` 监听，只留 150ms 防抖（v2.13 起每次输入渲染两次）。
- **store `hotkeys: {}` 缺省 + 迁移**（静态分析落地）。
- **本轮 polish**：`parseCombo` 录制标点键时把 `shift` 归一为 `false`（`?` 不再显示成 `Shift+?`，与默认/显示一致）。
- **测试**：HK1 增断言——`?` 无 shift 与 Shift+/ 均命中、`comboEq` 功能键 shift 严格区分/标点键忽略、`parseCombo` 标点键 shift 归一。

**回归结果（全部通过）**
- `node --check`：23 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（22 模块，含 HK1 新断言）
- 打包：`dist/稿定-v2.15.1.zip`（含 `?` 修复 + mat-search + store 缺省 + polish + banks/），旧 `稿定-v2.15.0.zip` 已清理

**待浏览器复测**：真实键盘 `?`（Shift+/）弹快捷键面板、设置 tab 自定义/禁用/冲突/恢复默认、素材台搜索只渲染一次。

### v2.15.1 · 代码质量优化（静态分析专项）

> 不升版本、不出包；本轮为 **v2.15.1 全量源码的静态分析 + 质量优化**（另一个会话审查落地）。不改功能入口，浏览器回归结论沿用 `BUG_REPORT.md`（v2.13.1 复测通过）。

**本轮改动**
- **Bug 修复**：
  - `editor.js` 快捷键录制中按 `?` 会弹快捷键面板（遮挡设置弹窗）：`shortcut_panel` 的 document 级 keydown 处理先于 `EditorSettings.hkKeydown`（录制）执行，且 `stopImmediatePropagation` 拦不住更早注册的监听。修：`editor-settings.js` 暴露 `isCapturing: () => !!hkCapturing`，`editor.js` 在命中 `shortcut_panel` 后、开面板前守卫「录制中不弹」。
- **测试补强**：
  - `full-flow-test.js` HK1 追加：`startCapture("shortcut_panel")` 后按 `?` → `shortcut-modal` 不 show；按 Escape 取消录制 → `isCapturing()` 为 false（锁定 A1 回归）。
- **观察项记录**：
  - `hkKeydown` 常驻 document 级监听，非录制时直接 return，无性能问题。
  - 标点键忽略 shift 的取舍（`?`/`!`/`@`…）沿用 v2.15.1 既有归档；`statusBtn` 同名标题共享进度沿用 v2.14 归档。

**回归结果（全部通过）**
- `node --check`：23 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（含 HK1 录制守卫新断言）
- 未跑 `pack.js`（本轮不升版、不出包；已在 **v2.15.2** 重打并纳入全部修复，见 v2.15.2 条目）

**遗留风险（沿用既有记录，未改）**
- **标点键忽略 shift 的取舍**：`?`/`!`/`/` 等标点键绑定不区分 shift 状态（`?` 与 `Shift+?` 视为同一键），为兼容多布局键盘的主动取舍；若需「标点键也区分 shift」需引入布局检测，待产品决策。
- **`mdoutline.js` F-06 大纲进度以标题为 key**：同名章节标题共享进度状态（v2.14 起，边缘场景），未改。
- 测试桩缺口 `makeEl.setAttribute()` 为空实现但 `getAttribute()` 读 `dataset`——沿用 TESTING.md §8 记录，未改。

### v2.15.0（用户自定义快捷键 + 纳入 v2.14.0·静态分析修复）
**本轮改动**
- **用户自定义快捷键（新功能）**：
  - 新增 `js/hotkeys.js` 服务模块：`DEFAULT_HOTKEYS` 默认键位（与历史硬编码一致）+ `get/matches/actionFor/parseCombo/comboLabel/assign（含冲突检测）/reset/resetAll`；绑定存 `settings.hotkeys`，`null`=禁用。
  - 可自定义 8 个动作：补全(Ctrl+Enter)、换说法(Ctrl+Shift+Enter)、AI 润色/扩写/重写(Alt+P/E/R)、快捷键面板(?)、差异上一处/下一处(Ctrl+↑/↓)。
  - 设置新增「快捷键」tab（`index.html` set-pane + `editor-settings.js` `renderHotkeys/onHkListClick/hkKeydown/hkResetAll`）：每行「改」→ 录制新组合（即时保存）→ 冲突检测拒绝并提示；「清除」禁用；「恢复默认」。
  - 分发改造：`editor.js onKeydown` 去掉硬编码 Alt+P/E/R、Ctrl+Enter、Ctrl+Shift+Enter，改 `Hotkeys.actionFor` 分派；document 级 `?`/Esc 面板、`app.js` Ctrl+↑/↓ 同样走 Hotkeys。弹窗内导航键与 Esc 取消语义保持固定不开放。
  - 注册：`index.html` 脚本顺序、`pack.js FILES`、`full-flow-test order`（`hotkeys.js` 在 editor.js 前）。
- **纳入上一轮「v2.14.0·代码质量优化」的 6 处修复**（该轮只改源码未出包）：`mdoutline countSections` 死代码、`?` 与正文输入冲突改 document 级+焦点守卫、F-08 30s 自动保存脏检查（`lastSavedText`）、`applyAllFixes` 回退补 input 事件、store `starred/recentEmos` 缺省+迁移、素材台星标排序 `Set` 化。
- **测试补强**：`full-flow-test.js` `makeEl.keydown` 补 `altKey`；新增 HK1（模块逻辑/冲突检测）、HK2（面板渲染+改绑 shortcut_panel→Ctrl+K+生效+旧键失效）、HK3（恢复默认+键位回归）。注：harness `matches` 不支持 `#settings-modal .set-tab` 复合选择器且事件不冒泡到父级 `#hotkeys-list`，HK2/HK3 直接调 `switchSetTab/onHkListClick`（等价路径）。

**回归结果（全部通过）**
- `node --check`：23 个 js 全通过（含 hotkeys.js）
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（22 模块，含 HK1~HK3）
- 打包：`dist/稿定-v2.15.0.zip`（含 hotkeys.js + 全部修复 + banks/），旧 `稿定-v2.14.0.zip` 已清理

**待浏览器复测**：快捷键 tab 自定义/禁用/冲突提示/恢复默认；改绑后 补全/换说法/AI/快捷键面板/差异跳转 按新键位生效；`?` 原绑定移除后不再误弹。

### v2.15.0 · 代码质量优化（静态分析专项）

> 不升版本、不出包；本轮为 **v2.15.0 全量源码的静态分析 + 质量优化**（另一个会话审查落地）。不改功能入口，浏览器回归结论沿用 `BUG_REPORT.md`（v2.13.1 复测通过）。

**本轮改动**
- **Bug 修复**：
  - `hotkeys.js` `?` 快捷键在真实键盘失效（v2.15 回归）：`matches` 严格比较 `!!e.shiftKey === !!c.shift`，而默认 `shortcut_panel: { key: "?" }` 是 `shift:false`——真实键盘 `?` 就是 `Shift+/`（`shiftKey:true`）→ 永不命中。修：新增 `isShiftSensitive(key)`（字母/数字/空格/方向键/功能键严格区分 shift，**标点符号键忽略 shift**，因字符本身已编码 shift 语义），并抽公共 `comboEq(a,b)` 供 `matches` 与 `conflictOf` 共用，杜绝口径漂移。`full-flow-test.js` HK1 增断言：`actionFor(evt("?", {shift:true})) === "shortcut_panel"`（模拟真实 Shift+/）、`comboEq` 功能键 shift 严格区分（Ctrl+Enter ≠ Ctrl+Shift+Enter）、标点键忽略 shift。
  - `editor.js` 素材台搜索双监听：`el("mat-search")` 同时挂「即时 `refreshMaterial()`」与「150ms 防抖 `refreshMaterial()`」（309/487 行并存，v2.13 起存在）→ 每次输入渲染两次。删掉即时监听，只留防抖。
- **一致性 / 维护性**：
  - `store.js` `defaultSettings` 补 `hotkeys: {}`；legacy 迁移分支同步补 `hotkeys: (d.hotkeys && typeof d.hotkeys === "object") ? d.hotkeys : {}`（读侧 `|| {}` 兜底保留，纯补缺省语义）。
  - `hotkeys.js` return 增 `comboEq` / `isShiftSensitive`（供测试断言复用）。
- **文档**：`功能简介.md` 分享版本引用核对（dist 已 v2.15.0）。

**回归结果（全部通过）**
- `node --check`：23 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（含 HK1 新增 `?`-shift / comboEq 用例、HK2/HK3 键位回归）
- 未跑 `pack.js`（本轮不升版、不出包；已在 **v2.15.1** 重打并纳入全部修复，见 v2.15.1 条目）

**遗留风险（本次未改，记录待后续处理）**
- **标点键忽略 shift 的取舍**：`?`/`!`/`/` 等标点键绑定不区分 shift 状态（`?` 与 `Shift+?` 视为同一键）。这是为兼容多布局键盘（`?` 在不同布局物理组合不同）的主动取舍；若某用户确需「标点键也区分 shift」，需引入布局检测，待产品决策。
- **`mdoutline.js` F-06 大纲进度以标题为 key**：同名章节标题共享进度状态（v2.14 起，边缘场景），未改。
- 测试桩缺口 `makeEl.setAttribute()` 为空实现但 `getAttribute()` 读 `dataset`——沿用 TESTING.md §8 记录，未改。

### v2.14.0（快捷键修复 + 体验/功能批增）
**本轮改动**
- **P0 Bug 修复**：
  - **BUG-001**（`BUG_REPORT.md`）：`Ctrl+Shift+Enter` 换说法失效 → `editor.js` `onKeydown` 的 `Ctrl+Enter` 分支补 `!e.shiftKey`，让组合键落到 `doReplace`。
  - **顺带修复**：`#btn-replace` 换说法按钮点击后弹窗瞬间消失——click 未 `stopPropagation`，冒泡到 document 的 `hideSuggest` 把刚弹出的候选关掉（与 BUG-002 同根）。改 `stopPropagation + doReplace`。
- **体验观察 N-02~06**：
  - N-02 换说法弹窗与补全区分：`showSuggest` 增 `title` 参数，`doReplace` 传「替换「选区」为：」，`renderPopup` 渲染 `.sug-mode` 标题行 + hint 改「Enter 替换」。
  - N-03 情绪「最近使用」分组突出：`.emo-group.recent` 高亮 + 「最近」徽标。
  - N-04 流式感知：`.ai-live/.af-live` 加 `::after` 闪烁光标（`▌`）。
  - N-05 反AI 批量修复：`#problems-fix-all` 一键替换所有可自动替换的 T1 项（`applyAllFixes`，按 start 降序防 offset 漂移）。
  - N-06 差异行快捷操作：并入 F-01（`.mline` hover「采纳」）。
- **功能新增 F-01~08**：
  - F-01 diff 差异「采纳此句 → 定稿区」：`appendLine` 给 `m-ins/m-inline` 行加 `data-adopt`（新版文本），hover 按钮 → `Editor.sendText`。
  - F-02 AI「全部插入」：结果区加 `data-ai-ins-all` / `data-af-ins-all` → `insertAll()` 首版替换选区、其余末尾追加。
  - F-03 快捷键总览：`?` 弹出 `#shortcut-modal`，Esc/关闭按钮可关。
  - F-04 词库星标收藏：`settings.starred`；素材台词汇/黄金句条目星标按钮（document 委托处理，`onMaterialClick` 只挡误判）；收藏词补全置顶 + 素材台排序置顶。
  - F-05 反AI 报告导出：`#problems-export` → `exportProblemsReport` 生成 md（行:列 · 级别 · 信息 · 建议 · 上下文）下载。
  - F-06 大纲写作进度：`meta` 存 `outline-progress-<docId>`；大纲树节点状态徽标（待写→写中→已写 循环点击）；送定稿自动标「已写」。
  - F-07 备份版本化：备份文件名 `稿定备份-YYYYMMDDHHmm.zip`。
  - F-08 定稿自动保存：textarea `blur` 即 `saveNow()` + `setInterval(30s)` 兜底（`saveDraft/loadDraft` 已有）。
- **测试补强**：
  - `full-flow-test.js` `makeEl.fire` 尊重 `stopPropagation`（此前冒泡到 document 永不停止，与真实浏览器语义不符——B3/M6b 换说法路径暴露）。
  - `makeEl.keydown` 支持 `{ctrlKey, shiftKey, metaKey}` 组合（M6b 回归 BUG-001）。
  - 种子补全：`BANK_BUNDLE.lexicon/golden` 写入 store 再 rebuild（此前定义未入库，byEmotion/@搜索/换说法 全空）。
  - 新增流程：M6b（快捷键分流）、F2（批量插入）、V1（diff 采纳）、V2（换说法标题）、V3（`?` 面板）、V4（星标）、V5（大纲进度）、V6（导出/备份点击）。

**回归结果（全部通过）**
- `node --check`：22 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（含 M6b / F2 / V1~V6）
- 打包：`dist/稿定-v2.14.0.zip`（含全部改动 + banks/），旧 `稿定-v2.13.1.zip` 已清理

**待浏览器复测**：`Ctrl+Shift+Enter` 换说法、换说法按钮弹窗持续显示、diff 采纳、AI 全部插入、`?` 快捷键面板、词库星标、大纲进度徽标、备份文件名时间戳、定稿失焦/定时自动保存。

### v2.14.0 · 代码质量优化（静态分析专项）

> 不升版本、不出包；本轮为 **v2.14.0 全量源码的二次静态分析 + 质量优化**（另一个会话审查落地）。不改功能入口，浏览器回归结论沿用 `BUG_REPORT.md`（v2.13.1 复测通过）。

**本轮改动**
- **Bug 修复**：
  - `mdoutline.js` `renderTree` / `renderFiltered`：`countSections(node)` 的「缓存变量 `sec`」成为死代码，下一行三元仍调用 2 次 → 每节点算 3 次。改为三元用 `sec`，恢复单次计算。
  - `editor.js` `?` 快捷键与正文输入冲突：`onKeydown` 绑在 `#editor-ta`，`e.key === "?"` 会 `preventDefault` → 正文打半角问号即弹快捷键面板且字符进不去。改为 **document 级 keydown** 处理（焦点在 INPUT/TEXTAREA/SELECT/contenteditable 时不响应），Esc 关闭面板同步提到 document 级；`full-flow-test.js` V3 用例改为「正文内按 `?` 不弹 / 非输入焦点按 `?` 才弹」。
  - `editor.js` F-08 30s 自动保存无脏检查：`setInterval` 每 30s 无条件写 IndexedDB。加 `lastSavedText` 脏标记，`scheduleSave`/`saveNow` 落盘时记录，interval 只在文本变化时写。
  - `editor.js` `applyAllFixes` 回退路径与 `applyProblemFix`/`insertText` 不一致：`setRangeText` 后补 `dispatchEvent(new Event("input", { bubbles: true }))`。
- **一致性 / 性能**：
  - `store.js` `defaultSettings` 补 `starred: []`、`recentEmos: []`（读侧 `|| []` 防御已存在，补缺省使 `migrateSettings` 语义完整；legacy 迁移分支同步补）。
  - `editor.js` `renderMaterialTab` 收藏排序改一次性 `Set`（比较器内反复 `isStarred→starredWords→getSettings` 的 O(n²) 读）。
  - `editor-ai.js` 删 106-110 行重构残留空注释。
- **文档**：`功能简介.md` 分享版本引用 v2.13.0 → v2.14.0。

**回归结果（全部通过）**
- `node --check`：22 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（含改造后的 V3 `?` 用例）
- 未跑 `pack.js`（本轮不升版、不出包，`dist/稿定-v2.14.0.zip` 保持不变）

**遗留风险（本次未改，记录待后续处理）**
- **`?` 快捷键改为 document 级后**：焦点不在输入类元素时才响应——在标题栏/空白区按 `?` 可弹面板，但「在其它自定义输入框/弹窗内按 `?` 看快捷键」不可用。这是取舍（避免吞问号），如需「任何地方都能按 `?`」，可改 `Ctrl+/` 双快捷键，待产品决策。
- **`applyAllFixes` 一键替换后无撤销**：`document.execCommand("insertText")` 走撤销栈可 `Ctrl+Z`，但 `setRangeText` 回退路径不进撤销栈（与 `applyProblemFix` 现状一致）；一键替换涉及多处，单次 `Ctrl+Z` 只能撤最后一处，未做批量撤销事务。
- 测试桩缺口 `makeEl.setAttribute()` 为空实现但 `getAttribute()` 读 `dataset`——沿用 TESTING.md §8 记录，未改。

### v2.13.1（CSS 冲突修复 + 出包收口）
**本轮改动**
- **CSS 类名复用冲突修复**（解决 v2.13.0·代码质量优化 标记的遗留风险）：`style.css` 按钮基类 `.m-ins/.m-del/.m-copy` 收窄为 `button.m-ins/.m-del/.m-copy` —— 合并 diff 行的 `div.mline.m-del/m-ins` 与全站按钮同名，按钮规则的边框/背景/内边距会污染 diff 行。改为元素限定后天然隔离，纯 CSS 改动、无 JS/测试变更。
- **出包收口**：上一轮「v2.13.0·代码质量优化」只改源码未重打 zip（`dist/稿定-v2.13.0.zip` 仍是不含 3 个真实修复的旧包）。本轮 `manifest.json` 升 **2.13.1** 并重打 `dist/稿定-v2.13.1.zip`，zip 纳入：静态分析的 3 个真实修复（`llm.js` `streamChat` 强制 `stream:true`、`editor.js` `startAiReplace` 流式分支补 `opts.stream` + string/array 兼容、`store.js` `snapshot()` 剔除 `secret` 表）+ 本轮的 CSS 冲突修复。

**回归结果（全部通过）**
- `node --check`：22 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无
- 打包：`dist/稿定-v2.13.1.zip`（含全部修复 + banks/），旧 `稿定-v2.13.0.zip` 已清理

**待浏览器复测**：AI 真逐字流式（agent 路径）、换说法开流式出多条、diff 视图删/增行样式、备份 zip 不含 API Key。

### v2.13.0（Bug 修复 + 体验优化收尾）
**本轮改动**
- **P0 Bug 修复**（对应 `BUG_REPORT.md`）：
  - BUG-001：`editor-ai.js` return 对象补导出 `syncAiEmo`（连同未导出的 `syncAiCfgFromUI` 一并补上，`editor.js:143/193` 不再抛 `TypeError`）。
  - BUG-002：「补全」候选 150ms 自动消失 → `editor.js` 给 `#btn-suggest` 加 `mousedown → preventDefault()` 防夺焦（与 `#sel-toolbar` 同款，避免 blur 定时器关掉刚弹出的候选）。
  - BUG-003：定稿区最大化后还原按钮被标题栏盖住 → `style.css` `#dock.maxed` 的 `z-index: 20 → 40`（高于 `#title-bar:30`、低于 modal:200+）；`body.compare-maxed #panes` 保持 25 不动（其退出入口本就在标题栏）。
  - BUG-004：流式输出空出稿 → `llm.js` 双修：① `buildBody()` 补 `stream: !!opts.stream`（请求体缺失导致服务端返回非 SSE）；② `streamChat()` 加兜底——content-type 为 JSON 时直接 `res.json()` 解析，或全程无 `data:` 行时把收满原文当 JSON 解析并 `onDelta` 一次。
- **UX 优化**（对应 `UX_REPORT.md`，UX-01~16 全部落地）：
  - UX-01 AI 面板与正文同屏（`show-ai` 时分栏，紧凑/侧边栏模式仍全宽替换）；UX-02 随 BUG-002 回归；UX-03 流式失败可诊断（`llm.js` 描述性报错 + `agent.js` 空产出写检索日志）。
  - UX-04 对比区清空/重选二次确认；UX-05 栏数变化重排 toast；UX-06 批量 md 保存 loading 态（bankmanager/loremanager）；UX-07 情绪选择器搜索 + 最近使用置顶（`recentEmos` 持久化）；UX-08 大纲树搜索命中 `<mark>` 高亮。
  - UX-09 AI 历史按任务类型筛选 + 关键词搜索 + 清空确认；UX-10 设置未保存改动关闭确认；UX-11 素材台首次默认收起、之后记忆；UX-13 toast 队列（连续操作不吞提示）；UX-14 AI 结果删除二次确认；UX-15 下载类操作统一 toast；UX-16 空稿状态提示去重。
- **测试补强**：`test-llm.js` 新增「流式请求体含 `stream:true`」「非 SSE JSON 兜底解析」；`full-flow-test.js` 新增 M4b（`EditorAi.syncAiEmo` / `syncAiCfgFromUI` 导出回归）。

**回归结果（全部通过）**
- `node --check`：22 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（21 模块，含 M4b 回归）
- 打包：`dist/稿定-v2.13.0.zip`（含全部改动文件 + banks/），旧版已清理

### v2.13.0 · 代码质量优化（静态分析专项）

> 不升版本、不出包；本轮为**代码静态分析 + 质量优化**，由另一个会话对 v2.13.0 全量源码审查后落地。不改功能入口，浏览器回归结论沿用 `BUG_REPORT.md`（v2.13.0 通过）。

**本轮改动**
- **Bug 修复**：
  - `llm.js`：`streamChat` 请求体**强制 `stream:true`**（此前依赖调用方传 `opts.stream`，而 `agent.js` 调 `streamChat` 时未传 → 服务端返回完整 JSON、只走兜底解析，非真 SSE 逐字流；修复后流式真正生效）。
  - `editor.js` `startAiReplace`：流式分支补 `opts.stream = true`（此前漏设 → `rewriteSelection` 永远走非流式 `chat()`，`.then` 里对**数组**再 `splitVersions` 造成逗号拼接成单条错乱）；`.then` 兼容 string（流式）/ array（非流式）。
  - `store.js` `snapshot()`：剔除 `secret` 表（存明文 API Key，此前快照会带出；备份 zip 当时未泄漏，属潜伏风险）。
- **DRY / 一致性**：
  - `esc` 收口 `U.esc`（`app.js` 删本地实现补齐 `"` 转义；`mdoutline.js` `Md.esc` 引 `U.esc`；`modelpicker.js` 删后置局部 `const esc`、前置到 IIFE 顶部，消除「先 use 后声明」次序脆弱）。
  - `app.js` 删本地 `readFile` 改用 `U.readText`。
  - `editor.js` 提取 `mirrorCss()` 供 `caretCoords` / `caretCoordsAt` 共用（此前 15 行 CSS 构建重复两份）。
  - `llm.js` `activeModelOf` 改复用 `Store.activeModel`（同一逻辑单点，消除双份漂移；`test-llm.js` mock 同步补 `activeModel`）。
  - `editor.js` 删冗余三元 `const main = isFav ? e.word : e.word`。
  - `constants.js` `window.C` 加 `typeof window` 守卫（与其它模块一致，Node 直 require 不炸）。
- **维护性优化**：
  - `lint.js` 句式正则预编译（`PATTERN_RX`，scan 内复用并重置 `lastIndex`，不再每次 `new RegExp`）。
  - `agent.js` `buildLore` 裁剪段重写：去掉 `charLines.length = 0` + `push.apply` 反直觉写法，改 `let` 重建 + 数组展开，语义不变。
  - `mdoutline.js` `renderTree` / `renderFiltered` 的 `countSections(node)` 每节点只算一次。

**回归结果（全部通过）**
- `node --check`：22 个 js 全通过
- 单元测试：store 32 / llm 16 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 142）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无
- 未跑 `pack.js`（本轮不升版、不出包；已在 **v2.13.1** 重打并纳入全部修复，见 v2.13.1 条目）

**遗留风险（v2.13.1 已解决 / 记录待后续处理）**
- ✅ **CSS 类名复用冲突**（已在 v2.13.1 修复）：`.m-ins` / `.m-del` 同时用作「合并 diff 行」（`app.js` `appendLine` 输出 `div.mline.m-del`）与「全站按钮」。修复方式：`style.css` 按钮基类加 `button.` 元素限定，diff 行（div）天然隔离。**需浏览器级视觉验证 diff 视图**。
- **测试桩缺口**：`full-flow-test.js` 的 `makeEl.setAttribute()` 为空实现但 `getAttribute()` 读 `dataset`——动态 `setAttribute` 的值不会反映到 `getAttribute`。属测试桩特性（已由 TESTING.md §8 归档），不影响应用代码，未改。
- `BUG_REPORT.md` 已被浏览器测试会话重写为 v2.13.0 回归通过报告，本轮无新增 bug 可记；`TESTING_BROWSER.md`（真实浏览器测试技术文档）不动。

### v2.12.0（架构拆分 + 优化收尾）
**本轮改动**
- **AI 面板拆分**：`js/editor-ai.js`（AI 面板 / 浮动结果卡 / 历史 / 钉选 / 关键词重跑 / 快捷键分发）从 editor.js 拆出（editor.js 2453→1384 行），复用 `Editor._` 内部桥；core 的 bind/onKeydown/onInput 改调 `EditorAi.*`。
- **通用弹窗**：`js/ui.js`（modal 开关 / 三选 choice）；loremanager 导入去重、lore/bank 分类弹窗复用。
- **常量**：`js/constants.js`（防抖/自动保存/toast 时长），editor/app 的魔法数字收敛。
- **性能**：`buildLore` 全字段打分加对象级缓存（`lore:changed` 时失效）。
- **错误分级**：存储读写关键路径补 `console.warn`（saveState/loadState/前文库/大纲加载）。
- **解析修复**：设定模板标签带空格（`功能 / 效果`）解析归一化，保证 md 往返（`test-banks` 锁定）。
- **测试补强**：新增 `test-banks.js`（17）/ `test-lint.js`（8）；full-flow 补 B5 备份 / B6 反AI T1 替换 / B7 大纲送定稿+加前文库（19 模块）。
- **说明**：app.js 对比区拆分（compare.js）**延后**——主视图 + 顶层作用域 + Node 模块作用域无法共享 shell 状态，盲拆回归风险高，按「逐步+回退」纪律留待浏览器级验证专项。

**回归结果（全部通过）**
- `node --check`：22 个 js 全通过
- 单元测试：store 32 / llm 12 / agent 51 / mdoutline 18 / banks 17 / lint 8（共 138）
- `validate-banks`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（19 模块，含 B5/B6/B7）
- 打包：`dist/稿定-v2.12.0.zip`（含 editor-ai/ui/constants + banks/），旧版已清理

### v2.11.0（Phase 2 · 上帝对象拆分第一步）
- **`js/editor-settings.js` 拆分**：设置面板 / Provider 管理 / 自定义 Agent 从 `editor.js`（2453→1955 行）拆出为独立模块，复用 `Editor._` 内部桥（`renderAiMenuModels/renderAiTasks/applyEditorFont/scheduleLint/setAutoSuggest` 等）；`editor.js` 的 bind/点击委托改调 `EditorSettings.*`。
- 说明：AI 面板 / app.js 对比区与编辑器键盘、选区工具条、输入处理深度耦合，且 Node 桩无法验证选区/键盘 UX 路径——**暂留 `editor.js`/`app.js`**，待浏览器级验证的专项再做（避免盲拆引入回归）。
- 回归：`node --check` 18 文件、单测 store 32 / llm 12 / agent 51 / mdoutline 18、full-flow 0 异常 0 缺失ID（18 模块）；打包 `dist/稿定-v2.11.0.zip`。

### v2.10.0（架构重构 + 存储层修复）
**本轮改动（架构工程化）**
- **存储层根因修复**：`store.js` 不再硬编码 DB 版本号，`open()` 改为无版本打开 + 缺表「当前版本+1」自愈 → 修复此前「库升到 v3 后重载抛 VersionError，词库/大纲导入/前文库/备份全挂」。
- **高可用**：`BankLoader.init()` 容错初始化，存储失败也走完 `Editor.setData()` 并明确提示。
- **DRY 重构**：新增 `js/util.js`（esc/toast/readText/download/copyText/uid），消灭 6 个文件的重复实现；store 名字集中为 `Store.stores()`/`allStores()`/`snapshot()`，备份改由 Store 驱动（顺带修复 `docs` 大纲文档漏进备份）。
- **解耦**：新增 `js/bus.js`（pub/sub）+ `js/appstate.js`（共享数据单例），用 `AppState.setLore/setLibrary` 替换 `window.BankData/LibData/LibIndex` 可变全局；生产者/消费者解耦，删除硬编码 settings key。
- **小修**：AI 选区工具条 `editorFocused` mousedown 加固；大纲送定稿标题 `#` 前缀 off-by-one 修正。
- 新表/新模块一律纳入 `index.html`、`pack.js`、`full-flow order`。

**回归结果（全部通过）**
- `node --check`：17 个 js 全通过
- 单元测试：`test-store` 32 / `test-llm` 12 / `test-agent` 51 / `test-mdoutline` 18（共 113）
- `tools/validate-banks.js`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无（新增 Y1 大纲工作区流程）
- 打包：`dist/稿定-v2.10.0.zip`（含 util/bus/appstate/mdoutline + banks/），旧版已清理

### v2.9.0（2026-08-12）
**本轮改动**
- AI 润色 UX：选区浮动工具条修复（editor-wrap 相对定位、测量不再改动选区、拖动/焦点守卫、按钮不夺焦）；浮动结果卡；Alt+P/E/R 快捷键；面板目标区常驻与注入清单透明；关键词可编辑重跑；前文命中钉选/排除；T1 一键替换；AI 历史持久化。
- 设定面板：13 分类专属表单 + 自定义字段（分类级 `catExtra` / 条目级 `extra`，md 往返无损）；分类管理（`loreCats` 增删改排序 + 模板字段 + 计数徽标）；全局搜索；导入去重；复制条目；`buildLore` 全字段相关度注入。
- 大纲/阅读工作区：新增 `js/mdoutline.js`（块解析 + 行内渲染 + 大纲树）；`docs` 表；对比/大纲模式切换；送定稿 / 加前文库联动。
- 对比区：工具栏「导出差异报告」；前文库段落级搜索定位；反AI检查/素材台/定稿区折叠记忆；备份导出 zip。

**回归结果（全部通过）**
- `node --check`：14 个 js 全通过
- 单元测试：`test-store` 30 / `test-llm` 12 / `test-agent` 51 / `test-mdoutline` 18（共 111）
- `tools/validate-banks.js`：序列化往返 true
- `full-flow-test.js`：全部异常数 0、缺失ID 无
- 打包：`dist/稿定-v2.9.0.zip`（含 `js/mdoutline.js` 与 banks/），旧版 zip 已清理
