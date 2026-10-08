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
}
await call('thinking=disabled+tools', false);
await call('thinking=enabled+tools', true);
