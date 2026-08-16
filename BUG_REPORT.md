# 稿定 v2.13.1 · 浏览器复测报告（静态分析修复验证 + 新 Bug）

> 生成时间：2026/8/13
> 测试方式：Playwright 驱动本机 Chrome，通过本地静态服务打开 `index.html`，以真人用户路径逐区操作（对比/大纲/定稿/素材台/反AI/词库/设置/设定/前文库/AI/持久化）。
> 全程捕获 console.error / 未捕获异常 / 网络失败，并断言 UI 行为；AI 功能使用真实 DeepSeek API（deepseek-chat，含流式）端到端验证。
> 目的：复测另一个会话的**静态代码分析 + v2.13.1 修复**（`dist/稿定-v2.13.1.zip`），并顺带产出体验报告（`UX_REPORT.md`）。

---

## 结论

- **v2.13.1 的 4 项修复全部验证通过**（llm.js 强制流式 / editor.js 换说法流式 / store.js 备份剔 Key / CSS diff 隔离）。
- **全量浏览器回归**：脚本修复（AI 面板 waitFor 类名）后连续 2 次全绿（0 Bug），另有 1 次仅 DeepSeek API 偶发空响应（重试后正常，非产品缺陷）。
- **新发现 1 个真实 Bug**（BUG-001）：`Ctrl+Shift+Enter` 换说法快捷键失效——被 `Ctrl+Enter` 补全分支抢先匹配。

---

## 一、v2.13.1 静态分析修复验证

| 修复 | 验证方式 | 结果 |
|---|---|---|
| `llm.js` `streamChat` 强制 `stream:true` | 网络拦截确认请求体含 `stream:true`；响应为真 SSE；**body 长度逐字递增**（31→43→59→86→103→134→161→180→205→237→261→288→316） | ✅ 真逐字流式生效 |
| `editor.js` `startAiReplace` 流式分支 + string/array 兼容 | 开流式 → 选区 → 工具条「换说法」→ 弹「AI 改写中…」→ 出 **2 条 AI 整句改写**候选（不再逗号拼接错乱） | ✅ 出多条正常 |
| `store.js` `snapshot()` 剔除 secret 表 + providers key | 导出备份 zip → 解压检查 `settings.json`：**不含 API Key**、**不含 secret 表**；providers 段仅 base/model | ✅ 无泄漏 |
| `style.css` 按钮基类收窄 `button.m-ins/m-del/m-copy` | 行对比 → `getComputedStyle` 检查 `.mline.m-del`：`border:none`、`font-weight:400`（无按钮特征）、红底 `rgba(239,68,68,.1)` + 删除线 | ✅ diff 行样式隔离正确 |

---

## ✅ 修复状态（v2.14.0 已修复）

> 更新：2026/8/13 · BUG-001（Ctrl+Shift+Enter 换说法失效）已在 v2.14.0 修复：
> - `editor.js` `onKeydown` 的 `Ctrl+Enter` 分支补 `!e.shiftKey`，让 `Ctrl+Shift+Enter` 落到 `doReplace`。
> - 顺带修复同根问题：`#btn-replace` 按钮点击后弹窗被 document 的 `hideSuggest` 立即关闭 → 补 `stopPropagation`。
> - 回归：`full-flow-test.js` 新增 M6b 快捷键分流用例（词库种子已补全入库）。
> 详见 `TESTING.md` 第 9 节 v2.14.0。

---

## 二、新发现 Bug

## BUG-001 [严重] Ctrl+Shift+Enter 换说法快捷键失效（触发补全）

- **功能区**：定稿区 · 换说法
- **现象**：选中文字后按 `Ctrl+Shift+Enter`，期望弹出「换说法」候选，实际弹出的是**「补全」候选**（与 `Ctrl+Enter` 完全相同：25 条、含「对话」badge）。

- **复现步骤**：
  1. 打开 `index.html`，定稿区输入一段正文
  2. 选中部分文字（如「他站在原地，心中」0-12）
  3. 按 `Ctrl+Shift+Enter`
  4. 观察：弹出的是补全候选（含「对话」类词库），而非换说法候选

