# Agent 对话（全能助理）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在剧情编辑器中新增纯前端「Agent 对话」：意图路由 + 工具调用循环，可读写剧情块/变量/素材元数据，带分级确认与撤销，走测试版（beta/）部署。

**Architecture:** 意图识别轮（thinking off、固定短前缀、输出 `{scenario,needs}` JSON）→ 场景装配（稳定 system 提示词 + 预载上下文 + 工具白名单）→ 工具循环（`callDeepseek` 带 tools，浏览器执行本地纯函数工具，`{role:'tool'}` 回填，≤8 轮）→ 分级写确认（auto/preview/destructive）。核心模块 `js/agent.js`（IIFE + `window.Agent` + `module.exports`），工具为纯函数 + deps 注入（可 vm 提取直测），UI 接线在 `index.html` / `js/editor.js`。

**Tech Stack:** 纯浏览器 JS（无依赖）、DeepSeek OpenAI 兼容 API（SSE）、Node 直跑测试（node:assert/strict + vm 提取源码函数）、build_inline.py 内联构建。

**设计文档（权威）：** `docs/agent-design.md`（§编号引用以它为准）

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `js/agent.js`（新建） | 核心模块：`AGENT_SCENARIOS` 场景表、`intentParse`、`buildMessages`、`classifyWrite`、`tools` 纯函数表、`applyAgentWrite`、`runLoop`、`loadHistory/saveHistory/resetSession`。IIFE 导出 `window.Agent` + `module.exports` |
| `js/ai.js`（修改 :777 `callDeepseek`） | 增加 `opts.tools` / `opts.tool_choice`，流式拼接 `delta.tool_calls`（回调 `onToolCalls`），非流式/流式均透出 `{content, toolCalls}`（无 tools 时行为不变） |
| `index.html`（修改） | 新增 `#agent-assistant` modal + 入口按钮 + AI 菜单项 `special='openAgent'` + 引入 `js/agent.js` + `?v=` 更新 |
| `js/editor.js`（修改） | `openAgent()`、按钮绑定、切工程钩子 `agentResetSession`、`applyHideAllAI` 联动、`agent-history:<pid>` 持久化接线 |
| `tests/agent.test.js`（新建） | Agent 全部单元测试（vm 提取源码纯函数 + mock deps） |
| `tests/ai-tools.test.js`（新建） | ai.js tools 扩展测试 |
| `tools/probe_agent_compat.mjs`（新建） | thinking×tools 兼容性探针（一次性脚本） |
| `docs/agent-thinking-tools.md`（新建） | 探针结论记录 |
| `docs/superpowers/plans/2026-09-11-agent-dialogue.md` | 本文档 |

**执行环境约定：**
- 测试命令：`node tests/xxx.test.js`（Node 直跑无依赖）；全量：PowerShell `Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName }`（期望全部 0 退出码）
- 提交：每个任务末尾一次 commit，`feature/agent` 分支（Task 0 建）
- **部署红线（用户强调）**：构建产物只进 master `beta/`，绝不推 master 根目录正式版；提交前 `git status` 核对

---

### Task 0: 分支与基线

**Files:**
- Modify: 无（git 操作）

- [ ] **Step 1: 建分支**

```bash
git checkout -b feature/agent
```

- [ ] **Step 2: 跑现有全部测试确认基线**

```powershell
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "FAIL: $_" } }
```

Expected: 全部 0 退出码（无输出 = 通过；如有 FAIL 先停下修复基线）。

- [ ] **Step 3: Commit（若分支新建后有工作区改动）**

```bash
git add -A && git commit -m "chore: start feature/agent branch baseline"
```

---

### Task 1: thinking×tools 兼容性探针（里程碑 1 — 最高风险，最先实测）

**Files:**
- Create: `tools/probe_agent_compat.mjs`
- Create: `docs/agent-thinking-tools.md`

背景：设计文档 §8 规定「带 tools 的轮次兜底 thinking:'disabled'」，但若实测 V4 支持 thinking+tools 则按场景放开。本任务只测、只记录，不改业务代码。

- [ ] **Step 1: 写探针脚本**

```js
// tools/probe_agent_compat.mjs — 一次性探针：验证 DeepSeek 兼容端点上 thinking×tools 行为
// 用法：$env:DEEPSEEK_KEY='sk-...'; node tools/probe_agent_compat.mjs
const KEY = process.env.DEEPSEEK_KEY;
if (!KEY) { console.error('需要 DEEPSEEK_KEY 环境变量'); process.exit(1); }
const BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const tools = [{ type: 'function', function: { name: 'get_current_block', description: '读当前块', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];

async function call(label, thinking) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: '用工具读一下当前块' }],
    tools, tool_choice: 'auto',
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    stream: false, max_tokens: 1024,
  };
  const t0 = Date.now();
  const r = await fetch(BASE + '/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  const ms = Date.now() - t0;
  if (!r.ok) { console.log(`[${label}] HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`); return; }
  const m = j.choices && j.choices[0] && j.choices[0].message || {};
  console.log(`[${label}] ${ms}ms`);
  console.log('  tool_calls:', m.tool_calls ? JSON.stringify(m.tool_calls.map(t => t.function.name)) : '无');
  console.log('  reasoning_content:', m.reasoning_content ? '(有, ' + m.reasoning_content.length + ' 字)' : '无');
  console.log('  finish_reason:', j.choices[0].finish_reason);
  console.log('  usage:', JSON.stringify(j.usage));
  if (!r.ok) { console.log(`[${label}] HTTP ${r.status}: ${JSON.stringify(j).slice(0,300)}`); return; }
}
await call('thinking=disabled+tools', false);
await call('thinking=enabled+tools', true);
```

- [ ] **Step 2: 运行探针并记录结论**

```powershell
$env:DEEPSEEK_KEY='<你的Key>'; node tools/probe_agent_compat.mjs
```

Expected: 两组均打印 tool_calls / reasoning_content / finish_reason / usage。把实测结果写入 `docs/agent-thinking-tools.md`：
- 若 **thinking=enabled 时也能返回 tool_calls**（reasoning 与工具共存）→ 设计 §8 放开：工具轮可开 thinking（rewrite/design 场景）
- 若 **enabled 时不返回 tool_calls 或报错** → 维持兜底：所有带 tools 轮次 thinking:'disabled'
- 无论结果如何，把结论记入 `docs/agent-thinking-tools.md`，并在 Task 13 场景提示词按结论落

- [ ] **Step 3: Commit**

```bash
git add tools/probe_agent_compat.mjs docs/agent-thinking-tools.md
git commit -m "chore: probe DeepSeek thinking×tools compatibility"
```

---

### Task 2: ai.js callDeepseek 扩展 tools 支持

**Files:**
- Modify: `js/ai.js`（`callDeepseek` 函数体，约 :777-880）
- Create: `tests/ai-tools.test.js`

设计：`callDeepseek` 新增 `opts.tools`（functions 数组）、`opts.tool_choice`。请求体 `body` 若传了 `tools` 则带上；流式响应解析 `delta.tool_calls`（按 index 增量拼接 name/arguments）；非流式响应若 `message.tool_calls` 存在则返回 `{ content, toolCalls }`（向后兼容：无 tools 时行为完全不变）。

- [ ] **Step 1: 写失败测试**

```js
// tests/ai-tools.test.js
// callDeepseek tools 扩展：请求体带 tools / 流式 tool_calls 增量拼接 / 非流式 toolCalls 透出
const assert = require('node:assert/strict');

// ai.js 顶层若引用 window，先给 stub（ai.js 是 IIFE，module.exports 供 Node 测试）
global.window = global.window || { StoryEditorApi: {}, Storage: { getAllAssets: () => [] } };
const AI = require('../js/ai.js');

function mockFetchOnce(respBody) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => respBody };
  };
  return calls;
}

async function testNonStreamTools() {
  const calls = mockFetchOnce({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_block', arguments: '{"blockName":"第一章"}' } }] }, finish_reason: 'tool_calls' }],
  });
  const out = await AI.callDeepseek([{ role: 'user', content: 'hi' }], {
    tools: [{ type: 'function', function: { name: 'read_block', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto', stream: false,
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1, '请求体必须带 tools');
  assert.equal(body.tool_choice, 'auto');
  assert.ok(out.toolCalls && out.toolCalls[0].function.name === 'read_block', '非流式必须透出 toolCalls');
}

async function testNoToolsBackwardCompat() {
  const calls = mockFetchOnce({ choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] });
  const out = await AI.callDeepseek([{ role: 'user', content: 'hi' }], { stream: false });
  assert.equal(out, '你好', '无 tools 时保持原行为：直接返回 content 字符串');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.tools, undefined, '无 tools 时请求体不得带 tools 字段');
}

(async () => { await testNonStreamTools(); await testNoToolsBackwardCompat(); console.log('ai-tools.test.js OK'); })().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/ai-tools.test.js`
Expected: FAIL——`callDeepseek` 尚不认识 `opts.tools`，`out.toolCalls` 为 undefined。

- [ ] **Step 3: 实现扩展**

在 `callDeepseek`（ai.js:777 附近）中：
- 请求体构造处（现 `body = { model, temperature, max_tokens, stream, thinking }`）追加：
  ```js
  if (opts.tools) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  ```
