# 剧情编辑器 — Agent 工作记忆

## 部署模型（2026-08-26 确认）

- 正式版：GitHub Pages 托管 **master 分支根目录** → `https://jigugumiao.github.io/jiji_text_game_editor/`。仓库无 gh CLI，验证部署用 PowerShell Invoke-WebRequest 探测。
- 测试版：**只把 `python build_inline.py --test` 的产物放进 master 的 `beta/` 子目录**（自包含单文件 + docs.html），URL 不同→浏览器缓存分离；页面注入 `window.STORY_EDITOR_NS='test'` → localStorage/IndexedDB 与正式版完全隔离（storage.js 支持该前缀）。AI 设置（storyeditor:ai:*）与主题偏好仍共享（有意为之）。
- 重构类源码改动走独立分支验收，不直接改 master。当前主线验收分支：`feature/agent`（Agent 对话：纯前端 DeepSeek 工具调用循环，已合并 `feature/story-vars` 变量系统，测试版 v25.4.95-TEST 起两者并存）。

## 变量系统架构（2026-08-26 重构后，已并入 feature/agent）

**单一事实源：`js/story-vars.js`（window.StoryVars / module.exports）。**

- 正文 `<变量:...>` 的解析/序列化、类型转换、条件表达式求值、`{名}` 插值、静态分析（analyze）全部只在这一份实现里。
- **禁止**在 editor.js / exporter.js 里再写本地的变量正则或求值逻辑（历史 bug 全部源于三份手工同步的解析器分叉）。
- 导出端 `parseStoryForExport` 调用 `StoryVars.parseVarLine`；导出游戏的运行时由 `buildRuntimeHTML` 把 `StoryVars.buildRuntimeSource()` 序列化注入模板占位符。

### 改动变量逻辑时的硬性规则

1. 只改 `js/story-vars.js`，两端自动同源；改完必须跑 `node tests/var-conformance.test.js` + `node tests/story-vars.test.js`。
2. `RUNTIME_FNS` 里的函数会被 `Function.prototype.toString()` 序列化进导出 HTML——**必须是具名函数声明且不引用任何模块级闭包变量**（模块级常量要内联进函数体）。
3. exporter.js 里 `__STORY_VARS_RUNTIME__` 占位符用 `.replace()`（只换第一处），**注释里绝不能复述这个占位符字面量**，否则注入位置错乱。tests/var-conformance.test.js 有断言防护（恰好出现 2 次）。
4. 注入源码含 `$` 字符风险：replace 必须用函数形式的 replacement（已如此实现）。
5. index.html 加了新脚本/改了 js/css 后：同步 bump `?v=` 缓存标识和 `app-version`，并更新 `tests/release-cache-bust.test.js`（它断言精确版本串）。

### 语法语义速查（权威定义在 story-vars.js 头注释）

- 读 `{名}` / `{名:真文案|假文案}`（仅布尔）/ `{{名}}` 转义
- 写 `<变量:名=值>`（值可含空格可空）；一行多标签 `<变量:a=1><变量:b=2>`；单标签内兼容旧版 `;` 分隔
- 条件 `条件:表达式` 支持 `&& || ! ()` 与比较运算，优先级 `|| < && < !`；字符串值加引号；旧写法 `=` 等价 `==`
- 无法识别的 `<变量:...>` 行按普通文本保留（编辑器与导出端行为一致）

### 修复检查器（给老用户的迁移工具）

入口：素材库 → 变量库 →「修复检查」按钮。扫描主剧情+全部剧情块，问题类型：
`undeclared_write`（未声明赋值，附错别字改名建议）/ `undeclared_read` / `malformed_tag` / `cond_parse_error` / `type_mismatch` / info 级 `never_written`、`dead_var`。
校验器 validateStory 只展示 error/warning；info 级只在修复面板显示。「忽略」为会话级。

## Agent 对话（2026-09-11 上线，feature/agent 主线）

