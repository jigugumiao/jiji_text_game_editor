// ai_materials_test.js — 验证：素材约束放宽 / outline 去冗余 / 需求素材分离
const path = require('path');
const AI = require(path.join(__dirname, '..', 'js', 'ai.js'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

const ctx = {
  assets: { background: ['雨夜街'], item: [], music: ['低沉弦乐'], sound: [] },
  creation: { outline: '我潜入旧楼找证据', intro: '短篇悬疑', world: '近未来都市', tone: '冷峻' },
  before: '', after: '', selText: '', hasSel: false,
};

console.log('1) 素材约束放宽');
const sys = AI.systemPrompt('中');
ok('不再要求只能从清单取', !sys.includes('只能从清单中取'));
ok('提示可用虚构名', sys.includes('虚构名') || sys.includes('清单外'));
ok('提示输出 <需求素材> 区块', sys.includes('<需求素材>'));
ok('说明待办清单不进剧本', sys.includes('待办清单'));

console.log('2) outline 模式去冗余（创作设定只出现一次）');
const outlineMsg = AI.buildUserMessage('outline', ctx);
// 创作设定里这串唯一文本本应只出现 1 次（顶部 appended 的 creationBlock）
const occ = (outlineMsg.match(/我潜入旧楼找证据/g) || []).length;
ok('“我潜入旧楼找证据”在消息里仅 1 次（无重复拼接）', occ === 1);
ok('body 仅用【创作设定】作指针引用，不内联内容', outlineMsg.includes('依据下列【创作设定】') && occ === 1);
ok('素材清单标注为参考非强制', outlineMsg.includes('仅供参考'));

console.log('3) 其它模式创作设定也只 1 次');
for (const m of ['continue', 'expand', 'polish']) {
  const msg = AI.buildUserMessage(m, ctx);
  ok(m + ' 模式【创作设定】仅 1 次', (msg.match(/【创作设定】/g) || []).length <= 1);
}

console.log('4) splitRequirements 分离');
const raw = '我摸黑上了三楼。\n<停顿>\n<召唤背景:雨夜街>\n\n<需求素材>\n背景：废弃天台 —— 风大的夜景，冷蓝调\n物品：旧式录音笔 —— 可用于收集证词\n音乐：悬疑脉冲 —— 低频节奏\n</需求素材>';
const r = AI.splitRequirements(raw);
ok('story 剔除需求区块', !r.story.includes('<需求素材>'));
ok('requirements 保留内容', r.requirements.includes('废弃天台') && r.requirements.includes('旧式录音笔'));
ok('无需求区块时 requirements 为空', AI.splitRequirements('纯剧本\n<停顿>').requirements === '');
ok('无需求区块时 story 为原文 trim', AI.splitRequirements('纯剧本\n<停顿>').story === '纯剧本\n<停顿>');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