- 流式解析分支：现有 `onToken(delta.content, full)` 回调旁新增 `opts.onToolCalls`。SSE 行解析里对 `delta.tool_calls`（数组，元素含 `index/id/function{name,arguments}`）做增量拼接（按 index 缓存部分结果，arguments 字符串追加），流结束后若有 tool_calls 且存在 `opts.onToolCalls` 则回调 `opts.onToolCalls(完整数组)`。
- 非流式分支：现在返回 `data.choices[0].message.content`；改为：
  ```js
  const msg = data.choices && data.choices[0] && data.choices[0].message || {};
  if (msg.tool_calls) return { content: msg.content, toolCalls: msg.tool_calls };
  return msg.content;
  ```
  （保持与现有调用方兼容：无 tool_calls 时返回仍为字符串）

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/ai-tools.test.js`
Expected: `ai-tools.test.js OK`，退出码 0。

- [ ] **Step 5: 回归现有 AI 测试**

```powershell
node tests\release-cache-bust.test.js; node tests\option-condition.test.js
```
Expected: 均通过（ai.js 改动不影响导出路径/版本串）。

- [ ] **Step 6: Commit**

```bash
git add js/ai.js tests/ai-tools.test.js
git commit -m "feat(ai): support tools/tool_choice in callDeepseek"
```

---

### Task 3: agent.js 骨架 + 场景表

**Files:**
- Create: `js/agent.js`
- Create: `tests/agent.test.js`

模块骨架（IIFE + 导出），先落地 **AGENT_SCENARIOS 场景表**（纯数据，供 Task 5 buildMessages / Task 13 runLoop 使用），并写首个测试确认导出与场景表形状。提示词文本给框架，具体措辞在 Task 13 与场景提示词一起完善——但场景表结构本任务定死。

- [ ] **Step 1: 写失败测试**

```js
// tests/agent.test.js — Agent 模块骨架与场景表
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'agent.js'), 'utf8');

assert.match(agentSrc, /window\.Agent\s*=/, 'agent.js 必须导出 window.Agent');
assert.match(agentSrc, /module\.exports/, 'agent.js 必须 module.exports（Node 测试）');

