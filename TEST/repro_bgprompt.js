// 回归测试：背景提示词生成
//  1) ai.js generateBackgroundPrompt —— 组装 messages（含创作设定 + 上下文）、追加固定画质后缀、规整输出
//  2) 召唤处「上下 15 行」上下文提取逻辑（与 editor.js collectBgContext 同规则）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- localStorage 桩（ai.js loadSettings 需要 key）----
const _ls = { 'storyeditor:ai:key': 'sk-test-000', 'storyeditor:ai:model': 'deepseek-v4-flash' };
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
};

// ---- fetch 桩：记录请求体，返回单块 JSON（非流式）----
let lastBody = null;
global.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content: 'a quiet mountain village at dusk, wooden houses, distant peaks,\nwarm golden hour light, long shadows, serene melancholic atmosphere' }, finish_reason: 'stop' }] }),
  };
};

// ---- 载入 ai.js ----
global.window = global; global.module = undefined;
eval(fs.readFileSync(path.join(ROOT, 'js', 'ai.js'), 'utf8'));
const AI = global.AI;

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('PASS ✅', name); } else { fail++; console.log('FAIL ❌', name); } }

(async () => {
  const creation = { intro: '少年归乡', outline: '第一幕：抵达故乡山村', world: '架空东方山村', style: '温情、克制' };
  const ctxText = '旅人翻过最后一道山梁。\n<召唤背景:黄昏山村>\n炊烟从木屋顶升起。\n他停下脚步。';
  const out = await AI.generateBackgroundPrompt({ name: '黄昏山村', contextText: ctxText, creation });

  // 1. 消息组装
  const userMsg = lastBody.messages[1].content;
  check('user 消息含素材名', userMsg.includes('黄昏山村'));
  check('user 消息含创作设定（简介）', userMsg.includes('少年归乡'));
  check('user 消息含创作设定（大纲）', userMsg.includes('第一幕'));
  check('user 消息含上下文原文', userMsg.includes('炊烟从木屋顶升起'));
  check('system 要求只输出英文标签', /英文/.test(lastBody.messages[0].content));
  check('非思考模式（thinking disabled）', lastBody.thinking && lastBody.thinking.type === 'disabled');
  check('非流式', lastBody.stream === false);

  // 2. 输出规整 + 固定后缀
  check('换行已并为逗号', !/\n/.test(out));
  check('包含模型返回的场景内容', out.includes('quiet mountain village at dusk'));
  check('已追加固定画质后缀 masterpiece', out.includes('masterpiece'));
  check('已追加固定画质后缀 best quality', out.includes('best quality'));
  check('无重复逗号', !/,\s*,/.test(out));

  // 3. 上下 15 行提取逻辑（复刻 editor.js collectBgContext 的核心规则）
  const RE_SUMMON = /^<召唤(背景|物品|音乐|音效):\s*(.*?)\s*>$/;
  const CN_TO_KIND = { '背景': 'background', '物品': 'item', '音乐': 'music', '音效': 'sound' };
  function collect(name, blockText) {
    const lines = blockText.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l));
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(RE_SUMMON);
      if (m && CN_TO_KIND[m[1]] === 'background' && (m[2] || '').trim() === name) {
        const from = Math.max(0, i - 15), to = Math.min(lines.length, i + 16);
        return lines.slice(from, to).map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '').join('\n');
      }
    }
    return '';
  }
  // 构造 40 行：召唤在第 20 行，前后各 >15 行
  const arr = [];
  for (let i = 1; i <= 40; i++) arr.push(i === 20 ? '<召唤背景:test>' : ('行' + i));
  const blockText = '// 这是注释，应被忽略\n' + arr.join('\n');
  const ctx = collect('test', blockText);
  const ctxLines = ctx.split('\n');
  check('注释行被过滤', !ctx.includes('注释'));
  check('提取窗口 = 31 行（前15 + 召唤 + 后15）', ctxLines.length === 31);
  check('窗口起点为「行5」（第20行往前15）', ctxLines[0] === '行5');
  check('窗口含召唤行', ctx.includes('<召唤背景:test>'));
  check('窗口终点为「行35」（往后15）', ctxLines[ctxLines.length - 1] === '行35');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e.stack || e.message); process.exit(1); });
