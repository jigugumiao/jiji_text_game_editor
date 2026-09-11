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

> **正文美化知识注入（v25.4.103）**：`polish`/`rewrite`/`general` 三个会产出正文的场景，`systemPrompt` 末尾拼接精简格式手册 `FORMAT_GUIDE_BRIEF`（BBCode 行内美化 + 结构指令 + 素材召唤 + 跳转/分支 + 分块/变量速查 + 铁律「只能用真实语法、禁止自创标签」），保证模型写正文时使用真实存在的美化语法；`design`/`vars` 不加（保持聚焦，vars 已自带变量语法清单）。完整权威手册 `FORMAT_GUIDE_FULL` 由只读工具 `read_formatting_guide` 按需返回（§5.7），避免把长手册常驻每个请求。两常量以 `\n` 拼接，位于 agent.js IIFE 内、`AGENT_SCENARIOS` 之前；场景提示词是固定文本，追加不影响 §4.3 前缀缓存纪律。

### 4.3 消息前缀构造（缓存纪律，贯穿全程）
```
[system: 场景 system 提示词]        ← 场景内固定 → 跨消息命中
[system: 可靠性铁律]                ← 固定 system（禁止编造/虚报）
[system: 回复风格]                  ← 固定 system（克制信息供给）
[system: 编辑器光标/选区定位]        ← 固定 system（「这里/这段」指代解析规则，v25.4.107 新增）
[system: 创作设定/世界观/文风/线索]  ← 同工程固定 → 同工程命中
[user: 预载上下文（大纲/当前块/变量）] ← 同工程固定（可变内容放此处之后）
[user: 用户最新消息（可变；末尾可附加【编辑器当前状态】）]
[assistant/tool 消息…]              ← 工具循环只 append，不重排 → 跨轮命中
```
- **绝对禁止**把全文/可变内容插进 messages 中段（会截断前缀、杀死缓存）
- 工具定义（functions 数组）保持**逐场景稳定**，视为前缀一部分
- 监控：从响应 usage 提取命中率，可在设置面板加只读统计（后续迭代）

#### 4.3.1 光标/选区上下文（用户需求：Agent 知道用户要改哪里，v25.4.107）
- **快照时机**：`agentSend` 开头捕获一次（editor.js `captureAgentCaret()`），语义 = 用户说话那一刻的光标/选区就是用户所指的「这里/这段」；工具轮期间用户移动光标不影响快照
- **进提示词方式**：`buildMessages` 在**用户消息末尾**同一条消息内拼 `【编辑器当前状态】`（当前块/光标行/选中文字），**绝不进固定 preload**——选区一动整个前缀就失效，违反 §4.3 缓存纪律；拼进 userText 同条消息（而非独立消息）保证 runLoop 的「历史插入到最后一条 user 之前」插入点不变
- **刻意精简**：不附前/后文——预载上下文已含当前块全文（current_block）或全文（full_text），前后文冗余，行号 + 选中文字足够定位
- **场景规则**：固定 system 消息 `AGENT_CARET_RULES` 声明字段语义 +「这里/这段/光标处」= 选中文字（未选中=光标行）+ replace_selection 用法；位置固定 → 不影响前缀缓存
- **新增工具 `replace_selection`**（§5.2）：模型不用抄写原文——原文由编辑器从快照读取（根治抄错）；定位策略：块当前文本 === 快照 blockText → 用快照偏移（最精确）；已被改动 → `findAnchor(selText)` 精确优先、模糊回退，找不到报错（不静默改错位置）；无选区报错并指引改用 `insert_at`；blockName 与快照块不一致拒绝（防止改错块）

### 4.4 误判兜底
- 路由到 `general` 场景 = 大纲+当前块（比全喂便宜，且工具可按需读全文）
- **tools 语义（已定）**：场景表 `tools` 空数组 = 全部工具可用（默认全量）；非空 = 仅白名单（硬裁剪，只下发白名单工具定义）。`polish` 是唯一显式白名单场景（收敛为局部改稿工具）；`rewrite`/`design`/`vars`/`general` 全部工具可用（`vars` 必须用变量组、`general` 需全能）。白名单只影响工具定义下发，不禁止工具在未预载时按需读取

---

## 5. 工具集（OpenAI function calling 格式，扩展 callDeepseek 支持）