// 场景表：5 个场景，字段齐全
const ctx = {};
vm.createContext(ctx);
vm.runInContext(agentSrc + '\nthis.__s = Agent.AGENT_SCENARIOS;', ctx);
const scen = ctx.__s;
assert.deepEqual(Object.keys(scen).sort(), ['design', 'general', 'polish', 'rewrite', 'vars']);
for (const [id, s] of Object.entries(scen)) {
  assert.equal(typeof s.systemPrompt, 'string', id + ' 需要 systemPrompt');
  assert.ok(s.systemPrompt.length > 50, id + ' systemPrompt 不能是空壳');
  assert.ok(Array.isArray(s.preload), id + ' preload 需为数组');
  assert.ok(Array.isArray(s.tools), id + ' tools 白名单需为数组');
}
assert.ok(scen.polish.tools.length > 0 && !scen.polish.tools.includes('delete_block'), 'polish 白名单不应含结构组破坏性工具');
assert.ok(scen.rewrite.preload.includes('full_text'), 'rewrite 应预载全文');
console.log('agent.test.js OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`js/agent.js` 不存在。

- [ ] **Step 3: 实现骨架 + 场景表**

`js/agent.js` 骨架（场景提示词措辞本任务先给可用版本，Task 13 再打磨不冲突）：

```js
// js/agent.js — Agent 对话（全能助理）：意图路由 + 工具调用循环
// 设计文档：docs/agent-design.md
(function () {
  'use strict';

  // 场景表：id → { systemPrompt, preload, tools }
  // preload 取值：'full_text'|'outline'|'current_block'|'settings'|'vars'（buildMessages 按此取上下文）
  // tools：场景允许的工具名白名单（空数组=全部工具；非空=仅白名单）
  var AGENT_SCENARIOS = {
    polish: {
      systemPrompt: '你是剧情编辑器的局部改稿助手。只处理用户明确指出的片段，默认只读当前编辑块，不主动读取或修改其他块。需要修改时使用写工具，改动遵循小改自动落盘、大改预览确认。不要输出整篇全文。',
      preload: ['current_block'],
      tools: ['get_current_block', 'read_block', 'search_in_doc', 'append_to_block', 'insert_at', 'apply_review_marker'],
    },
    rewrite: {
      systemPrompt: '你是剧情编辑器的整篇改写/续写助手。可读取全文后整篇重写或续写，保留 <<剧情块:名称>> 分块标记与 <跳回>/<跳回重选> 跳转标记，只改写文字。大篇幅改动会走 diff 预览确认。',
      preload: ['full_text', 'outline', 'settings'],
      tools: [],
    },
    design: {
      systemPrompt: '你是剧情编辑器的剧情设计顾问。围绕世界观、大纲、人物与剧情走向回答问题、出主意、梳理结构。以只读为主，可写大纲类块；不要擅自动当前正在创作的正文。',
      preload: ['outline', 'settings', 'current_block'],
      tools: [],
    },
    vars: {
      systemPrompt: '你是剧情编辑器的变量/逻辑助手。专注变量库与正文中的变量语法（{名} 读取、<变量:名=值>、<变量:名+n>、<变量:名-n>、<玩家输入变量:名,"引导">、<选项:"文字",块名,条件:表达式>）。可增删改查变量，不改动正文叙事结构。',
      preload: ['vars', 'current_block'],
      tools: [],
    },
    general: {
      systemPrompt: '你是剧情编辑器的全能助理。通过工具按需读取任意剧情块、全文、设定、变量与素材元数据，回答或执行用户请求。写操作遵循小改自动、大改预览、破坏性操作强制确认。',
      preload: ['outline', 'current_block'],
      tools: [],
    },
  };

  var Agent = {
    AGENT_SCENARIOS: AGENT_SCENARIOS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Agent;
  if (typeof window !== 'undefined') window.Agent = Agent;
})();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): module skeleton and scenario table"
```

---

### Task 4: intentParse（意图轮输出解析）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

意图轮模型输出 → `{scenario, needs, note}`。解析策略：提取文本中第一个 `{...}` JSON 对象（容忍 ```json 包裹、前后废话）；解析失败或 scenario 不在表内 → 兜底 `{scenario:'general', needs:[], note:''}`。`needs` 从输出取，但最终预载以场景表 preload 为准（needs 仅作提示，防模型乱指）。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加（放到 console.log 前）
{
  const good = Agent.intentParse('{"scenario":"polish","needs":["current_block"],"note":"润色第二段"}');
  assert.equal(good.scenario, 'polish');
  assert.ok(good.needs.includes('current_block'));
}
{
  const wrapped = Agent.intentParse('好的，我先分析：```json\n{"scenario":"rewrite","needs":["full_text"]}\n```');
  assert.equal(wrapped.scenario, 'rewrite', '须容忍 markdown 代码块包裹');
}
{
  const noisy = Agent.intentParse('这段剧情感觉节奏太慢了，帮我润色一下。');
  assert.equal(noisy.scenario, 'general', '无 JSON 时兜底 general，不抛错');
}
{
  const badScenario = Agent.intentParse('{"scenario":"hack","needs":[]}');
  assert.equal(badScenario.scenario, 'general', '未知 scenario 兜底 general');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.intentParse` undefined。

- [ ] **Step 3: 实现 intentParse**

```js
// 加在 Agent 对象内
intentParse: function (raw) {
  var out = { scenario: 'general', needs: [], note: '' };
  if (!raw || typeof raw !== 'string') return out;
  var m = raw.match(/\{[\s\S]*\}/);
  if (!m) return out;
  try {
    var j = JSON.parse(m[0]);
    if (j && typeof j === 'object') {
      if (AGENT_SCENARIOS[j.scenario]) out.scenario = j.scenario;
      if (Array.isArray(j.needs)) out.needs = j.needs.filter(function (n) { return typeof n === 'string'; });
      if (typeof j.note === 'string') out.note = j.note;
    }
  } catch (e) { /* 解析失败 → 兜底 general */ }
  return out;
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): intentParse with general fallback"
```

---

### Task 5: buildMessages（前缀构造 + 缓存纪律）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

签名：`buildMessages(scenario, ctx, userText, opts)`。
`ctx` 由 UI/runLoop 提供：`{ outline, settings, currentBlock, fullText, vars, activeBlockName }`（取不到则为 null/''）。
构造顺序（设计 §4.3）：
```
[system: 场景 systemPrompt]
[system: 创作设定（ctx.settings 非空时）]
[user: 预载上下文（按 scenario.preload 拼装；最后接「用户最新消息」之前）]
[user: userText]
```
关键纪律：**预载内容固定在 user 消息的固定位置，同场景同工程内容不变 → 前缀稳定**。返回 messages 数组（首两条是 system）。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
{
  const ctx = { outline: '大纲A', settings: '世界观：魔都', currentBlock: { name: '第一章', text: '正文…' }, fullText: '全文…', vars: [{ name: '金币', type: 'number', value: 10 }] };
  const msgs = Agent.buildMessages('polish', ctx, '润色第二段');
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.indexOf('局部改稿') >= 0, '首条=场景 system 提示词');
  assert.equal(msgs[1].role, 'system');
  assert.ok(msgs[1].content.indexOf('世界观：魔都') >= 0, '第二条=创作设定（settings）');
  assert.ok(msgs[2].role === 'user' && msgs[2].content.indexOf('大纲A') >= 0, '预载上下文在第三条 user');
  assert.equal(msgs[3].role, 'user');
  assert.equal(msgs[3].content, '润色第二段', '用户消息必须在最后');
}
{
  // 缓存纪律：同场景同工程两次构建，前缀逐字符相同（稳定前缀在可变内容之前）
  const ctx = { outline: '大纲A', settings: '世界观：魔都', currentBlock: { name: '第一章', text: '正文…' }, fullText: '全文…' };
  const a = Agent.buildMessages('general', ctx, '第一个问题');
  const b = Agent.buildMessages('general', ctx, '第二个问题');
  const prefixLen = Math.min(a[2].content.length, b[2].content.length);
  assert.equal(a[2].content.slice(0, prefixLen), b[2].content.slice(0, prefixLen), '预载 user 消息是稳定前缀');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.buildMessages` undefined。

- [ ] **Step 3: 实现 buildMessages**

```js
// 加在 Agent 对象内
buildMessages: function (scenario, ctx, userText, opts) {
  var sc = AGENT_SCENARIOS[scenario] || AGENT_SCENARIOS.general;
  ctx = ctx || {};
  var msgs = [];
  msgs.push({ role: 'system', content: sc.systemPrompt });
  var settings = ctx.settings;
  if (settings && String(settings).trim()) {
    msgs.push({ role: 'system', content: '【创作设定】\n' + settings });
  }
  // 预载上下文（固定顺序，保证前缀稳定）
  var pre = [];
  var want = sc.preload || [];
  for (var i = 0; i < want.length; i++) {
    var k = want[i];
    if (k === 'full_text' && ctx.fullText) pre.push('【全文】\n' + ctx.fullText);
    else if (k === 'outline' && ctx.outline) pre.push('【大纲】\n' + ctx.outline);
    else if (k === 'current_block' && ctx.currentBlock && ctx.currentBlock.text) pre.push('【当前编辑块《' + ctx.currentBlock.name + '》】\n' + ctx.currentBlock.text);
    else if (k === 'settings' && settings && String(settings).trim()) pre.push('【创作设定】\n' + settings);
    else if (k === 'vars' && ctx.vars && ctx.vars.length) {
      pre.push('【变量库】\n' + ctx.vars.map(function (v) { return v.name + ' (' + v.type + ') = ' + v.value; }).join('\n'));
    }
  }
  if (pre.length) msgs.push({ role: 'user', content: pre.join('\n\n') });
  msgs.push({ role: 'user', content: userText || '' });
  return msgs;
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): buildMessages prefix construction (cache discipline)"
```

---

### Task 6: classifyWrite（分级确认判定）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

签名：`classifyWrite(impact)` → `'auto' | 'preview' | 'destructive'`。
规则（设计 §6）：`destructive:true` → `'destructive'`；否则 `chars ≤ 500 且 !wholeBlock` → `'auto'`；否则 `'preview'`。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
assert.equal(Agent.classifyWrite({ chars: 100, lines: 3, wholeBlock: false }), 'auto');
assert.equal(Agent.classifyWrite({ chars: 500, lines: 10, wholeBlock: false }), 'auto', '500 边界算小改');
assert.equal(Agent.classifyWrite({ chars: 501, lines: 10, wholeBlock: false }), 'preview', '超 500 算大改');
assert.equal(Agent.classifyWrite({ chars: 10, lines: 1, wholeBlock: true }), 'preview', '整块替换强制 preview');
assert.equal(Agent.classifyWrite({ chars: 10, lines: 1, wholeBlock: false, destructive: true }), 'destructive');
assert.equal(Agent.classifyWrite({ destructive: true }), 'destructive', '缺字段也要判 destructive');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.classifyWrite` undefined。

- [ ] **Step 3: 实现 classifyWrite**

```js
// 加在 Agent 对象内
classifyWrite: function (impact) {
  impact = impact || {};
  if (impact.destructive) return 'destructive';
  var chars = impact.chars || 0;
  if (chars <= 500 && !impact.wholeBlock) return 'auto';
  return 'preview';
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): classifyWrite auto/preview/destructive"
```

---

### Task 7: 文档编辑工具纯函数

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

工具表 `Agent.tools`：`{ get_current_block, list_blocks, read_block, search_in_doc, read_full_text, read_settings, append_to_block, insert_at, apply_review_marker, ...后续任务扩展 }`。
**纯函数 + deps 注入**：工具不碰 DOM/localStorage，所有外部依赖通过 `Agent.toolsDeps`（运行时由 UI/runLoop 注入）：
```js
Agent.toolsDeps = {
  getActiveBlock: null,   // () => {name, text}
  listBlocks: null,       // () => [names]
  getBlockText: null,     // (name) => text|null
  fullText: null,         // () => 全文
  settings: null,         // () => 创作设定文本
  getVars: null, saveVars: null,
  // ...结构/素材组后续加
};
```
本任务实现：文本操作核心 `textOps`（append/insert/replace + 锚定「精确优先、模糊回退」）+ `impact` 计算 + 四个只读工具 + append_to_block / insert_at / apply_review_marker。

**锚定规则（设计 §5.2）**：`insert_at` 的 `anchor` 参数——`anchorType:'line'` 按行号（1 起）；`anchorType:'text'` 精确匹配 anchor 原文（唯一匹配直接命中；多匹配取第一个并提示；零匹配 → 模糊回退：去空白后包含匹配）。`mode`：before/after/replace。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
function mockDeps() {
  return {
    getActiveBlock: () => ({ name: '第一章', text: '第一行\n第二行\n第三行' }),
    listBlocks: () => ['第一章', '第二章'],
    getBlockText: (n) => n === '第一章' ? '第一行\n第二行\n第三行' : n === '第二章' ? '甲\n乙' : null,
    fullText: () => '第一章:第一行\n第二行\n第三行\n第二章:甲\n乙',
    settings: () => '世界观：魔都',
  };
}
function callTool(name, args) {
  const deps = mockDeps();
  Agent.toolsDeps = deps;
  return Agent.tools[name](args || {});
}

// 只读
{
  const r = callTool('get_current_block', {});
  assert.equal(r.blockName, '第一章');
  assert.equal(r.text, '第一行\n第二行\n第三行');
}
{
  assert.deepEqual(callTool('list_blocks', {}), ['第一章', '第二章']);
  assert.equal(callTool('read_block', { blockName: '第二章' }).text, '甲\n乙');
  assert.ok(String(callTool('read_block', { blockName: '不存在' }).error).indexOf('不存在') >= 0);
}
{
  const hits = callTool('search_in_doc', { query: '第二行' });
  assert.ok(Array.isArray(hits) && hits.length >= 1 && hits[0].snippet.indexOf('第二行') >= 0);
}

// 写：文本操作 + impact
{
  const r = callTool('append_to_block', { blockName: '第一章', text: '第四行' });
  assert.ok(r.ok);
  assert.equal(r.impact.wholeBlock, false);
  assert.ok(r.impact.chars > 0);
}
{
  const r = callTool('insert_at', { blockName: '第一章', anchor: 2, text: '插入行', mode: 'after', anchorType: 'line' });
  assert.equal(r.resultText, '第一行\n第二行\n插入行\n第三行', '按行号 after 插入');
}
{
  const r = callTool('insert_at', { blockName: '第一章', anchor: '第二行', text: 'X', mode: 'replace', anchorType: 'text' });
  assert.equal(r.resultText, '第一行\nX\n第三行', '原文精确匹配替换');
}
{
  const r = callTool('insert_at', { blockName: '第二章', anchor: '甲', text: '替换', mode: 'before', anchorType: 'text' });
  assert.equal(r.resultText, '替换\n甲\n乙');
}
{
  // 模糊回退：空白差异也能定位
  const r = callTool('insert_at', { blockName: '第一章', anchor: '第二行 ', text: 'Y', mode: 'after', anchorType: 'text' });
  assert.equal(r.resultText, '第一行\n第二行\nY\n第三行', '去空白模糊匹配');
}
console.log('agent.test.js OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.tools` undefined。

- [ ] **Step 3: 实现工具与 textOps**

```js
// 文本操作核心（纯函数，供工具与测试复用）
function normText(s) {
  if (!s) return '';
  return String(s)
    .replace(/[　\s]+/g, '')
    .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
}
function findAnchor(text, anchor, anchorType) {
  if (anchorType === 'line') {
    var lines = text.split('\n');
    var idx = (typeof anchor === 'number' ? anchor : parseInt(anchor, 10)) - 1;
    if (isNaN(idx) || idx < 0 || idx >= lines.length) return { error: '行号超出范围（共 ' + lines.length + ' 行）' };
    var start = 0;
    for (var i = 0; i < idx; i++) { start += lines[i].length + 1; }
    var end = start + lines[idx].length;
    return { start: start, end: end, line: lines[idx], lineNo: idx + 1 };
  }
  var q = String(anchor);
  var idxExact = text.indexOf(q);
  if (idxExact >= 0) return { start: idxExact, end: idxExact + q.length, lineNo: text.slice(0, idxExact).split('\n').length };
  // 模糊回退：归一化（去空白+全角标点→半角）后包含匹配（取首个），
  // 再按「非空白字符序号」映射回原文本偏移（起点=第 pos+1 个非空白字符，终点=再消费 qNorm.length 个非空白字符）。
  // 注：原计划贪心映射从文本头重匹配 qTrim，假起点会吞掉真匹配前导字符 → 静默损坏文本（Task 7 审查修复）。
  var qNorm = normText(q);
  var tNorm = normText(text);
  var pos = qNorm ? tNorm.indexOf(qNorm) : -1;
  if (pos >= 0) {
    var s = 0, cnt = 0;
    while (s < text.length && cnt <= pos) {
      if (!/\s/.test(text[s])) {
        if (cnt === pos) break;
        cnt++;
      }
      s++;
    }
    var e = s, consumed = 0;
    while (e < text.length && consumed < qNorm.length) {
      if (!/\s/.test(text[e])) consumed++;
      e++;
    }
    return { start: s, end: e, lineNo: text.slice(0, s).split('\n').length, fuzzy: true };
  }
  return { error: '未找到锚点「' + q.slice(0, 40) + '」' };
}

// before/after 语义 = 在锚点行前/后插入一整行（原计划 char-slice 会粘行，Task 7 审查修复）
function applyInsert(text, pos, ins, mode) {
  if (mode === 'replace') return text.slice(0, pos.start) + ins + text.slice(pos.end);
  var lines = text.split('\n');
  if (mode === 'after') lines.splice(pos.lineNo, 0, ins);
  else lines.splice(pos.lineNo - 1, 0, ins); // before 默认
  return lines.join('\n');
}

// impact.chars 为「变更量」= |编辑后总长 − 编辑前总长|（设计 §6：小改判定按改动幅度而非块总长，
// 否则任何 ≥500 字的块编辑都会误入 preview，'小改自动落盘'失效）
function computeImpact(blockName, resultText, wholeBlock, beforeText) {
  var lines = resultText.split('\n').length;
  var delta = Math.abs(resultText.length - (beforeText ? beforeText.length : 0));
  return { chars: delta, lines: lines, wholeBlock: !!wholeBlock, block: blockName };
}

var tools = {
  get_current_block: function () {
    if (!Agent.toolsDeps.getActiveBlock) return { error: '编辑器未就绪' };
    var b = Agent.toolsDeps.getActiveBlock();
    return { blockName: b.name, text: b.text };
  },
  list_blocks: function () {
    return Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : [];
  },
  read_block: function (a) {
    var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
    if (t === null || t === undefined) {
      var names = (Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : []).join('、');
      return { error: '未找到剧情块「' + a.blockName + '」，可用块：' + names };
    }
    return { blockName: a.blockName, text: t };
  },
  search_in_doc: function (a) {
    var q = String(a.query || '');
    if (!q) return { error: 'query 不能为空' };
    var out = [];
    var names = Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : [];
    for (var i = 0; i < names.length && out.length < 20; i++) {
      var t = Agent.toolsDeps.getBlockText(names[i]);
      if (!t) continue;
      var lines = t.split('\n');
      for (var j = 0; j < lines.length && out.length < 20; j++) {
        if (lines[j].indexOf(q) >= 0) out.push({ block: names[i], lineNo: j + 1, snippet: lines[j] });
      }
    }
    return out;
  },
  read_full_text: function () {
    var t = Agent.toolsDeps.fullText ? Agent.toolsDeps.fullText() : '';
    if (t.length > 50000) return { error: '全文过长（' + t.length + ' 字符），建议用 read_block 按块读取' };
    return { text: t };
  },
  read_settings: function () {
    return { settings: Agent.toolsDeps.settings ? Agent.toolsDeps.settings() : '' };
  },
  append_to_block: function (a) {
    if (!a.blockName || a.text === undefined) return { error: '缺少 blockName 或 text' };
    var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
    if (t === null || t === undefined) return { error: '未找到剧情块「' + a.blockName + '」' };
    var result = t + (t && !t.endsWith('\n') && !String(a.text).startsWith('\n') ? '\n' : '') + String(a.text);
    return { ok: true, block: a.blockName, resultText: result, impact: computeImpact(a.blockName, result, false, t) };
  },
  insert_at: function (a) {
    if (!a.blockName || a.anchor === undefined || a.text === undefined) return { error: '缺少 blockName/anchor/text' };
    var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
    if (t === null || t === undefined) return { error: '未找到剧情块「' + a.blockName + '」' };
    var mode = a.mode || 'before';
    if (mode !== 'before' && mode !== 'after' && mode !== 'replace') return { error: 'mode 无效：' + mode + '（应为 before/after/replace）' };
    var pos = findAnchor(t, a.anchor, a.anchorType || 'text');
    if (pos.error) return { error: pos.error };
    var result = applyInsert(t, pos, String(a.text), mode);
    // 整块替换必须标记 wholeBlock → 走预览确认（设计 §6）
    var wholeBlock = (mode === 'replace' && pos.start === 0 && pos.end === t.length);
    return { ok: true, block: a.blockName, resultText: result, impact: computeImpact(a.blockName, result, wholeBlock, t) };
  },
  apply_review_marker: function (a) {
    // 占位：复用审阅标记管线（Task 10 关联创作辅助时接通 editor 侧 applyGeneratedBlocks/审阅写入）
    return { error: 'apply_review_marker 待 UI 接线' };
  },
};
Agent.tools = tools;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): document editing tools (pure fns + anchored insert)"
```

---

### Task 8: applyAgentWrite + 会话内撤销记录

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

签名：`applyAgentWrite({block, resultText, impact}, deps, log)`。
职责：① `classifyWrite(impact)` 得级别；② 记录 `{block, before, after, level}` 到会话日志（供 UI 渲染与撤销）；③ 返回 `{level, block, before, after}` 让 UI 决定自动落盘/预览/确认——**本模块不做实际 DOM 写入**，写入由 UI 接线（Task 15/16）调用 deps 完成（`deps.commit(block, after)` 里做 `pushHistory + setText/setBlockText`）。这样模块可测且不依赖编辑器运行时。
撤销记录：`Agent.sessionWrites` 数组（最新在前，上限 50），`Agent.undoWrite(commitDeps)` 用 before 还原并出栈。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
{
  const log = [];
  const r = Agent.applyAgentWrite({ block: '第一章', resultText: '新文', impact: { chars: 10, lines: 1, wholeBlock: false } }, {}, log);
  assert.equal(r.level, 'auto');
  assert.equal(log.length, 1);
  assert.equal(log[0].block, '第一章');
  assert.equal(r.after, '新文');
}
{
  const r = Agent.applyAgentWrite({ block: '第一章', resultText: 'x'.repeat(600), impact: { chars: 600, lines: 1, wholeBlock: false } }, {}, []);
  assert.equal(r.level, 'preview');
}
{
  const log = [];
  Agent.sessionWrites = [{ block: 'B', before: '旧', after: '新', level: 'auto' }];
  const committed = [];
  Agent.undoWrite({ commit: (b, text) => committed.push([b, text]) });
  assert.deepEqual(committed, [['B', '旧']], 'undo 用 before 还原');
  assert.equal(Agent.sessionWrites.length, 0, '还原后出栈');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.applyAgentWrite` / `Agent.undoWrite` / `Agent.sessionWrites` undefined。

- [ ] **Step 3: 实现**

```js
// Agent 对象内加
sessionWrites: [],
applyAgentWrite: function (w, deps, log) {
  var level = Agent.classifyWrite(w.impact || {});
  var rec = { block: w.block, before: w.before !== undefined ? w.before : null, after: w.resultText, level: level, impact: w.impact || {} };
  Agent.sessionWrites.unshift(rec);
  if (Agent.sessionWrites.length > 50) Agent.sessionWrites.pop();
  if (log && typeof log.push === 'function') log.push(rec);
  return rec;
},
undoWrite: function (commitDeps) {
  var rec = Agent.sessionWrites.shift();
  if (!rec) return null;
  if (commitDeps && commitDeps.commit && rec.before !== null) commitDeps.commit(rec.block, rec.before);
  return rec;
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): applyAgentWrite classification + session undo records"
```

---

### Task 9: 变量工具（直接读写 master 现有格式）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

依赖注入：`Agent.toolsDeps.getVars` / `saveVars`（UI 接线时指向 `window.Storage.getVars/saveVars`，storage.js:666-676）。变量格式 `{name, type:'number'|'text'|'boolean', value}`（storage.js:602）。命名规则：`/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/`（不能数字开头，editor.js:2886）。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
function mockVars(initial) {
  let vars = initial || [];
  Agent.toolsDeps = {
    getVars: () => vars,
    saveVars: (arr) => { vars = arr; },
  };
  return () => vars;
}
{
  const get = mockVars([{ name: '金币', type: 'number', value: 10 }]);
  assert.deepEqual(Agent.tools.list_vars(), [{ name: '金币', type: 'number', value: 10 }]);
  assert.deepEqual(Agent.tools.read_var({ name: '金币' }), { name: '金币', type: 'number', value: 10 });
  assert.ok(Agent.tools.read_var({ name: '没有' }).error, '不存在的变量报错');
}
{
  const get = mockVars([]);
  const r = Agent.tools.create_var({ name: '金币', type: 'number', value: 100 });
  assert.ok(r.ok);
  assert.equal(get()[0].name, '金币');
  assert.ok(Agent.tools.create_var({ name: '1bad', type: 'number', value: 1 }).error, '数字开头拒绝');
  assert.ok(Agent.tools.create_var({ name: '金币', type: 'number', value: 1 }).error, '重名拒绝');
}
{
  const get = mockVars([{ name: '金币', type: 'number', value: 10 }]);
  Agent.tools.set_var({ name: '金币', value: 50 });
  assert.equal(get()[0].value, 50);
  assert.ok(Agent.tools.set_var({ name: '金币', value: 'abc' }).error, 'number 类型拒绝非数值');
  Agent.tools.update_var({ name: '金币', op: '+', delta: 10 });
  assert.equal(get()[0].value, 60);
  Agent.tools.delete_var({ name: '金币' });
  assert.equal(get().length, 0);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.tools.list_vars` 等 undefined。

- [ ] **Step 3: 实现变量工具**

```js
// Agent 对象内：tools 表追加
list_vars: function () {
  return Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : [];
},
read_var: function (a) {
  var v = (Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : []).find(function (x) { return x.name === a.name; });
  if (!v) return { error: '未找到变量「' + a.name + '」' };
  return v;
},
create_var: function (a) {
  var RE = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/;
  if (!RE.test(String(a.name || ''))) return { error: '变量名只能 字母/数字/下划线/中文 且不能数字开头' };
  var vars = Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : [];
  if (vars.some(function (x) { return x.name === a.name; })) return { error: '已存在同名变量「' + a.name + '」' };
  var type = a.type === 'text' || a.type === 'boolean' ? a.type : 'number';
  if (type === 'number' && a.value !== undefined && isNaN(Number(a.value))) return { error: 'number 类型变量初值必须是数值' };
  vars = vars.concat([{ name: a.name, type: type, value: a.value !== undefined ? a.value : (type === 'number' ? 0 : type === 'boolean' ? false : '') }]);
  if (Agent.toolsDeps.saveVars) Agent.toolsDeps.saveVars(vars);
  return { ok: true, name: a.name, type: type, value: vars[vars.length - 1].value };
},
delete_var: function (a) {
  var vars = Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : [];
  if (!vars.some(function (x) { return x.name === a.name; })) return { error: '未找到变量「' + a.name + '」' };
  if (Agent.toolsDeps.saveVars) Agent.toolsDeps.saveVars(vars.filter(function (x) { return x.name !== a.name; }));
  return { ok: true, name: a.name, destructive: true };
},
set_var: function (a) {
  var vars = Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : [];
  var v = vars.find(function (x) { return x.name === a.name; });
  if (!v) return { error: '未找到变量「' + a.name + '」' };
  if (v.type === 'number' && isNaN(Number(a.value))) return { error: 'number 类型变量必须赋数值' };
  if (v.type === 'boolean') v.value = a.value === true || a.value === 'true' || a.value === 1;
  else v.value = v.type === 'number' ? Number(a.value) : String(a.value);
  if (Agent.toolsDeps.saveVars) Agent.toolsDeps.saveVars(vars);
  return { ok: true, name: a.name, value: v.value };
},
update_var: function (a) {
  var vars = Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : [];
  var v = vars.find(function (x) { return x.name === a.name; });
  if (!v) return { error: '未找到变量「' + a.name + '」' };
  if (v.type !== 'number') return { error: '只有 number 类型支持加减' };
  var d = Number(a.delta);
  if (isNaN(d)) return { error: 'delta 必须是数值' };
  v.value = a.op === '-' ? v.value - d : v.value + d;
  if (Agent.toolsDeps.saveVars) Agent.toolsDeps.saveVars(vars);
  return { ok: true, name: a.name, value: v.value };
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): variable tools (direct read/write of master format)"
```

---

### Task 10: 结构组工具（建/删/改名剧情块）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

依赖注入：`Agent.toolsDeps.listBlocks / getBlockText / saveBlocks(blocksObj)`、`blocksDoc`（正文分块视图，`() => { 块名: 文本 }`，供 rename/delete 同步引用）。块命名规则沿用 storage.js:285（中文/字母/数字/下划线，`/^[A-Za-z0-9_\u4e00-\u9fa5]+$/` 且不空）。
- `create_block`：重名拒绝；`saveBlocks` 加空块。
- `rename_block`：同步所有块正文里的 `<<剧情块:旧名>>` 标记与 `<选项:"…",旧名…>` 跳转目标（含条件行）为 `新名`；返回改动统计。
- `delete_block`：扫描所有块正文的 `<选项:"…",旧名>` 引用，返回 `{references:[{block,lineNo}]}`；**`destructive:true`**。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
function mockBlocks() {
  const blocks = { '第一章': '正文一', '第二章': '甲\n<选项:"去第一章",第一章>' };
  Agent.toolsDeps = Object.assign(Agent.toolsDeps || {}, {
    listBlocks: () => Object.keys(blocks),
    getBlockText: (n) => (n in blocks ? blocks[n] : null),
    saveBlocks: (obj) => { for (const k in obj) blocks[k] = obj[k]; for (const k of Object.keys(blocks)) if (!(k in obj)) delete blocks[k]; },
    blocksDoc: () => blocks,
  });
  return () => blocks;
}
{
  const get = mockBlocks();
  const r = Agent.tools.create_block({ blockName: '番外' });
  assert.ok(r.ok);
  assert.ok('番外' in get());
  assert.ok(Agent.tools.create_block({ blockName: '番外' }).error, '重名拒绝');
}
{
  const get = mockBlocks();
  const r = Agent.tools.rename_block({ oldName: '第一章', newName: '序章' });
  assert.ok(r.ok);
  assert.ok('序章' in get() && !('第一章' in get()));
  assert.ok(get()['第二章'].indexOf('第一章>') >= 0, '选项跳转引用应同步为新块名');
}
{
  const get = mockBlocks();
  const r = Agent.tools.delete_block({ blockName: '第一章' });
  assert.ok(r.destructive, '删除块必须标记 destructive');
  assert.ok(Array.isArray(r.references) && r.references.length >= 1, '必须报告其他块的跳转引用');
  assert.equal(r.references[0].block, '第二章');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.tools.create_block` 等 undefined。

- [ ] **Step 3: 实现结构组工具**

```js
// tools 表追加
create_block: function (a) {
  var name = String(a.blockName || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(name)) return { error: '块名只允许 中文/字母/数字/下划线' };
  var blocks = (Agent.toolsDeps.blocksDoc ? Agent.toolsDeps.blocksDoc() : {}) || {};
  if (name in blocks) return { error: '已存在同名剧情块「' + name + '」' };
  blocks[name] = '';
  if (Agent.toolsDeps.saveBlocks) Agent.toolsDeps.saveBlocks(blocks);
  return { ok: true, blockName: name };
},
rename_block: function (a) {
  var oldN = String(a.oldName || ''), newN = String(a.newName || '').trim();
  var blocks = (Agent.toolsDeps.blocksDoc ? Agent.toolsDeps.blocksDoc() : {}) || {};
  if (!(oldN in blocks)) return { error: '未找到剧情块「' + oldN + '」' };
  if (newN in blocks) return { error: '已存在同名剧情块「' + newN + '」' };
  blocks[newN] = blocks[oldN];
  delete blocks[oldN];
  // 同步引用：正文分块标记 <<剧情块:旧名>> 与选项跳转 <选项:"…",旧名…> / <选项:"…",旧名,条件:…>
  var reTag = new RegExp('<<剧情块:' + oldN + '>>', 'g');
  var reOpt = new RegExp('(<选项:"[^"]*",\\s*)' + oldN + '(?=\\s*(,|>))', 'g');
  var changed = 0;
  for (var k in blocks) {
    var t = blocks[k];
    var t2 = t.replace(reTag, '<<剧情块:' + newN + '>>').replace(reOpt, '$1' + newN);
    if (t2 !== t) { blocks[k] = t2; changed++; }
  }
  if (Agent.toolsDeps.saveBlocks) Agent.toolsDeps.saveBlocks(blocks);
  return { ok: true, oldName: oldN, newName: newN, blocksUpdated: changed };
},
delete_block: function (a) {
  var name = String(a.blockName || '');
  var blocks = (Agent.toolsDeps.blocksDoc ? Agent.toolsDeps.blocksDoc() : {}) || {};
  if (!(name in blocks)) return { error: '未找到剧情块「' + name + '」' };
  var reOpt = new RegExp('<选项:"[^"]*",\\s*' + name + '(?=\\s*(,|>))');
  var refs = [];
  for (var k in blocks) {
    if (k === name) continue;
    var lines = String(blocks[k]).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (reOpt.test(lines[i])) refs.push({ block: k, lineNo: i + 1, snippet: lines[i].slice(0, 60) });
    }
  }
  return { ok: true, blockName: name, destructive: true, references: refs };
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): structure tools (create/rename/delete blocks)"
```

---

### Task 11: 创作辅助组（extract_clues / generate_options）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

依赖注入：`Agent.toolsDeps.extractClues(opts)`（UI 接线时指向 `window.AI.extractClues`，ai.js:1086）与 `Agent.toolsDeps.applyGeneratedBlocks(blocks)`（指向 `window.StoryEditorApi.applyGeneratedBlocks`）。模块内只做**调用与结果/语法校验**，不直接调 AI。
- `extract_clues`：deps.extractClues({...}) 调用 → 返回 {ok, clues} 或透传错误。
- `generate_options`：模型已产出 `<选项:"文字",块名,条件:…>` 文本（参数 `text`）→ 校验每行格式（`/^<选项:"[^"]*",[^>]+>$/` 且含块名）→ deps.applyGeneratedBlocks 写入；返回 {ok, count}。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
{
  const calls = [];
  Agent.toolsDeps.extractClues = (opts) => { calls.push(opts); return { ok: true, clues: '线索A' }; };
  const r = Agent.tools.extract_clues({ blockName: '第一章' });
  assert.ok(r.ok && r.clues === '线索A');
  assert.equal(calls.length, 1);
}
{
  const applied = [];
  Agent.toolsDeps.applyGeneratedBlocks = (blocks) => { applied.push(blocks); return { ok: true }; };
  const r = Agent.tools.generate_options({ text: '<选项:"A",块A>\n<选项:"B",块B,条件:金币>5>' });
  assert.ok(r.ok);
  assert.equal(r.count, 2);
  assert.equal(applied.length, 1);
}
{
  const r = Agent.tools.generate_options({ text: '这不是选项' });
  assert.ok(r.error, '格式不合法报错');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.tools.extract_clues` 等 undefined。

- [ ] **Step 3: 实现**

```js
// tools 表追加
extract_clues: function (a) {
  if (!Agent.toolsDeps.extractClues) return { error: '线索提取管线未接线' };
  try {
    var r = Agent.toolsDeps.extractClues(a.blockName ? { blockName: a.blockName } : {});
    return r && r.ok ? { ok: true, clues: r.clues || r.text || '' } : { error: (r && r.error) || '提取失败' };
  } catch (e) { return { error: '提取异常：' + e.message }; }
},
generate_options: function (a) {
  if (!a.text) return { error: '缺少 text' };
  var lines = String(a.text).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  var ok = [], bad = [];
  for (var i = 0; i < lines.length; i++) {
    if (/^<选项:"[^"]*",\s*[^>]+(?:,\s*条件:[\s\S]*)?>$/.test(lines[i])) ok.push(lines[i]);
    else bad.push(lines[i]);
  }
  if (!ok.length) return { error: '没有合法的 <选项:"文字",块名[,条件:…]> 行' };
  if (Agent.toolsDeps.applyGeneratedBlocks) Agent.toolsDeps.applyGeneratedBlocks(ok);
  return { ok: true, count: ok.length, invalid: bad.length };
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): creative-assist tools (extract_clues/generate_options)"
```

---

### Task 12: 素材组工具（元数据管理）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

依赖注入：`Agent.toolsDeps.getAllAssets()/renameAsset(old,new)/deleteAsset(name)/exportProject()`（UI 接线时指向 `window.Storage` 对应方法，storage.js:683）。
素材记录结构含 `name/type/tags` 及 dataURL 二进制——**list_assets 必须脱敏**（只回 name/type/tags，不含 dataURL/base64）。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
{
  const assets = [{ name: 'bg1', type: 'image', tags: ['背景'], dataURL: 'data:image/png;base64,AAAA' }];
  Agent.toolsDeps.getAllAssets = () => assets;
  Agent.toolsDeps.renameAsset = (o, n) => { assets[0].name = n; return { ok: true }; };
  Agent.toolsDeps.deleteAsset = (n) => { return { ok: true }; };
  Agent.toolsDeps.exportProject = () => ({ format: 'story-editor-project' });
  const l = Agent.tools.list_assets({});
  assert.ok(Array.isArray(l));
  assert.equal(l[0].name, 'bg1');
  assert.equal(l[0].dataURL, undefined, 'list_assets 必须脱敏，不含 dataURL');
  assert.ok(Agent.tools.rename_asset({ name: 'bg1', newName: '夜晚森林' }).ok);
  assert.ok(Agent.tools.delete_asset({ name: 'bg1' }).destructive, '删素材必须 destructive');
  assert.equal(Agent.tools.export_project({}).format, 'story-editor-project');
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.tools.list_assets` 等 undefined。

- [ ] **Step 3: 实现**

```js
// tools 表追加
list_assets: function () {
  var all = Agent.toolsDeps.getAllAssets ? Agent.toolsDeps.getAllAssets() : [];
  return all.map(function (a) {
    var out = { name: a.name, type: a.type };
    if (a.tags) out.tags = a.tags;
    return out;
  });
},
rename_asset: function (a) {
  if (!Agent.toolsDeps.renameAsset) return { error: '素材系统未接线' };
  var r = Agent.toolsDeps.renameAsset(a.name, a.newName);
  return r && r.ok ? { ok: true, name: a.name, newName: a.newName } : { error: (r && r.error) || '改名失败' };
},
delete_asset: function (a) {
  if (!Agent.toolsDeps.deleteAsset) return { error: '素材系统未接线' };
  var r = Agent.toolsDeps.deleteAsset(a.name);
  return r && r.ok ? { ok: true, name: a.name, destructive: true } : { error: (r && r.error) || '删除失败' };
},
export_project: function () {
  if (!Agent.toolsDeps.exportProject) return { error: '导出未接线' };
  var r = Agent.toolsDeps.exportProject();
  return r ? { ok: true, format: r.format, exportedAt: r.exportedAt } : { error: '导出失败' };
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): asset metadata tools (list/rename/delete/export)"
```

---

### Task 13: runLoop（意图轮 → 装配 → 工具循环）

**Files:**
- Modify: `js/agent.js`
- Modify: `tests/agent.test.js`

签名：`runLoop(opts, deps)`，返回 Promise。
`opts = { userText, history, activeScenario, callbacks: { onStatus, onTool, onWrite, onReply } }`
`deps = { request(messages, toolOpts), buildCtx() }` —— `request` 封装 `AI.callDeepseek`（UI 接线时注入，测试注入 mock）。

流程：
1. 若 `opts.activeScenario` 为 null 且 userText 不是延续语 → **意图轮**：`request([{role:'system',content:INTENT_SYSTEM},{role:'user',content:userText}], {thinking:'disabled', max_tokens:512})` → `intentParse` → 选场景（含 needs 提示）
2. 延续语判定 `isContinuation(text)`：`/^(确认|继续|再来|换一种|再多写点|然后呢|接着写|好的|可以|ok|apply|继续写|所以呢|还有呢)/i`
3. `buildMessages(scenario, ctx, userText)` → 工具循环：
   - `messages` 基础上调 `request(messages, {tools: 场景白名单展开的函数定义, thinking:'disabled'})`（thinking 结论按 Task 1 结果，默认 disabled）
   - 响应含 `toolCalls` → 逐个执行 `Agent.tools[name]`（白名单校验）→ `messages.push({role:'tool', tool_call_id, content: JSON.stringify(result)})` → 继续（≤8 轮）
   - 无 toolCalls → 回调 onReply(文本) 结束
4. 轮数上限：超出 → onStatus('loop_limit') + 结束
5. 工具结果中含 `resultText` 的写操作 → `applyAgentWrite` → `onWrite(rec)`（UI 据此分级渲染）
6. 任何一步抛错 → onStatus('error', msg)

工具定义（functions 数组）由场景白名单过滤生成：`buildToolDefs(scenario)` 从固定 `TOOL_DEFS` 常量取（name/description/parameters），白名单为 `['*']` 时全量。

- [ ] **Step 1: 追加失败测试**

```js
// tests/agent.test.js 追加
async function fakeRequest() {
  const calls = [];
  function req(messages, toolOpts) {
    calls.push({ messages, tools: toolOpts && toolOpts.tools });
    const last = messages[messages.length - 1];
    if (last && last.role === 'tool') {
      return { content: '已处理', toolCalls: null };
    }
    // 第一轮：意图轮或工具轮，返回工具调用
    const isIntent = messages.length === 2 && messages[0].role === 'system' && /意图/.test(messages[0].content);
    if (isIntent) return { content: '{"scenario":"polish","needs":["current_block"],"note":""}' };
    if (toolOpts && toolOpts.tools && toolOpts.tools.length) {
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'get_current_block', arguments: '{}' } }] };
    }
    return { content: '最终答复', toolCalls: null };
  }
  return { calls, req };
}
{
  const f = await fakeRequest();
  const events = [];
  await Agent.runLoop({ userText: '润色一下', activeScenario: null, callbacks: { onStatus: (s) => events.push(s), onTool: () => {}, onWrite: () => {}, onReply: (t) => events.push('reply:' + t) } }, { request: f.req, buildCtx: () => ({ outline: 'o', settings: 's', currentBlock: { name: '第一章', text: 't' }, fullText: '', vars: [] }) });
  assert.ok(events.includes('reply:最终答复'), '最终答复必须回调');
  assert.ok(f.calls.length >= 3, '意图轮 + 工具轮 + 答复轮至少 3 次请求');
  assert.equal(f.calls[0].messages.length, 2, '意图轮只有 system+user 两条（前缀最小）');
}
{
  // 延续语跳过意图轮
  const f = await fakeRequest();
  const started = [];
  await Agent.runLoop({ userText: '继续', activeScenario: 'polish', callbacks: { onStatus: () => {}, onTool: () => {}, onWrite: () => {}, onReply: () => {} } }, { request: f.req, buildCtx: () => ({}) });
  assert.ok(f.calls[0].messages[0].content.indexOf('局部改稿') >= 0, '延续语直接进场景轮，无意图轮');
}
console.log('agent.test.js OK');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/agent.test.js`
Expected: FAIL——`Agent.runLoop` undefined。

- [ ] **Step 3: 实现 runLoop 与配套**

```js
// Agent 对象内
INTENT_SYSTEM: '你是意图识别器。根据用户对剧情编辑器（剧情块/选项/变量/素材/线索）的请求，输出 JSON：{"scenario":"polish|rewrite|design|vars|general","needs":["需要的上下文项"],"note":"一句话理解"}。polish=局部润色/改稿（只读当前块）；rewrite=整篇改写/续写（需全文）；design=剧情问答/设计（需大纲+设定）；vars=变量/逻辑操作（需变量库）；无法归类用 general。只输出 JSON，不要其它文字。',
isContinuation: function (text) {
  return /^(确认|继续|再来|换一种|再多写点|然后呢|接着写|好的|可以|ok|apply|继续写|所以呢|还有呢)/i.test(String(text || '').trim());
},
buildToolDefs: function (scenario) {
  var allow = AGENT_SCENARIOS[scenario] ? AGENT_SCENARIOS[scenario].tools : [];
  if (!allow.length) return [];
  var names = allow.indexOf('*') >= 0 ? Object.keys(Agent.tools) : allow;
  return names.filter(function (n) { return TOOL_DEFS[n]; }).map(function (n) { return TOOL_DEFS[n]; });
},
runLoop: async function (opts, deps) {
  var cb = opts.callbacks || {};
  var scenario = opts.activeScenario;
  try {
    if (!scenario) {
      if (Agent.isContinuation(opts.userText)) {
        scenario = 'general';
      } else {
        cb.onStatus && cb.onStatus('intent');
        var intentMsgs = [{ role: 'system', content: Agent.INTENT_SYSTEM }, { role: 'user', content: opts.userText }];
        var intentRes = await deps.request(intentMsgs, { thinking: { type: 'disabled' }, max_tokens: 512 });
        scenario = Agent.intentParse(typeof intentRes === 'string' ? intentRes : (intentRes && intentRes.content)).scenario;
        cb.onStatus && cb.onStatus('scenario:' + scenario);
      }
    }
    var ctx = deps.buildCtx ? deps.buildCtx() : {};
    var messages = Agent.buildMessages(scenario, ctx, opts.userText, {});
    var rounds = 0;
    while (rounds < 8) {
      rounds++;
      cb.onStatus && cb.onStatus('thinking');
      var toolDefs = Agent.buildToolDefs(scenario);
      var resp = await deps.request(messages, { tools: toolDefs.length ? toolDefs : undefined, tool_choice: toolDefs.length ? 'auto' : undefined, thinking: { type: 'disabled' } });
      var text = typeof resp === 'string' ? resp : (resp && resp.content) || '';
      var toolCalls = resp && resp.toolCalls;
      if (!toolCalls || !toolCalls.length) {
        cb.onReply && cb.onReply(text);
        return { scenario: scenario, rounds: rounds, finalText: text };
      }
      var results = [];
      for (var i = 0; i < toolCalls.length; i++) {
        var fn = toolCalls[i].function;
        var name = fn && fn.name;
        var args = {};
        try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch (e) { args = {}; }
        cb.onTool && cb.onTool({ name: name, args: args });
        var impl = Agent.tools[name];
        var result;
        if (!impl) result = { error: '未知工具：' + name };
        // ⚠️ 必须 await：素材组工具是 async（接线层 deps 走 IndexedDB，storage.js:331/372/377/613）；
        // 同步工具（文档/变量/结构组）的返回值 await 也无害。不 await 会把 Promise 当结果，
        // JSON.stringify(Promise) = '{}'，模型会拿到空对象。
        else result = await impl(args);
        if (result && result.resultText) {
          var rec = Agent.applyAgentWrite({ block: result.block, before: args.__before, resultText: result.resultText, impact: result.impact }, deps, null);
          cb.onWrite && cb.onWrite(rec);
        }
        results.push({ tool_call_id: toolCalls[i].id, role: 'tool', content: JSON.stringify(result || {}) });
      }
      messages = messages.concat(results);
    }
    cb.onStatus && cb.onStatus('loop_limit');
    cb.onReply && cb.onReply('任务步骤过多，已停止。建议拆成更小的步骤，或先撤销不想要的改动。');
    return { scenario: scenario, rounds: rounds, finalText: null, loopLimit: true };
  } catch (e) {
    cb.onStatus && cb.onStatus('error', e && e.message);
    cb.onReply && cb.onReply('出错了：' + (e && e.message));
    return { scenario: scenario, error: e };
  }
},
```

配套常量（Agent 对象内）：`TOOL_DEFS`——为每个工具写 name/description/parameters（description 用中文明确「该工具会修改文档/变量，需分级确认」等行为），parameters 用 `{type:'object', properties:{...}, required:[...]}` 精简描述即可（本任务给全 5 组 22 个工具的 defs，字段与 Task 7-12 工具签名一致）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/agent.test.js`
Expected: `agent.test.js OK`。

- [ ] **Step 5: Commit**

```bash
git add js/agent.js tests/agent.test.js
git commit -m "feat(agent): runLoop tool-calling loop with intent routing"
```

---

### Task 14: index.html — modal + 入口 + 引用

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 引入 agent.js**

在 `<script src="js/ai.js?v=...">` 之后加 `<script src="js/agent.js?v=..."></script>`（`?v=` 沿用当前版本串，Task 17 统一 bump）。

- [ ] **Step 2: 加 AI 菜单项**

在 AI 菜单（editor.js:8143 对应按钮组所在 HTML）「全文助理」项旁新增：
```html
<button class="ai-menu-item" data-special="openAgent" type="button">
  <svg class="ico" aria-hidden="true"><use href="#ic-brain"/></svg> Agent 对话（全能助理，可读写文档/变量/素材）
</button>
```

- [ ] **Step 3: 加 modal 骨架（仿 #fulltext-assistant，:772-796 之后）**

```html
<div id="agent-assistant" class="modal hidden" role="dialog" aria-modal="true" aria-label="Agent 对话">
  <div class="modal-box fta-box">
    <div class="modal-title">
      <span>Agent 对话</span>
      <span id="agent-scenario-tag" class="badge hidden"></span>
      <button id="agent-close" class="btn btn-ghost btn-sm" type="button">✕</button>
    </div>
    <div id="agent-messages" class="fta-messages"></div>
    <div id="agent-start-wrap" class="fta-start-wrap"><button id="agent-start" class="btn btn-primary" type="button">开始对话</button></div>
    <div id="agent-input-row" class="fta-input-row hidden">
      <textarea id="agent-input" placeholder="描述你想让 Agent 做的事…"></textarea>
      <button id="agent-send" class="btn btn-primary" type="button">发送</button>
      <button id="agent-stop" class="btn btn-ghost hidden" type="button">停止</button>
    </div>
    <div id="agent-actions" class="fta-actions hidden">
      <button id="agent-clear" class="btn btn-ghost btn-sm" type="button">清空对话</button>
      <button id="agent-refeed" class="btn btn-ghost btn-sm" type="button">重读当前文档</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: 本地肉眼检查**

打开 index.html（或 build_inline 产物）确认 modal 默认隐藏、入口按钮出现。

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(ui): agent-assistant modal skeleton + entry"
```

---

### Task 15: editor.js 接线（openAgent / 持久化 / 切工程 / hideAllAI）

**Files:**
- Modify: `js/editor.js`

实现（仿 FTA 模式，editor.js:6673-6759）：
- `openAgent()`：`window.Agent` 存在且设置 key 有值（`AI.loadSettings().key`）→ 显示 `#agent-assistant`、加载 `agent-history:<pid>`、显示开始/输入区；无 key → toast「请先在设置→AI 编剧填写 DeepSeek API Key」+ `openSettings('ai')`
- 绑定：`#agent-close` 关闭；`#agent-send` 发送（跑 `Agent.runLoop`）；`#agent-stop` 中止（`agentAbort.abort()`）；`#agent-clear` 清历史；`#agent-refeed` 重建上下文
- `agentResetSession()`：`agentSessionGen++` + abort + 清空内存态；挂在切工程钩子（与 `ftResetSession` 同处，editor.js:1412 附近）
- `applyHideAllAI`（editor.js:7348）：追加隐藏 `#agent-assistant` modal 与 `openAgent` 菜单项
- 持久化：`agentHistoryKey()='agent-history:'+pid`（pid 取法同 ftHistoryKey，editor.js:6676）；保存 `[{role, content, _id}]`（只 user/assistant，不存工具消息——重载时由 runLoop 重建）
- deps 接线（模块内一次性赋值）：
  ```js
  if (window.Agent) {
    Agent.toolsDeps = {
      getActiveBlock: () => StoryEditorApi.getActiveBlock ? { name: StoryEditorApi.getActiveBlock(), text: storyText.value } : { name: '主剧情', text: storyText.value },
      listBlocks: () => StoryEditorApi.listBlockNames ? StoryEditorApi.listBlockNames() : [],
      getBlockText: (n) => StoryEditorApi.getBlockText ? StoryEditorApi.getBlockText(n) : null,
      fullText: () => { /* 拼接全部块，同 ftaCollectFullText */ },
      settings: () => { /* 创作设定/世界观/文风/线索拼接，同 ftBuildContext */ },
      getVars: () => window.Storage.getVars(), saveVars: (a) => window.Storage.saveVars(a),
      blocksDoc: () => { /* loadBlocks 视图 */ },
      saveBlocks: (b) => window.Storage.saveBlocks(b),
      // ⚠️ seam 修正（Task 11 code quality review 折叠项）：window.AI.extractClues（ai.js:1126）是 async、
      // 返回 {clues, summary} 无 ok 字段、参数是 {outline,intro,world,style,body,existing,signal,onStatus}
      // 而非 {blockName}。必须适配：await + 补 ok；blockName → 读该块全文作 body。
      extractClues: async (o) => {
        try {
          const opts = {};
          if (o && o.blockName) { const t = StoryEditorApi.getBlockText ? StoryEditorApi.getBlockText(o.blockName) : null; if (t != null) opts.body = t; }
          const r = await window.AI.extractClues(opts);
          return { ok: true, clues: (r && (r.clues || r.text)) || '' };
        } catch (e) { return { error: (e && e.message) || '提取失败' }; }
      },
      // ⚠️ seam 修正：StoryEditorApi.applyGeneratedBlocks（editor.js:7985）接收「字符串全文」并覆盖 MAIN_BLOCK——
      // 绝不能把 generate_options 的选项数组直接喂给它（会覆盖主剧情）。generate_options 契约=逐选项数组
      // （同行拼接已拆条，Task 11 修复 2c79a09）。接线层写适配器：选项追加到当前编辑块末尾，走 commitAgentWrite
      // （pushHistory + 保存），保证可撤销。
      applyGeneratedBlocks: (options) => {
        const block = (StoryEditorApi.getActiveBlock && StoryEditorApi.getActiveBlock()) || '主剧情';
        const cur = StoryEditorApi.getBlockText ? StoryEditorApi.getBlockText(block) : null;
        const curText = (cur != null) ? cur : storyText.value;
        const text = options.join('\n');
        commitAgentWrite(block, curText.endsWith('\n') ? curText + text : curText + '\n' + text);
        return { ok: true };
      },
      // ⚠️ seam 修正（Task 12 spec review 折叠项）：window.Storage 素材方法是 async + lib/id/pid 签名
      // （getAllAssets(lib) storage.js:331、deleteAsset(lib,id) :372、renameAsset(lib,id,newName) :377、
      // exportProject(pid) :613），而工具契约是同步无参 getAllAssets()/renameAsset(name,newName)/
      // deleteAsset(name)/exportProject()。必须写 adapter：await + 合并全部 lib（background/item/overlay/
      // music/sound，editor.js:2728-2753）+ name→{lib,id} 映射（素材记录 name 与 id 是两个字段）。
      // 素材工具本体已 async（Task 12 修复 1e4d555），deps 返回 Promise 会被 await。
      // lib 合并：AGENT_ASSET_LIBS = ['background','item','overlay','music','sound'];
      // name→{lib,id}：从 (await Storage.getAllAssets(lib)) 里找 rec.name===name。
      getAllAssets: async () => {
        const out = [];
        for (const lib of ['background', 'item', 'overlay', 'music', 'sound']) {
          try { out.push.apply(out, await window.Storage.getAllAssets(lib)); } catch (e) { /* 跳过该库 */ }
        }
        return out;
      },
      renameAsset: async (name, newName) => {
        for (const lib of ['background', 'item', 'overlay', 'music', 'sound']) {
          const recs = await window.Storage.getAllAssets(lib).catch(() => []);
          const rec = recs.find(r => r.name === name);
          if (rec) { await window.Storage.renameAsset(lib, rec.id, newName); return { ok: true }; }
        }
        return { error: '素材不存在' };
      },
      deleteAsset: async (name) => {
        for (const lib of ['background', 'item', 'overlay', 'music', 'sound']) {
          const recs = await window.Storage.getAllAssets(lib).catch(() => []);
          const rec = recs.find(r => r.name === name);
          if (rec) { await window.Storage.deleteAsset(lib, rec.id); return { ok: true }; }
        }
        return { error: '素材不存在' };
      },
      exportProject: async () => await window.Storage.exportProject(window.Storage.getCurrentProjectId()),
    };
  }
  ```
  （注：`insertBlockOption(name, offset)`（editor.js:3274）是生成 `<选项:"文字",块名>` 占位用的，不解析既有选项文本，不能用于写入 generate_options 的完整选项行；`extract_clues` 结果只回显给用户，不自动改文档——由模型后续用写工具决定是否落库。）
- 提交函数：`commitAgentWrite(block, text)` = `pushHistory()` + （block 是当前块 → `storyText.value = text`（setter 自动保存，editor.js:1617）；否则 `window.Storage.setBlockText(block, text)` 后若该块在编辑器打开则刷新）
- 分级 UI 渲染回调（`onWrite`）见 Task 16

- [ ] **Step 1: 实现上述接线（含 deps、commitAgentWrite、持久化、openAgent、agentResetSession、hideAllAI 联动、发送/停止/清空/重读事件）**
- [ ] **Step 2: 浏览器自测（dev 环境）**
  - 无 key → 提示去设置
  - 有 key → 发「把当前块第二行润色」→ 意图轮 → polish → 工具调用卡片出现 → 最终答复
  - 打开设置「隐藏所有 AI」→ Agent 入口消失
- [ ] **Step 3: Commit**

```bash
git add js/editor.js
git commit -m "feat(agent): editor wiring (openAgent/persistence/reset/hideAllAI)"
```

---

### Task 16: UI 确认流（分级写入渲染）

**Files:**
- Modify: `js/editor.js`
- Modify: `index.html`

`onWrite(rec)` 回调实现：
- `rec.level==='auto'`：渲染「✏️ 已改《块名》+N 行 [撤销]」气泡，立即 `commitAgentWrite(block, after)`；[撤销] 点击 → `Agent.undoWrite({commit: commitAgentWrite})`
- `rec.level==='preview'`：渲染 diff 预览卡片（`before`/`after` 两段，`<pre>` 对照 + 差异行高亮），按钮「应用」→ `commitAgentWrite` + 气泡转「已应用 [撤销]」；「忽略」→ 丢弃（`Agent.sessionWrites.shift()` 移除该记录）
- `rec.level==='destructive'`：在 preview 基础上追加红色警示行（`references` 列表「其他块 N 处跳转引用」）与「确认删除」按钮（二次确认）
- 工具活动卡片（`onTool`）：`🔧 read_block {blockName:"第二章"} → 已执行`，工具名高亮
- 场景标签（`onStatus` 的 `scenario:X`）：`#agent-scenario-tag` 显示当前场景中文名（polish→润色改稿 / rewrite→整篇改写 / design→剧情设计 / vars→变量逻辑 / general→通用）
- 「停止」按钮在 runLoop 期间显示（`onStatus:'thinking'` 显示、`reply` 隐藏），点击 `agentAbort.abort()`

index.html 增补：预览卡片区域 CSS（`.agent-diff-card` 等，沿用现有 modal 样式体系）。

- [ ] **Step 1: 实现 onWrite/onTool/onStatus 渲染 + 撤销/应用/忽略/确认按钮逻辑 + abort 接线**
- [ ] **Step 2: 浏览器自测**
  - 小改：自动落盘 + ✏️ + 撤销生效
  - 大改：预览卡片 → 应用/忽略
  - 删除块：二次确认 → 生效
- [ ] **Step 3: Commit**

```bash
git add js/editor.js index.html
git commit -m "feat(agent): tiered write confirmation UI"
```

---

### Task 17: 回归、缓存标识、构建、部署（测试版流程）

**Files:**
- Modify: `index.html`（`?v=` 与 app-version bump）
- Modify: 按 `tests/release-cache-bust.test.js` 要求核对版本串

- [ ] **Step 1: 更新版本标识**

按项目惯例（AGENTS.md）：改 `index.html` 中所有 `?v=`（含 `js/agent.js?v=`）与 app-version 为同一新版本串（如 `v25.4.61` 或项目当前惯例递增；以 `tests/release-cache-bust.test.js` 断言的精确格式为准，先读该文件确认格式）。

- [ ] **Step 2: 全量回归**

```powershell
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "FAIL: $_" } }
```
Expected: 全部 0 退出码。

- [ ] **Step 3: 构建测试版产物**

```powershell
python build_inline.py --test
```
Expected: `dist-test/` 下生成自包含单文件 + docs.html。

- [ ] **Step 4: 部署到 beta/ 并核对**

```bash
# 先核对改动清单，确认只有预期文件进入 beta/
git status
cp -r dist-test/. beta/
git add beta/ && git commit -m "release(agent): test build to beta"
git push
```

- [ ] **Step 5: 探测验证**

```powershell
$r = Invoke-WebRequest -Uri 'https://jigugumiao.github.io/jiji_text_game_editor/beta/index.html' -UseBasicParsing
$r.StatusCode   # Expected: 200
$r.Content.Contains('STORY_EDITOR_NS')   # Expected: True（隔离注入）
```
另抽查页面含 `agent.js` 引用与 `Agent` 定义串。

- [ ] **Step 6: 最终提交确认（红线核对）**

```bash
git log --oneline -5
git status
```
确认：**master 根目录无构建产物改动**，正式版路径未被触碰。

---

## 自审记录（writing-plans Self-Review）

- **Spec 覆盖**：设计文档 §2 架构 → Task 1/2/3/13；§4 意图路由 → Task 4/13；§5 五组工具 → Task 7/9/10/11/12（22 工具全齐）；§6 分级 → Task 6/8/16；§7 生命周期 → Task 15；§8 循环 → Task 13；§9 代码结构 → 各任务；§10 测试 → 各任务内嵌 + Task 17 回归；§11 部署 → Task 17；§13 验收 11 条 → 对应任务（1:Task14/15, 2-4:Task15/16, 5-8:Task16, 9:Task15, 10:Task17, 11:Task13+17 人工抽查）。
- **占位符扫描**：无 TBD/TODO；探针脚本与测试代码完整；Task 15/16 为 UI 接线任务，给出精确挂接点与关键代码，交互细节以现有 FTA 模式为准（同一代码库既有范式）。
- **类型一致性**：`intentParse`/`buildMessages`/`classifyWrite`/`applyAgentWrite`/`undoWrite`/`runLoop`/`buildToolDefs`/`isContinuation` 在各任务签名一致；工具名与 TOOL_DEFS 及白名单一致；`toolsDeps` 字段在 Task 7/9/10/11/12 逐任务扩展、Task 15 一次性完整接线（字段名已在此对齐：getActiveBlock/listBlocks/getBlockText/fullText/settings/getVars/saveVars/blocksDoc/saveBlocks/extractClues/applyGeneratedBlocks/getAllAssets/renameAsset/deleteAsset/exportProject）。
- **补强点**：Task 13 的 TOOL_DEFS 常量要求与 Task 7-12 签名一致——实现时若某工具参数名与 TOOL_DEFS 不符，以 TOOL_DEFS 为唯一事实源修正工具实现。

---

## 执行交接

**Plan complete and saved to `docs/superpowers/plans/2026-09-11-agent-dialogue.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
