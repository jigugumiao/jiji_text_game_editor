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

## 注意

- `dist/`、`dist-test/` 是构建产物，已 gitignore；要更新线上 beta 页面时把 dist-test 内容拷贝到 `beta/` 提交推送即可。
- tests/*.test.js 用 Node 直跑，无依赖；改动 js 后跑一遍全部测试 + 更新 index.html 的 `?v=` 缓存标识与 app-version（tests/release-cache-bust.test.js 断言精确版本串）。
- 测试清单：agent / ai-tools / clearoverlay-editor / clearoverlay-runtime / no-blocking-google-fonts / option-condition / release-cache-bust / story-vars / var-conformance。