- **期望**：`Ctrl+Shift+Enter` 触发「换说法」（`doReplace`），弹出替换候选
- **实际**：触发的是「补全」（`openComplete`），候选与 `Ctrl+Enter` 完全相同

- **根因**（`js/editor.js:881-882`）：
  ```js
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { ... openComplete(); }            // ①
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Enter") { ... doReplace(); }  // ②
  ```
  ① 只检查 `ctrlKey && key==="Enter"`，**未排除 shiftKey** → `Ctrl+Shift+Enter` 也命中 ① → 走补全；② 分支不可达。

- **验证**：`dbg-step3b7.js` 干净环境对比——`Ctrl+Enter` 与 `Ctrl+Shift+Enter` 弹窗 25 条候选、badges、前 6 项**完全相同**（均含「对话」补全候选）。

- **修复建议**：① 加 `!e.shiftKey` 条件，即 `if ((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key === "Enter")`，让 `Ctrl+Shift+Enter` 落到 ②。

- **备注**：该 Bug 为 v2.12/v2.13.0/v2.13.1 均存在的老问题（快捷键优先级顺序），本次复测通过专项对比首次确认。`full-flow-test.js` 未覆盖键盘选区路径，故此前测试未暴露。

---

## 三、全量回归明细

| 功能区 | 覆盖 | 结果 |
|---|---|---|
| A 对比区 | 导入/基准/统计/字行/并排合并/栏数/版本下拉/设基准/高亮/跳转/悬停/复制/YAML/报告/粘贴/重命名/清空/重选 | ✅ |
| B 大纲区 | 切换/导入/树/折叠/搜索(mark)/全文/新建编辑/送定稿/加前文库/导出复制/删除 | ✅ |
| C 定稿区 | 字数/反AI+跳转/搜索/情绪(搜索+最近)/补全(持续)/换说法/自动补全/素材台/常用/送对比/导出复制/全屏 | ✅（除 C8b 快捷键 bug） |
| D 词库 | 4tab/搜索/新增/表单md/批量/导出/分类/格式/分页/fav/刷新 | ✅ |
| E 设置 | Provider/默认/拉取模型/测试连接/保存/Agent/自定义/规则/备份zip | ✅ |
| F 设定 | 分类/导入/全局搜索/新增/批量/分类管理/导出 | ✅ |
| G 前文库 | 导入/搜索/新建/清空 | ✅ |
| H AI | 面板/流式(强制)/润色/续写/扩写/重写/关键词/插入复制/素材/历史/日志/浮动卡/Alt+P | ✅（偶发 1 次 API 空响应，重试正常） |
| I 持久化 | 草稿/统计/折叠/AI设置/大纲 刷新保留 | ✅ |

> 说明：回归中偶发 DeepSeek `ERR_HTTP2_PING_FAILED` / 空响应（连续多次真实 API 调用后限流），脚本已加重试 + 网络抖动分级，判定为**环境/API 抖动**，非产品缺陷。

---

## 四、测试脚本校准记录（本次复测）

1. **AI 面板 waitFor 类名修正**：面板写作中类是 `.ai-item.ai-live`（非 `.af-live`，那是浮动卡的）。此前脚本用错类名导致「任务未完成就判定」假失败。修复后 H3/H9/H14 稳定。
2. **H14 浮动卡**：加失败重试一次 + 网络抖动分级。
3. **C8 换说法**：改用工具条按钮触发（可靠）；C8b 专项验证 Ctrl+Shift+Enter 快捷键。
4. **H9 任务循环**：每任务前确保 AI 面板 open（避免状态连坐）。

---

## 五、环境限制 / 未覆盖

- 「模式」菜单（侧边栏/小窗）为扩展专属，直接打开 `index.html` 时隐藏，未覆盖。
- 拖拽导入用合成 drop 事件模拟。
- 扩展专属能力（`chrome.sidePanel`/`chrome.windows`/图标打开）未测。
- `dist/稿定-v2.13.1.zip` 以扩展方式加载验证未做。
- 多浏览器（Edge）未跑。
