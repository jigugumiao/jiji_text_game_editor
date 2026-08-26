# 剧情编辑器 — Agent 工作记忆

## 变量系统架构（2026-08-26 重构后）

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
