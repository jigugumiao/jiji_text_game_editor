# Agent 对话（全能助理）设计文档

> 分支：`feature/agent`（从 master 切出，与待验收的 `feature/story-vars` 隔离）
> 状态：设计阶段 · 待用户审阅
> 更新：2026-09（初稿）

---

## 1. 目标与范围

### 1.1 目标
在剧情编辑器中新增一个**真正的 Agent**：纯前端运行、网页直接可用，与其他 AI 功能一样调用 DeepSeek API（复用 `storyeditor:ai:*` 设置）。区别于现有「全文助理」（一次性喂全文 + 审阅标记提案），Agent 采用**模型驱动的工具调用循环**：模型自主决定调用哪些本地 JS 工具（读块/搜索/写块/读写变量），浏览器执行、结果回填、循环直到最终答复。可**直接改稿**（追加/插入/替换正文、读写变量），带**分级确认**与**撤销**。

### 1.2 已确认的决策（用户拍板）
| 决策 | 内容 |
|---|---|
| Q1 入口 | 新增独立「Agent 对话」入口，与现有全文助理**并存验证**，成熟后再谈合并 |
| Q2 写确认 | **分级**：小改自动落盘（进撤销栈）、覆盖式大改弹 diff 预览确认 |
| Q3 上下文 | **意图路由 + 场景化注入**（见 §4）：先意图识别，再按场景喂 skill/上下文，按需读取不预载全文 |
| Q4 变量 | **直接读写**变量库（解析 master 现有存储格式），不等 story-vars 合并 |
| Q5 部署 | **测试版流程**：构建产物只进 `beta/`，绝不推 master 根目录正式版（用户强调"之后也不要推错了"） |
| Q6 工具范围 | **全部纳入首版**：核心（块读写+变量+检索）+ 结构组（建/删/改名块）+ 创作辅助（提取线索/生成选项）+ 素材元数据管理；删除类一律强制确认 |

### 1.3 非目标（明确不做）
- 不替换/迁移全文助理的审阅标记机制（并存验证期）
- 不做后端服务、不引第三方依赖（保持单文件内联构建）
- 不做多 Agent 协作、不做持久后台任务
- 变量**改名**的正文引用全量同步（逻辑复杂、易错），改名仍走现有 UI；Agent 只做 增/删/改值/加减
- 意图误判的手动纠偏 UI（先靠 fallback 兜底，见 §4.4，列为后续迭代）

---

## 2. 架构总览

```
用户消息
 └→ ① 意图识别轮（thinking off · 固定极短前缀→缓存命中 · 输出结构化 JSON）
      └→ ② 场景装配（选择场景 system 提示词[稳定前缀] + 预载上下文 + 工具白名单）
           └→ ③ Agent 工具循环（callDeepseek 带 tools → 浏览器执行本地工具
                → {role:'tool'} 回填 → 循环，最多 8 轮）
                └→ ④ 最终答复（流式渲染）；写操作按 §6 分级策略落盘
```

- 路由层做**薄**：只决定「预载什么 + 用什么提示词」，不阻断任何能力；核心是工具循环本身。
- 误判兜底：路由到「通用」场景（大纲 + 当前块），且工具仍可按需读取任意内容。

---

## 3. 代码事实依据（实现必须对齐）