> 工具分 5 组。**白名单语义（§4.4）**：场景表 `tools` 空数组 = 全部工具可用；非空 = 仅白名单（硬裁剪，`polish` 唯一显式白名单）。返回统一附加 `impact`（§6 分级输入）。

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
| `replace_selection` | `{text, blockName?}` | **替换用户说话时选中的文字**（§4.3.1，v25.4.107）：原文由 `getCaretRef` 快照提供，模型只传新文字不抄原文；块文本与快照一致用偏移、否则按选中文字锚定；无选区/跨块/锚不到一律报错；`blockName` 可省略（缺省=选区所在块）。polish 白名单已加入 |
| `apply_review_marker` | `{blockName, current, suggestion}` | 写 `<审阅:N>` 标记 + 进审阅面板（复用现有管线 ftApplyReviewOps）。**v25.4.104 真接线**：支持任意块（当前块走 `storyText.value`+commitEdit，其他块持久化读改写回），锚定不上存未锚定建议；不返回 `resultText`（标记写入是「提议」非「改稿」，不触发 preview 弹窗）。大段改写优先用它逐条提建议，用户经审阅面板应用

### 5.3 结构组（建/删/改名剧情块）
| 工具 | 参数 | 说明 |
|---|---|---|
| `create_block` | `{blockName}` | 校验命名（沿用素材/块命名规则 storage.js:285）+ 重名拒绝；`saveBlocks` 加块 |
| `rename_block` | `{oldName, newName}` | 同步正文 `<<剧情块:旧名>>` 标记与选项跳转目标引用 |
| `delete_block` | `{blockName}` | **破坏性**：检查其他块 `<<选项:"…",块名>>` 跳转引用并提示；一律强制确认（§6 destructive 档） |

### 5.4 创作辅助组（复用现有 AI 管线）
| 工具 | 参数 | 说明 |
|---|---|---|
| `extract_clues` | `{blockName?, incremental?}` | 复用 `ai.js:1126 extractClues()` + `parseCluesOutput()`（non-stream，自身一次 AI 调用，async 返回 `{clues,summary}`）。**v25.4.106 增强**：缺省全文（`ftaCollectFullText`）、自动带当前线索作 `existing`（增量比对基础）、返回 `summary` 变更说明；修复原实现未 `await` deps（接线 async → r 是 Promise、ok 恒 undefined、恒「提取失败」）。**线索自维护**：三写作场景提示词引导 Agent 改正文后主动调用核对线索是否变动/产生新线索，有变动用 `update_creation_setting(field='clues')` 写入；polish 白名单为此加入 `extract_clues`/`update_creation_setting` |
| `generate_options` | `{text}` | 模型产出 `<选项:"文字",块名,条件:表达式>` 文本；校验镜像引擎同行拼接规则（editor.js:125 `extractOptionLine`，Task 11 已实现 2c79a09）；接线时写入当前编辑块末尾（走撤销管线，绝不接 editor.js:7985 覆盖 MAIN_BLOCK 的 applyGeneratedBlocks） |

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

### 5.7 知识组（正文格式手册，v25.4.103）
| 工具 | 参数 | 说明 |
|---|---|---|
| `read_formatting_guide` | — | 返回 `{ok:true, guide}`，guide 为权威完整版正文美化手册 `FORMAT_GUIDE_FULL`（BBCode 全标签与特效、结构指令、素材召唤、跳转/分支、分块/变量语法、注意事项铁律，含示例）。纯函数无写入副作用，返回对象**不含 `resultText`**（runLoop §8 据此判定写操作，缺失即不触发 applyAgentWrite）。`polish` 白名单已加；`rewrite`/`vars`/`general` 走全量自动包含 |

### 5.8 全局设置组（游戏元信息 + 游玩设置，v25.4.105）
| 工具 | 参数 | 说明 |
|---|---|---|
| `read_global_settings` | — | 返回当前全局游戏设置：游戏名/副标题/作者ID/游玩模式 `playMode`（longform\|galgame）/文字对比度保护 `textContrast`（auto\|off）/开场背景/开场音乐/水印 `watermark`（{text,pos,opacity}）/图标/自定义字体名。只读。`icon` 兼容旧版 dataURL、`font` 是二进制上传，两者只读不给写 |
| `update_global_setting` | `{patch}` | 合并写入白名单字段（gameName/subtitle/authorId/playMode/textContrast/watermark/openingBg/openingMusic）。取值校验在 agent.js 工具侧（enum/watermark 子字段/opacity 10-100）；`openingBg`/`openingMusic` 在 editor.js `saveGlobalSettings` 侧校验素材真实存在于对应素材库（背景/音乐），防写入无效引用；落盘走 `saveGlobal()`（meta + storage）。**async 工具**（runLoop `await impl(args)` 支持）。立即生效覆盖试玩与导出成品 |