- 入口：AI 菜单 →「Agent 对话（新功能，耗费可能较高）」。纯前端、DeepSeek API、可读写正文/变量/素材/创作设定/外观。
- 架构：js/agent.js（window.Agent + module.exports）意图路由→场景装配→工具调用循环（≤8 轮，thinking 仅意图轮 disabled）；5 场景 polish/rewrite/design/vars/general；28 工具 5 组（文档读写+结构+创作辅助+素材元数据+变量+设置/外观）。
- 分级写入：auto（≤500 字非整块）直接落盘可撤销；preview（>500 或整块）diff 卡确认；destructive（删除类）二次确认对话框。undoWrite + pushHistory 保证撤销。
- 多对话：`agent-convs:<pid>` 对话列表（cap 30 条，`agent-current:<pid>` 记当前 id；旧 `agent-history:<pid>` 首次访问自动迁移为一条）；单对话历史 cap 50 条；早期对话超 30000 字符自动摘要压缩（classifyHistoryCompression + search_history 归档检索 `agent-history-archive:<pid>`）；上下文总字符 >30000 时显示弱提醒推荐新建对话。
- 修改 Agent 逻辑后必跑：`node tests/agent.test.js` + `node tests/ai-tools.test.js`（agent.js 工具的 localStorage stub 约定见测试文件头）。
- 文档：docs/agent-design.md（完整设计 14 节）。

## 可视化剧情状态编辑器（2026-08-27 开发，codex/visual-story-state 分支；2026-09-13 并入 feature/agent）

- 入口：编辑器顶部「可视化编辑 / 源码模式」切换按钮。选项语法唯一事实源是 `js/story-options.js`；`editor.js` 与 `exporter.js` 只能调用它。导出运行时由 `StoryOptions.buildRuntimeSource()` 注入。
- 可视化模式必须通过 `StoryVisualDoc` 的原始 span 局部替换；切换模式和未编辑内容不得格式化或丢弃未知字段。
- 旧项目转换（「转换为可视化项目」）只能复制到临时项目、校验、最后登记；源项目和当前项目指针不得在失败或成功前被改写。新项目写入 `visualEditorVersion:1` 与 `convertedFrom`。`js/project-converter.js` 是转换服务。
- 变更选项/可视化 UI/转换逻辑后至少运行对应 focused test（story-options / story-visual-doc / visual-story-ui / project-converter / visual-options-runtime / story-state-management / context-menu-variable）、`tests/release-cache-bust.test.js` 与完整 `tests/*.test.js`；改动前端资源必须同步更新 `?v=` 与两个版本展示。

## Galgame 九宫格对话框背景（2026-08-29 开发，codex/galgame-nine-slice-impl 分支；2026-09-17 并入 feature/agent 恢复）

- 入口：设置 → 外观 →「Galgame 对话框背景」区块（开关「使用图片对话框」+「管理图片预设」按钮）。仅 galgame 游玩模式生效；未启用时回退到底框色/透明度。
- 架构：`js/galgame-dialogue.js`（window.GalgameDialogue：normalizeSlices / createSnapshot / serializePreset / parsePreset / BUILTIN_PRESETS 四款内置）；存储走 `js/storage.js` 的 `saveDialoguePreset` / `getAllDialoguePresets` / `deleteDialoguePreset` / `renameDialoguePreset`（IndexedDB STORE_META，`dialogue-preset:` key + `_editorNamespace()` 按 test NS 隔离，预设全局不随项目切换）；项目保存完整快照（`appearance.galPanel`，含 imageSrc/imageWidth/imageHeight/slices/enabled），不引用全局预设 ID。
- 运行时：exporter.js 的 `applyGalPanelAppearance(APPEAR.galPanel)` 校验图片尺寸与切片后设 `--gal-panel-*` CSS 变量，`body.galgame.gal-panel-image #message-list` 用 border-image 九宫格拉伸。
- 曾被 v25.4.88（5dc4173）覆盖 beta 时一并删除（与可视化编辑同因：功能在 codex 分支、从未进主线）。教训见「多工具并行开发分叉」。
- 测试：galgame-dialogue / galgame-dialogue-editor / galgame-dialogue-runtime / dialogue-preset-storage。测试断言 editor.js 的 `escapeHtml` 必须恰好 1 处且含 `'`→`&#39;` 转义；`DEFAULT_APPEARANCE` 必须含 `galPanel: null`。

## 注意

