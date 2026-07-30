// 直接从源文件抽取真实 splitHooks 进行回归测试（不复制逻辑，避免漂移）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../js/ai.js', 'utf8');
const start = src.indexOf('function splitHooks');
if (start < 0) { console.error('找不到 splitHooks'); process.exit(1); }
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnText = src.slice(start, end);
const parseOutput = (s) => s; // mock：真实 splitHooks 内部会调它做去 markdown，不影响 【钩子 标签识别
const splitHooks = new Function('parseOutput', fnText + '\nreturn splitHooks;')(parseOutput);

const samples = {
  userOnly_noEndTag: '【钩子1】你在一片白雾中醒来，左手腕上多了一道发光的纹路。<停顿>它正缓缓爬向你的心脏。【钩子2】“你终于回来了。”身后的声音很耳熟，可你从没见过这张脸。【钩子3】桌上的信还带着体温，落款却是你自己的名字。【钩子4】整座城市在凌晨三点集体熄灯，只有你家的灯还亮着。【钩子5】那只黑猫第三次把你领到同一扇紧锁的铁门前。【钩子6】你按下发送键，对话框却显示“对方正在输入…”，可那号码三天前就注销了。',
  pair_withEndTag: '【钩子1】开场一内容【/钩子1】【钩子2】开场二内容【/钩子2】【钩子3】三【/钩子3】【钩子4】四【/钩子4】【钩子5】五【/钩子5】【钩子6】六【/钩子6】',
  mixed: '【钩子1】a内容【/钩子1】【钩子2】b内容【钩子3】c内容【钩子4】d【钩子5】e【钩子6】f',
  single_noTag: '只有一个钩子内容，没有任何标签，应该整段作为一个返回。',
  mixedContentHasHookWord: '【钩子1】他手里攥着一张写着“【钩子】”的纸条，脸色发白。【钩子2】门外传来了第二声敲门。',
};

let fail = 0;
const expect = { userOnly_noEndTag: 6, pair_withEndTag: 6, mixed: 6, single_noTag: 1, mixedContentHasHookWord: 2 };
for (const [name, raw] of Object.entries(samples)) {
  const r = splitHooks(raw);
  const ok = r.length === expect[name];
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' => ' + r.length + ' 段（期望 ' + expect[name] + '）');
  if (name === 'userOnly_noEndTag') {
    console.log('   段1前30字:', JSON.stringify((r[0] || '').slice(0, 30)));
    console.log('   段3前20字:', JSON.stringify((r[2] || '').slice(0, 20)));
    console.log('   段6前20字:', JSON.stringify((r[5] || '').slice(0, 20)));
  }
}
console.log(fail === 0 ? '\n✅ 全部通过' : '\n❌ 有 ' + fail + ' 个失败');
process.exit(fail === 0 ? 0 : 1);