| 项 | 位置 | 事实 |
|---|---|---|
| AI 设置 | ai.js:9-17 | `storyeditor:ai:key/base/model/intensity/temp/selfcheck/hideAllAI`；`DEFAULT_BASE='https://api.deepseek.com'`，`DEFAULT_MODEL='deepseek-v4-flash'` |
| 传输层 | ai.js:777 `callDeepseek(messages,opts)` | POST `${base}/chat/completions`；SSE 流式；thinking 必须传对象 `{type:'enabled'\|'disabled'}`；瞬时错误自动重试；`opts.signal` 可中止；**当前不支持 tools 参数 → 需扩展** |
| 变量库 | storage.js:17,39,602,666-680 | `LS_VARS='story-editor:vars'`，key=`story-editor:vars:<pid>`；结构 `[{name, type:'number'\|'text'\|'boolean', value}]`；API `Storage.getVars()/saveVars(arr)/getVarNames()` |
| 变量语法 | editor.js:157-160,2819 | 正文 `{名}` 读取、`<变量:名=值>`、`<变量:名+n>`、`<变量:名-n>`、`<玩家输入变量:名,"引导">`、`<选项:"文字",块名,条件:表达式>`（条件支持 `< > <= >=`） |
| 变量命名 | editor.js:2886-2897 | 字母/下划线/中文开头，可含数字，不能数字开头；**全局唯一** |
| 块存储 | storage.js:21,38,506,527 | `LS_BLOCKS='story-editor:blocks'`，key=`story-editor:blocks:<pid>`；`Storage.loadBlocks()/saveBlocks()`；`window.Storage.setBlockText(name,text)`（editor.js:7990 用） |
| 撤销栈 | editor.js:6154,6206,1617 | `pushHistory()` 存 `{text,selStart,selEnd}`；`undo()`；`storyText.value` setter 被拦截自动保存当前块——**写当前块 = pushHistory() 先行 + setText/赋值** |
| FTA 持久化范式 | editor.js:6676-6722 | `ftHistoryKey()='fta-history:'+pid`（`Storage.getCurrentProjectId()`，fallback `'default'`）；`ftSaveHistory/ftLoadHistory`（含 legacy `fta-history:default` 迁移）；`ftResetSession()` 用 `ftSessionGen++` 使旧回调失效 + abort + 清空 |
| FTA 入口接线 | editor.js:1892,6752,8143 | `#btn-ft-assistant` → `openFulltextAssistant()`（无 key → toast + `openSettings('ai')`）；AI 菜单项 `special='openFulltext'` |
| 全局隐藏 | editor.js:7348 `applyHideAllAI()` | 设置 `storyeditor:ai:hideAllAI` 时隐藏所有 AI 入口——**Agent 入口与 modal 必须联动** |
| 部署 | AGENTS.md | 正式版=master 根目录 GitHub Pages `https://jigugumiao.github.io/jiji_text_game_editor/`；**测试版=仅 `build_inline.py --test` 产物进 master `beta/`**，注入 `window.STORY_EDITOR_NS='test'` 隔离 localStorage/IndexedDB；AI 设置与主题仍共享（有意为之） |
| 测试 | tests/*.test.js | Node 直跑无依赖；`release-cache-bust.test.js` 断言 `?v=` 与 app-version 精确串 |

**缓存机制事实**（DeepSeek 官方文档 [news0802](https://api-docs.deepseek.com/news/news0802/)）：
- 全自动磁盘缓存，无需改接口；**仅「第 0 个 token 起的完整前缀」相同才命中**，中段部分匹配无效
- 命中价 $0.014/M vs 未命中 $0.14/M（省 ~90%）；128K 高重复提示首 token 延迟 13s→500ms
- 响应 `usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens` 可监控
- 存储单位 64 token；缓存几小时~几天自动清理；不保证 100% 命中

---

## 4. 意图路由 + 场景化注入

### 4.1 意图识别轮（独立小请求）
- `messages = [system: INTENT_SYSTEM(固定短文本), user: 用户最新消息]`
- 参数：`thinking:'disabled'`（提速 + 避免 reasoning 污染前缀）、`max_tokens≈512`、非流式
- 输出：严格 JSON（提示词强制 + 解析兜底）：
  ```json
  {"scenario":"polish|rewrite|design|vars|general","needs":["current_block","outline"],"note":"一句话理解"}
  ```
- **意图轮消息不进会话历史**（场景轮从场景 system 重新开始 → 前缀干净、可缓存）
- **跳过规则**：用户消息命中延续语（确认/继续/再来/换一种/再多写点/然后呢 等）且当前会话有活跃场景 → 沿用当前场景直接进工具循环，**省一次请求**

### 4.2 场景定义（初始 5 个）
| scenario | 触发意图 | 预载上下文（needs） | 行为规则要点 |
|---|---|---|---|
| `polish` 局部润色/改稿 | 改一段、润色、改台词 | 仅当前块 | 只读当前块；写操作走小改自动/大改预览 |
| `rewrite` 整篇改写/续写 | 全文改写、续写结尾 | 全文 + 大纲 + 创作设定 | 允许输出整篇（受 max_tokens 限制，超长走工具分段）；保留 `<<剧情块:名称>>` 等标记 |
| `design` 剧情问答/设计 | 想剧情、问设定、梳理 | 设定 + 大纲 + 当前块 | 只读为主；可写大纲块 |
| `vars` 变量/逻辑操作 | 加变量、变量逻辑 | 变量库 + 当前块 | 白名单含变量读写工具；禁止改动正文结构 |
| `general` 通用 fallback | 无法归类/其他 | 大纲 + 当前块 | 工具按需读取兜底；行为规则最宽松 |

### 4.3 消息前缀构造（缓存纪律，贯穿全程）
```
[system: 场景 system 提示词]        ← 场景内固定 → 跨消息命中
[system: 创作设定/世界观/文风/线索]  ← 同工程固定 → 同工程命中
[user: 预载上下文（大纲/当前块/变量）] ← 同工程固定（可变内容放此处之后）
[user: 用户最新消息]
[assistant/tool 消息…]              ← 工具循环只 append，不重排 → 跨轮命中
```
- **绝对禁止**把全文/可变内容插进 messages 中段（会截断前缀、杀死缓存）
- 工具定义（functions 数组）保持**逐场景稳定**，视为前缀一部分
- 监控：从响应 usage 提取命中率，可在设置面板加只读统计（后续迭代）

### 4.4 误判兜底
- 路由到 `general` 场景 = 大纲+当前块（比全喂便宜，且工具可按需读全文）
- 工具集在全部场景可用（白名单只影响预载，不硬禁）；若模型请求读「未预载内容」，直接执行即可

---

## 5. 工具集（OpenAI function calling 格式，扩展 callDeepseek 支持）

> 工具分 5 组；白名单按场景裁剪（如 polish 不给结构组）。返回统一附加 `impact`（§6 分级输入）。

### 5.1 文档编辑组（只读）
| 工具 | 参数 | 返回 |
|---|---|---|
| `get_current_block` | — | `{blockName, text}`（含 `<审阅:N>` 标记原样） |
| `list_blocks` | — | `[blockName]` |
| `read_block` | `{blockName}` | 该块全文；不存在 → 错误信息列出可用块 |
| `search_in_doc` | `{query}` | 匹配片段列表 `[{block, lineNo, snippet}]`（上限 20 条） |
| `read_full_text` | — | 全部块拼接（供 rewrite 场景；超 50k 字符告警） |
| `read_settings` | — | 创作设定/世界观/文风/关键线索（未预载时按需读） |

### 5.2 文档编辑组（写）
| 工具 | 参数 | 说明 |
|---|---|---|
| `append_to_block` | `{blockName, text}` | 块尾追加 |
| `insert_at` | `{blockName, anchor, text, mode:'before'\|'after'\|'replace', anchorType:'line'\|'text'}` | 按行号或原文锚定插入/替换；锚定复用审阅标记的「精确优先、模糊回退」定位辅助（editor.js:7133） |
| `apply_review_marker` | `{blockName, current, suggestion}` | 可选用：写 `<审阅:N>` 标记 + 进审阅面板（复用现有管线 ftApplyReviewOps） |

### 5.3 结构组（建/删/改名剧情块）
| 工具 | 参数 | 说明 |
|---|---|---|
| `create_block` | `{blockName}` | 校验命名（沿用素材/块命名规则 storage.js:285）+ 重名拒绝；`saveBlocks` 加块 |
| `rename_block` | `{oldName, newName}` | 同步正文 `<<剧情块:旧名>>` 标记与选项跳转目标引用 |
| `delete_block` | `{blockName}` | **破坏性**：检查其他块 `<<选项:"…",块名>>` 跳转引用并提示；一律强制确认（§6 destructive 档） |

### 5.4 创作辅助组（复用现有 AI 管线）
| 工具 | 参数 | 说明 |
|---|---|---|
| `extract_clues` | `{blockName?}` | 复用 `ai.js:1086 extractClues()` + `parseCluesOutput()`（non-stream，自身一次 AI 调用）；结果写入线索并回显 |
| `generate_options` | `{blockName, count?, tone?}` | 模型产出 `<选项:"文字",块名,条件:表达式>` JSON → 复用 `StoryEditorApi.applyGeneratedBlocks / insertBlockOption` 写入 |

### 5.5 素材组（元数据管理；模型读不了图片/音频二进制内容）
| 工具 | 参数 | 说明 |
|---|---|---|
| `list_assets` | `{lib?}` | 复用 `Storage.getAllAssets()`（ai.js buildContext 已用），返回 `[{name, type, tags}]` 元数据，不含 dataURL |
| `rename_asset` | `{name, newName}` | 复用 `Storage.renameAsset` |
| `delete_asset` | `{name}` | **破坏性**：强制确认；复用 `Storage.deleteAsset` |
| `export_project` | — | 复用 `Storage.exportProject` 导出工程备份（含素材/变量/线索，不含 AI Key） |

### 5.6 变量组（直接读写 master 现有格式）
| 工具 | 参数 | 说明 |
|---|---|---|
| `list_vars` | — | `[{name, type, value}]`（`Storage.getVars()`，storage.js:666） |
| `read_var` | `{name}` | `{name, type, value}`；不存在 → 错误 |
| `create_var` | `{name, type, value}` | 校验命名规则（editor.js:2886：字母/下划线/中文开头，可含数字，不能数字开头）+ 全局唯一 |
| `delete_var` | `{name}` | 仅删库定义；正文引用不清理（提示用户）；**破坏性**：强制确认 |
| `set_var` | `{name, value}` | 改值（类型校验：number 须数值） |
| `update_var` | `{name, op:'+'\|'-', delta}` | 数值加减 |

- 写变量只走 `Storage.getVars()/saveVars()` 适配层（agent 不直接碰 localStorage），story-vars 合并后只改适配层

---

## 6. 写操作分级确认（Q2 + Q6 扩展）

| 级别 | 判定条件 | 行为 |
|---|---|---|
| **小改（自动）** | `impact.chars ≤ 500` 且 `!wholeBlock` | `pushHistory()` 先行 → 落盘 → 聊天流显示「✏️ 已改《块名》+N 行 [撤销]」 |
| **大改（预览）** | `chars > 500` 或 `wholeBlock` | 聊天流渲染 diff 预览卡片（旧片段→新片段），点「应用」才落盘 / 「忽略」放弃 |
| **破坏性（强制确认）** | `destructive:true`（`delete_block` / `delete_asset` / `delete_var`） | 除 diff 预览外再弹「将删除 X（含 N 处跳转引用）」，二次确认才执行；`rename_block` 同步引用后同样走预览确认 |

- 落盘统一走 `applyAgentWrite(blockName, newText)`：`pushHistory()` + 写入（目标块为当前编辑块 → 走 `storyText.value` setter 自动保存；否则 `window.Storage.setBlockText`）+ toast
- 每个已应用写操作在会话内可单独「撤销」（记录 `{block, before}`，一键还原 = `pushHistory() + setBlockText(before)`），与全局 Ctrl+Z 撤销栈并存不冲突
- 变量写操作同样分级（`create_var` 自动、`update_var` 自动、`set_var` 自动；批量改值算大改走预览；`delete_var` 破坏性）

---

## 7. 会话生命周期

- **持久化**：`agent-history:<pid>`（仿 `fta-history:<pid>`，editor.js:6676 范式；pid=`Storage.getCurrentProjectId()`，fallback `'default'`）；只存 `{role, content, _id}`，**不存工具内部消息**（重载时工具消息由场景装配重建，保持前缀稳定）
- **切工程**：`agentResetSession()`（仿 ftResetSession：会话代数++ 使旧回调失效 → abort 进行中请求 → 清空内存态 → 下次打开按新工程 key 重载）
- **打开入口** `openAgent()`：无 key → toast + `openSettings('ai')`；显示 modal + 加载历史
- **中止**：AbortController 贯穿意图轮与全部工具轮；关面板/切工程/点「停止」均中止

---

## 8. 工具循环细节

- **callDeepseek 扩展**（ai.js:777 处新增，向后兼容）：
  - `opts.tools`（functions 数组）、`opts.tool_choice`
  - 流式时拼接 `delta.tool_calls`（index/id/function.name/arguments 增量）；`reasoning_content` 照常忽略
  - 请求体在已有 `model/temperature/max_tokens/stream/thinking` 基础上加 `tools`
- **循环**：`while (轮数<8 && 有 tool_calls) { 执行全部工具调用 → messages.push({role:'tool', tool_call_id, content}) → 再次请求 }`；单轮最多 4 个并行工具；无 tool_calls → 最终答复（流式渲染）
- **thinking×tools 兼容性（待实测）**：V4 需验证 `thinking:'enabled'` 时能否返回 tool_calls。**兜底：所有带 tools 的轮次 thinking:'disabled'**；实测通过后按场景放开（如 rewrite/design 首轮开 thinking）
- **循环上限 8 轮**；超出 → 输出「任务过大，建议拆成小步骤」并保留已应用写入

---

## 9. 代码结构

```
js/agent.js            ← 新文件。IIFE 导出 window.Agent + module.exports（供 Node 测试，同 ai.js 模式）
  Agent.intentParse(text)        // 意图轮输出 → {scenario, needs}（JSON 包裹/噪音兜底）
  Agent.buildMessages(scenario, ctx, userText)  // 前缀构造（§4.3 纪律）
  Agent.classifyWrite(impact)    // auto | preview | destructive（§6 阈值）
  Agent.tools                   // 纯函数工具表（读/写/变量），文档对象注入可测
  Agent.applyAgentWrite(block, newText, deps)  // pushHistory+落盘封装
  Agent.runLoop(opts)            // 工具循环（意图轮→装配→循环→答复），onTool 回调供 UI 渲染
index.html           ← 新增 modal #agent-assistant（仿 #fulltext-assistant）+ AI 菜单项 special='openAgent' + ?v= 更新
js/editor.js          ← 少量接线：openAgent()、#btn-agent 绑定、agentResetSession 挂切工程钩子、applyHideAllAI 联动
tests/agent.test.js   ← Node 直跑：见 §10
docs/agent-design.md  ← 本文档
```

UI（modal）元素：消息流（含工具活动卡片：🔧 工具名+参数摘要 / ✏️ 已改+撤销 / diff 预览卡片 应用·忽略）、输入行、场景标签、中止按钮、思考模式开关（同 FTA）。

---

## 10. 测试计划（tests/agent.test.js，Node 直跑无依赖）

1. `intentParse`：正常 JSON / 带 markdown 包裹 / 噪音文本 → 兜底 general
2. `buildMessages`：前缀顺序断言（system→setting→user 预载→user 消息），同场景两次构建**前缀逐字符相同**（缓存纪律）
3. 工具纯函数：append/insert/replace 文本操作正确性（mock 文档对象）；锚定「精确优先、模糊回退」；`impact` 计算（chars/lines/wholeBlock）
4. `classifyWrite`：500 边界、wholeBlock 强制 preview
5. 变量工具：create_var 命名校验/重名拒绝、set_var 类型校验、update_var 加减、delete_var
6. 结构组：create_block 重名拒绝、rename_block 引用同步（正文标记 + 选项跳转）、delete_block 引用检查
7. 创作辅助：extract_clues 复用管线返回值、generate_options 产出 JSON 校验（`<选项:"文字",块名,条件:…>` 语法合法性）
8. 素材组：list_assets 元数据脱敏（不含 dataURL）、rename_asset、delete_asset
9. `applyAgentWrite`：pushHistory 被调用、setBlockText 参数正确（mock 依赖）
10. 回归：现有 tests/*.test.js 全绿 + `release-cache-bust.test.js`（更新 ?v=/app-version 后通过）

---

## 11. 分支 / 构建 / 部署（用户强调：只走测试版流程）

1. 从 master 切 `feature/agent` 开发，不在 master 直接改
2. 完成 + 测试全绿 + 自审后：更新 index.html `?v=` 与 app-version → `python build_inline.py --test` → 产物（自包含单文件 + docs.html）拷入 master `beta/` → 提交推送
3. **绝不**把构建产物推往 master 根目录正式版路径；提交前 `git status` 核对改动文件清单
4. 验证：PowerShell `Invoke-WebRequest` 探测 beta URL 200 + 注入 `STORY_EDITOR_NS='test'` 隔离生效
5. 与 `feature/story-vars` 的关系：互不阻塞；若其先合并，Agent 变量适配层（§5.2）按新格式适配即可

---

## 12. 风险与待实测

| 风险 | 缓解 |
|---|---|
| thinking×tools 兼容性未知 | §8 兜底 thinking:'disabled'；首个里程碑实测 |
| 意图误判 → 错上下文 | general fallback + 工具按需读取兜底 + note 回显给用户（下一版加纠偏 UI） |
| 工具循环死循环/超时 | 8 轮上限 + abort + 每轮 token 上限 |
| 变量格式随 story-vars 变更 | 适配层隔离（只 getVars/saveVars） |
| 缓存命中率不如预期 | 前缀构造纪律（§4.3）+ usage 命中率监控（后续迭代加统计 UI） |
| 写错块/覆盖用户内容 | 分级确认 + 撤销 + 写前 `pushHistory()` |

---

## 13. 验收标准

1. 网页（测试版 beta 路径）打开 → AI 菜单可见「Agent 对话」→ 无 key 时提示去设置
2. 说「把当前块第 2 段润色一下」→ 意图轮走 polish → 只读当前块 → 小改自动落盘 + 「✏️ 已改…[撤销]」可撤销
3. 说「改写全文结局」→ 走 rewrite → 全文预载 → 大改 diff 预览 → 应用/忽略生效
4. 说「新建一个变量 金币=100」→ 变量库出现该变量；「金币+50」→ 值变化
5. 说「提取关键线索」→ 复用 extractClues 管线产出线索并写入；「给《决战》生成 3 个选项」→ `<选项:…>` 写入正确块
6. 说「新建剧情块《番外》」→ 块出现在列表与正文标记；「删除《番外》」→ 强制确认后才删，且提示跳转引用
7. 说「把素材『bg1』改名『夜晚森林』」→ 素材库元数据更新；「删除素材」→ 强制确认
8. 切工程 → 会话按工程隔离；刷新页面 → 历史不丢
9. 设置里打开「隐藏所有 AI」→ Agent 入口与 modal 一并隐藏
10. `tests/agent.test.js` + 现有全部测试通过；`release-cache-bust.test.js` 通过
11. 缓存纪律生效：同场景连续消息的 `prompt_cache_hit_tokens` 明显增长（人工抽查响应 usage）