---

## 6. 写操作分级确认（Q2 + Q6 扩展）

| 级别 | 判定条件 | 行为 |
|---|---|---|
| **小改（自动）** | `impact.chars ≤ 500` 且 `!wholeBlock` | `pushHistory()` 先行 → 落盘 → 聊天流显示「✏️ 已改《块名》+N 行 [撤销]」 |
| **大改（预览）** | `chars > 500` 或 `wholeBlock` | 聊天流渲染 diff 预览卡片（旧片段→新片段），点「应用」才落盘 / 「忽略」放弃 |
| **破坏性（强制确认）** | `destructive:true`（`delete_block` / `delete_asset` / `delete_var`） | 除 diff 预览外再弹「将删除 X（含 N 处跳转引用）」，二次确认才执行；`rename_block` 同步引用后同样走预览确认 |

> **`impact.chars` 语义 = 本次写操作的「变更量」**（`|编辑后总长 − 编辑前总长|`），不是编辑后的块总长。
> 理由：若按块总长判定，任何 ≥500 字的剧情块编辑都会强制进预览，「小改自动落盘」对正常篇幅的块失效。
> 大段替换（diff 展示的旧片段≠新片段）由 `wholeBlock` 或较大 delta 天然覆盖。
>
> **v25.4.104**：大段改写**优先走 `apply_review_marker` 进审阅面板**（用户逐条检查应用），而非 diff 预览弹窗——polish/rewrite/general 三场景提示词与工具描述已引导；`insert_at` 整块/大改的 preview 弹窗保留作兜底。
>
> **v25.4.106 线索自维护**：全文线索（`creation.clues`）不只是给用户看，也是 AI 写作提示。三写作场景（polish/rewrite/general）提示词追加引导——修改正文后主动用 `extract_clues` 核对线索是否变动/产生新线索（缺省全文、自动带当前线索比对、返回 `summary` 变更说明），确认有变动则用 `update_creation_setting(field='clues')` 更新关键线索（整字段替换走 preview 确认，用户可检查）。`read_settings` 本就含【关键线索】→ 模型可先读再比。polish 白名单为此扩至 9 工具。

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
2. `buildMessages`：前缀顺序断言（system×4→setting→user 预载→user 消息），同场景两次构建**前缀逐字符相同**（缓存纪律）；`ctx.caret` 存在时拼【编辑器当前状态】到用户消息末尾、无 caret 时用户消息原样、前缀不变（光标不破坏缓存）
3. 工具纯函数：append/insert/replace 文本操作正确性（mock 文档对象）；锚定「精确优先、模糊回退」；`impact` 计算（chars/lines/wholeBlock）；`replace_selection`（快照偏移 / 文本改动后锚点回退 / 无选区报错 / 跨块拒绝 / 整块 wholeBlock / 锚不到报错）
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

---

## 14. 历史摘要压缩（Agent 早期对话，v25.4.91）

借鉴 DSH 内置上下文压缩机制的设计（分层摘要、压缩后仍可检索原文、不压活跃内容）移植到 Agent 对话历史：

- **触发**：agentSend 时历史（user/assistant/summary 条目文本）总字符 > 30000（约 20-30K token）→ 压缩一次。
- **分层**：`Agent.classifyHistoryCompression(history)` 纯函数把最旧条目压掉，直到剩余 keep 段 ≤ 阈值；最后一条 user 永不压（活跃内容）。
- **摘要生成**：compress 段 → LLM（callDeepseek 非流式、thinking:false、8192 内）压成 ≤400 字要点；提示词要求逐字保留剧情块名/变量名与数值/用户指令/已确认修改与撤销/未决问题；失败静默回滚（不压缩、不丢历史）。
- **持久化**：压缩后 history = `[{role:'summary',content:摘要}]` + keep，写回 agent-history:<pid>；摘要稳定不重生成（保持前缀、缓存可命中）；再次超阈值时旧摘要与更早内容一起再压缩（tier 2 蒸馏，DSH 同款）。
- **归档与检索**：被压原文存 agent-history-archive:<pid>（cap 总字符 100K，最旧先丢）；新工具 `search_history(query)` 检索归档（大小写不敏感、逐行、上限 20）——对应 DSH 的 search_context/decompress。
- **buildMessages**：runLoop 历史注入接受 role:'summary'，作为 user 消息前置（【早期对话摘要】标记）。
- **不压缩对象**：keep 段原文、当前 userText、preload 上下文。