- `dist/`、`dist-test/` 是构建产物，已 gitignore；要更新线上 beta 页面时把 dist-test 内容拷贝到 `beta/` 提交推送即可。
- tests/*.test.js 用 Node 直跑，无依赖；改动 js 后跑一遍全部测试 + 更新 index.html 的 `?v=` 缓存标识与 app-version（tests/release-cache-bust.test.js 断言精确版本串）。
- 测试清单：agent / ai-tools / clearoverlay-editor / clearoverlay-runtime / no-blocking-google-fonts / option-condition / project-converter / regression-string-raw-template / release-cache-bust / story-options / story-state-management / story-vars / story-visual-doc / var-conformance / visual-options-runtime / visual-story-ui。

## 已知陷阱（踩过的坑，防复发）

### String.raw 模板内禁止裸写 `</script>`（v25.4.109 修复，2026-09-13）

**症状**：beta 试玩/导出永久卡「加载：0.00 / 0.00 MB」，下载的导出 HTML 用浏览器/Node 解析报 `Unexpected token '<'`，整个运行时脚本一行不执行（preloadAll 从未运行）。

**根因链**：
1. `build_inline.py` 内联 JS 时执行 `js.replace("</script>", "<\\/script>")`（build_inline.py:59），防 HTML 解析器提前截断外层 `<script>` 块。
2. 普通 JS 字符串字面量里 `"<\/script>"` 会被 JS 引擎还原为 `</script>`，**无碍**。
3. 但 `js/exporter.js` 的 `RUNTIME_TEMPLATE` / `ITEM_VIEWER_WRAP` 是 **`String.raw` 模板——不处理转义**，`<\/script>` 变成字面反斜杠保留下来。
4. 云端用被替换坏的模板生成试玩/导出 HTML → 输出 `<\/script>` 而非 `</script>` → HTML 解析器不认（只认精确 `</script`）→ `<script>` 块吞到文件尾 → 语法错误 → 脚本全废。

**已修复**（exporter.js 三处，L464/L467/L2495）：模板内结束标签必须写成模板插值 `${'</scr' + 'ipt>'}`（运行时求值得回 `</script>`，且 build_inline 的字符串替换不会命中它）。**禁止改回裸 `</script>` 或 `\<\/script>`**。

**历史复发**：v25.4.81（9337397）曾在 beta/index.html 手工补丁同样位置，但补丁只打在构建产物、未进源码；v25.4.95 改用 build_inline.py 自动构建后补丁被覆盖丢失，坑复发（v25.4.108→v25.4.109 才在源码层修复）。**教训：这类模板转义修复必须改源码 + 加防回归断言，不能只打产物补丁。**

**防回归**：改 exporter.js 模板时，构建后用 `node -e` 或脚本断言 dist-test/index.html 中 `String.raw` 模板内不存在字面 `<\\/script>`，且 `${'</scr' + 'ipt>'}` 恰好 3 处。

### 云 beta 构建产物 ≠ 源码（手工补丁会被覆盖）

- master 分支 `beta/` 是 `build_inline.py --test` 的构建产物（dist-test/），**每次重新构建都会从源码重新生成**。
- 任何只改 `beta/index.html` 的修复，下次构建即丢失——**修复必须落在 `js/*.js`、`index.html`、`build_inline.py` 源码**，再重新构建发布。
- 云端 beta 与本地源码分叉检测：下载 `https://jigugumiao.github.io/jiji_text_game_editor/beta/` 检查版本号与关键修复特征（如 `${'</scr' + 'ipt>'}` 数量）。

### 多工具并行开发分叉（2026-09-13 约定，防再分叉）

- 教训：Codex 在 codex/* 分支开发可视化编辑、DSH 在 feature/agent 开发 Agent 对话，两线从 v25.4.60 起长期并行，可视化功能从未合入主线，v25.4.88 发布 Agent 版 beta 时把可视化构建产物覆盖掉，功能"消失"半年（实为从未进主线）。
- **约定：所有新功能无论哪个 AI 工具（Codex/DSH/其他）开发，统一以 `feature/agent` 为共同主线，开发分支完成即合并进 feature/agent，不得长期分叉；发布 beta 只从 feature/agent 构建。**
