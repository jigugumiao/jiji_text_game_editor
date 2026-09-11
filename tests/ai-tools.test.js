// tests/ai-tools.test.js
// callDeepseek tools 扩展：请求体带 tools / 流式 tool_calls 增量拼接 / 非流式 toolCalls 透出
const assert = require('node:assert/strict');
// 显式引入（Node 18+ 全局也有，require 保证在任何环境可用）
const { ReadableStream } = require('node:stream/web');

// ai.js 顶层若引用 window，先给 stub（ai.js 是 IIFE，module.exports 供 Node 测试）
global.window = global.window || { StoryEditorApi: {}, Storage: { getAllAssets: () => [] } };
// callDeepseek 先读 loadSettings()（storyeditor:ai:*），无 key 会在 fetch 前抛「未配置 API Key」——
// 必须 stub localStorage 给一个有效 key，测试才能走到 fetch 与断言（不改 ai.js 本体）
const aiSettings = { 'storyeditor:ai:key': 'test-key', 'storyeditor:ai:base': 'https://api.deepseek.com', 'storyeditor:ai:model': 'deepseek-chat' };
global.localStorage = {
  getItem: (k) => (k in aiSettings ? aiSettings[k] : null),
  setItem: (k, v) => { aiSettings[k] = String(v); },
  removeItem: (k) => { delete aiSettings[k]; },
};
const AI = require('../js/ai.js');

function mockFetchOnce(respBody) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => respBody };
  };
  return calls;
}

// 流式 mock：把 SSE 行一次性推给 ReadableStream，content-type 标注 text/event-stream 走 SSE 解析分支
function mockFetchStream(sseLines) {
  const calls = [];
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(sseLines.map(l => 'data: ' + l + '\n').join('') + 'data: [DONE]\n\n'));
      controller.close();
    },
  });
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'text/event-stream' : null) }, body: stream, json: async () => ({}) };
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
  assert.equal(out.toolCalls[0].function.arguments, '{"blockName":"第一章"}');
}

async function testNoToolsBackwardCompat() {
  const calls = mockFetchOnce({ choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] });
  const out = await AI.callDeepseek([{ role: 'user', content: 'hi' }], { stream: false });
  assert.equal(out, '你好', '无 tools 时保持原行为：直接返回 content 字符串');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.tools, undefined, '无 tools 时请求体不得带 tools 字段');
  assert.equal(body.tool_choice, undefined, '无 tool_choice 时请求体不得带 tool_choice 字段');
}

async function testStreamToolCalls() {
  // 模拟 DeepSeek 流式 tool_calls：id/type/name 在首个 chunk，arguments 按字符块增量下发
  const calls = mockFetchStream([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_block', arguments: '' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"block' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Name":"第一章"}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
  let toolCallsOut = null;
  const out = await AI.callDeepseek([{ role: 'user', content: 'hi' }], {
    tools: [{ type: 'function', function: { name: 'read_block', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'auto', stream: true,
    onToolCalls: (tc) => { toolCallsOut = tc; },
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1, '流式请求体也必须带 tools');
  assert.equal(out, '', '流式仍按原行为返回拼接后的 content 字符串（本轮无 content）');
  assert.ok(toolCallsOut && toolCallsOut.length === 1, '流式结束必须回调 onToolCalls 完整数组');
  assert.equal(toolCallsOut[0].id, 'call_1');
  assert.equal(toolCallsOut[0].type, 'function');
  assert.equal(toolCallsOut[0].function.name, 'read_block', 'function.name 必须拼齐');
  assert.equal(toolCallsOut[0].function.arguments, '{"blockName":"第一章"}', 'arguments 必须跨 chunk 增量拼接');
}

async function testEmptyToolsGuard() {
  const calls = mockFetchOnce({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] });
  await AI.callDeepseek([{ role: 'user', content: 'hi' }], { tools: [], stream: false });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.tools, undefined, '空数组 tools 不得进请求体（部分 OpenAI 兼容服务端会 400）');
}

async function testStreamToolCallsNoCallback() {
  // 流式 + tools 但漏传 onToolCalls：必须随返回值透出 {content, toolCalls}，防静默丢弃工具调用
  mockFetchStream([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_block', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
  const out = await AI.callDeepseek([{ role: 'user', content: 'hi' }], { tools: [{}], stream: true });
  assert.ok(out && out.toolCalls && out.toolCalls.length === 1, '无 onToolCalls 时流式也要透出 toolCalls（防静默丢失）');
  assert.equal(out.toolCalls[0].function.name, 'read_block');
}

async function testStreamMultiIndexInterleaved() {
  // 多工具调用、index 乱序（1 先于 0）：都要拼齐并按 index 排序
  mockFetchStream([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read_block', arguments: '' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_blocks', arguments: '' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"blockName":"甲"}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]);
  let out = null;
  await AI.callDeepseek([{ role: 'user', content: 'hi' }], { tools: [{}, {}], stream: true, onToolCalls: (tc) => { out = tc; } });
  assert.equal(out.length, 2, '两个 tool_calls 都要拼齐');
  assert.equal(out[0].function.name, 'list_blocks', '按 index 排序，index 0 在前');
  assert.equal(out[1].function.name, 'read_block');
  assert.equal(out[1].function.arguments, '{"blockName":"甲"}');
}

(async () => {
  await testNonStreamTools();
  await testNoToolsBackwardCompat();
  await testStreamToolCalls();
  await testEmptyToolsGuard();
  await testStreamToolCallsNoCallback();
  await testStreamMultiIndexInterleaved();
  console.log('ai-tools.test.js OK');
})().catch(e => { console.error(e); process.exit(1); });
