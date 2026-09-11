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
vm.runInContext(agentSrc + '\nthis.Agent = Agent;', ctx);
const scen = ctx.Agent.AGENT_SCENARIOS;
assert.deepEqual(Object.keys(scen).sort(), ['design', 'general', 'polish', 'rewrite', 'vars']);
for (const [id, s] of Object.entries(scen)) {
  assert.equal(typeof s.systemPrompt, 'string', id + ' 需要 systemPrompt');
  assert.ok(s.systemPrompt.length > 50, id + ' systemPrompt 不能是空壳');
  assert.ok(Array.isArray(s.preload), id + ' preload 需为数组');
  assert.ok(Array.isArray(s.tools), id + ' tools 白名单需为数组');
}
assert.ok(scen.polish.tools.length > 0 && !scen.polish.tools.includes('delete_block'), 'polish 白名单不应含结构组破坏性工具');
assert.ok(scen.rewrite.preload.includes('full_text'), 'rewrite 应预载全文');

// intentParse：意图轮输出 → {scenario, needs, note}
{
  const good = ctx.Agent.intentParse('{"scenario":"polish","needs":["current_block"],"note":"润色第二段"}');
  assert.equal(good.scenario, 'polish');
  assert.ok(good.needs.includes('current_block'));
}
{
  const wrapped = ctx.Agent.intentParse('好的，我先分析：```json\n{"scenario":"rewrite","needs":["full_text"]}\n```');
  assert.equal(wrapped.scenario, 'rewrite', '须容忍 markdown 代码块包裹');
}
{
  const noisy = ctx.Agent.intentParse('这段剧情感觉节奏太慢了，帮我润色一下。');
  assert.equal(noisy.scenario, 'general', '无 JSON 时兜底 general，不抛错');
}
{
  const badScenario = ctx.Agent.intentParse('{"scenario":"hack","needs":[]}');
  assert.equal(badScenario.scenario, 'general', '未知 scenario 兜底 general');
}
// intentParse 健壮性：边界输入 + 花括号闲聊不吞合法 JSON + 原型链键防绕过
{
  assert.equal(ctx.Agent.intentParse('').scenario, 'general', '空串兜底 general');
  assert.equal(ctx.Agent.intentParse(null).scenario, 'general', 'null 兜底 general');
  assert.equal(ctx.Agent.intentParse(123).scenario, 'general', '非字符串兜底 general');
}
{
  // 注意：intentParse 在 vm 沙箱 realm 运行，返回的数组跨 realm（prototype 不同），deepStrictEqual 会误报 —— 用 join 转 primitive 比较
  const r = ctx.Agent.intentParse('{"scenario":"polish","needs":[42,"current_block"]}');
  assert.equal(r.needs.join(','), 'current_block', 'needs 只保留字符串项');
}
{
  const r = ctx.Agent.intentParse('好的 {"scenario":"rewrite","needs":[]}（参考 {选项} 语法）');
  assert.equal(r.scenario, 'rewrite', '尾随花括号闲聊不得吞掉合法 JSON');
}
{
  const r = ctx.Agent.intentParse('保留 {名} 语法 {"scenario":"vars","needs":[]}');
  assert.equal(r.scenario, 'vars', '前置 decoy 花括号应被跳过、继续找合法 JSON');
}
{
  assert.equal(ctx.Agent.intentParse('{"scenario":"__proto__"}').scenario, 'general', '原型链键不算合法场景');
  assert.equal(ctx.Agent.intentParse('{"scenario":"constructor"}').scenario, 'general', '原型链键不算合法场景');
}
console.log('agent.test.js OK');
