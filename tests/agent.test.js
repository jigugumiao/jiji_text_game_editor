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
// buildMessages：前缀构造（§4.3 缓存纪律）— system 提示词 → settings system → 预载 user → 用户 user
// 注意：本地上下文变量命名为 sctx，避免遮蔽外层 vm 沙箱 ctx（ctx.Agent 是模块句柄）
{
  const sctx = { outline: '大纲A', settings: '世界观：魔都', currentBlock: { name: '第一章', text: '正文…' }, fullText: '全文…', vars: [{ name: '金币', type: 'number', value: 10 }] };
  const msgs = ctx.Agent.buildMessages('general', sctx, '润色第二段');
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.indexOf('全能助理') >= 0, '首条=场景 system 提示词');
  assert.equal(msgs[1].role, 'system');
  assert.ok(msgs[1].content.indexOf('世界观：魔都') >= 0, '第二条=创作设定（settings）');
  assert.ok(msgs[2].role === 'user' && msgs[2].content.indexOf('大纲A') >= 0, '预载上下文在第三条 user');
  assert.ok(msgs[2].content.indexOf('当前编辑块《第一章》') >= 0, '预载按场景顺序含大纲+当前块');
  assert.equal(msgs[3].role, 'user');
  assert.equal(msgs[3].content, '润色第二段', '用户消息必须在最后');
}
{
  // 缓存纪律：同场景同工程两次构建，前缀逐字符相同（稳定前缀在可变内容之前）
  const sctx = { outline: '大纲A', settings: '世界观：魔都', currentBlock: { name: '第一章', text: '正文…' }, fullText: '全文…' };
  const a = ctx.Agent.buildMessages('general', sctx, '第一个问题');
  const b = ctx.Agent.buildMessages('general', sctx, '第二个问题');
  const prefixLen = Math.min(a[2].content.length, b[2].content.length);
  assert.equal(a[2].content.slice(0, prefixLen), b[2].content.slice(0, prefixLen), '预载 user 消息是稳定前缀');
}
// buildMessages 健壮性：settings 不重复 + 未知场景/原型链键兜底 + 缺省 ctx/userText
{
  // 创作设定只在 system 消息出现一次（rewrite/design 的 preload 不得重复带 settings）
  const r = ctx.Agent.buildMessages('rewrite', { settings: '世界观：魔都', fullText: '全文', outline: '大纲' }, '改写');
  let settingsCount = 0;
  for (const m of r) { if (typeof m.content === 'string' && m.content.indexOf('世界观：魔都') >= 0) settingsCount++; }
  assert.equal(settingsCount, 1, 'rewrite 的创作设定必须只出现一次（system 消息）');
  const d = ctx.Agent.buildMessages('design', { settings: '世界观：魔都', outline: '大纲', currentBlock: { name: '第一章', text: '正文' } }, '设计问题');
  let dCount = 0;
  for (const m of d) { if (typeof m.content === 'string' && m.content.indexOf('世界观：魔都') >= 0) dCount++; }
  assert.equal(dCount, 1, 'design 的创作设定必须只出现一次（system 消息）');
}
{
  const r = ctx.Agent.buildMessages('nope', { settings: 's' }, 'hi');
  assert.ok(typeof r[0].content === 'string' && r[0].content.indexOf('全能助理') >= 0, '未知场景兜底 general');
  const p = ctx.Agent.buildMessages('__proto__', { settings: 's' }, 'hi');
  assert.ok(typeof p[0].content === 'string' && p[0].content.length > 50, '原型链键也须兜底 general，不得产出 undefined systemPrompt');
}
{
  const r = ctx.Agent.buildMessages('general', undefined, undefined);
  assert.equal(r.length, 2, 'ctx/userText 缺省：system + 空 user 两条');
  assert.equal(r[1].content, '', 'userText 缺省为空串');
}
// classifyWrite：写操作分级判定（设计 §6）
// destructive:true → 'destructive'；chars ≤ 500 且 !wholeBlock → 'auto'；否则 'preview'
// 返回值是 primitive string，跨 realm 无碍，直接用 ctx.Agent 模块句柄
assert.equal(ctx.Agent.classifyWrite({ chars: 100, lines: 3, wholeBlock: false }), 'auto');
assert.equal(ctx.Agent.classifyWrite({ chars: 500, lines: 10, wholeBlock: false }), 'auto', '500 边界算小改');
assert.equal(ctx.Agent.classifyWrite({ chars: 501, lines: 10, wholeBlock: false }), 'preview', '超 500 算大改');
assert.equal(ctx.Agent.classifyWrite({ chars: 10, lines: 1, wholeBlock: true }), 'preview', '整块替换强制 preview');
assert.equal(ctx.Agent.classifyWrite({ chars: 10, lines: 1, wholeBlock: false, destructive: true }), 'destructive');
assert.equal(ctx.Agent.classifyWrite({ destructive: true }), 'destructive', '缺字段也要判 destructive');

// ===== Task 7: 文档编辑工具纯函数（Agent.tools / toolsDeps / textOps） =====
// 注：tools 返回的对象/数组都来自 vm 沙箱 realm，数组/对象不能 deepEqual，用 join 转 primitive 比较
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
  ctx.Agent.toolsDeps = deps;
  return ctx.Agent.tools[name](args || {});
}

// 只读
{
  const r = callTool('get_current_block', {});
  assert.equal(r.blockName, '第一章');
  assert.equal(r.text, '第一行\n第二行\n第三行');
}
{
  // 跨 realm 数组不可 deepEqual → join 转 primitive
  assert.equal(callTool('list_blocks', {}).join(','), '第一章,第二章');
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

// ===== Task 7 审查修复：模糊回退假起点 / 整块替换 / chars=变更量 / 防护 =====
{
  // 模糊回退不得吞字符：锚点归一化后从正确起点消费非空白字符
  ctx.Agent.toolsDeps = { getBlockText: (n) => n === 'B1' ? '他 他 来了' : n === 'B2' ? 'ABA C' : n === 'B3' ? '他来了，我们走吧。' : null, listBlocks: () => ['B1', 'B2', 'B3'] };
  const t = ctx.Agent.tools;
  const r1 = t.insert_at({ blockName: 'B2', anchor: 'AC', text: 'Z', mode: 'replace', anchorType: 'text' });
  assert.equal(r1.resultText, 'ABZ', '模糊假起点不得吞字符（ABA C → 锚 AC 替换为 ABZ）');
  const r2 = t.insert_at({ blockName: 'B1', anchor: '他来了', text: 'Z', mode: 'replace', anchorType: 'text' });
  assert.equal(r2.resultText, '他 Z', '跨空白模糊替换必须命中正确起点');
  const r3 = t.insert_at({ blockName: 'B3', anchor: '他来了,我们走吧。', text: 'Y', mode: 'replace', anchorType: 'text' });
  assert.equal(r3.resultText, 'Y', '全角标点归一化后也能匹配');
}
{
  // 整块替换必须标记 wholeBlock → 强制 preview
  ctx.Agent.toolsDeps = { getBlockText: () => '只有八个字', listBlocks: () => ['B'] };
  const r = ctx.Agent.tools.insert_at({ blockName: 'B', anchor: '只有八个字', text: '新内容', mode: 'replace', anchorType: 'text' });
  assert.equal(r.impact.wholeBlock, true, '整块替换必须标记 wholeBlock');
  assert.equal(ctx.Agent.classifyWrite(r.impact), 'preview', '整块替换强制走预览');
}
{
  // impact.chars 必须是变更量（delta），不是编辑后总长
  const long = '字'.repeat(600);
  ctx.Agent.toolsDeps = { getBlockText: () => long, listBlocks: () => ['L'] };
  const r = ctx.Agent.tools.append_to_block({ blockName: 'L', text: '追加' });
  assert.equal(r.impact.chars, 3, 'chars 为变更量（追加 2 字 + 1 换行分隔 = 3），而非 603 总长');
  assert.equal(ctx.Agent.classifyWrite(r.impact), 'auto', '600 字块的 2 字小改仍 auto');
}
{
  // 部分 deps 防护：有 listBlocks 无 getBlockText 时 search_in_doc 不抛错
  ctx.Agent.toolsDeps = { listBlocks: () => ['A'] };
  const r = ctx.Agent.tools.search_in_doc({ query: 'x' });
  assert.ok(Array.isArray(r) && r.length === 0, '缺 getBlockText 不抛错');
}
{
  // 无效 mode 报错而非静默按 before 处理
  ctx.Agent.toolsDeps = { getBlockText: () => 'a\nb', listBlocks: () => ['B'] };
  const r = ctx.Agent.tools.insert_at({ blockName: 'B', anchor: 1, text: 'x', mode: 'After', anchorType: 'line' });
  assert.ok(String(r.error).indexOf('mode') >= 0, '无效 mode 必须报错');
}
{
  // 暴露的 textOps 直测模糊映射起点
  const fa = ctx.Agent.textOps.findAnchor('他 他 来了', '他来了', 'text');
  assert.equal(fa.start, 2, '模糊起点 = 第 pos+1 个非空白字符');
  assert.equal(fa.end, 6, '模糊终点消费完整匹配');
}
// ===== Task 8: applyAgentWrite + 会话内撤销记录 =====
// 注：applyAgentWrite/undoWrite 返回的 rec 与 sessionWrites 里的记录都是 vm 沙箱 realm 对象，
// 跨 realm 数组/对象不可 deepEqual —— 只断言 primitive 字段；committed 用 JSON.stringify 转 primitive 比较
{
  const log = [];
  const r = ctx.Agent.applyAgentWrite({ block: '第一章', resultText: '新文', impact: { chars: 10, lines: 1, wholeBlock: false } }, {}, log);
  assert.equal(r.level, 'auto');
  assert.equal(log.length, 1);
  assert.equal(log[0].block, '第一章');
  assert.equal(r.after, '新文');
}
{
  const r = ctx.Agent.applyAgentWrite({ block: '第一章', resultText: 'x'.repeat(600), impact: { chars: 600, lines: 1, wholeBlock: false } }, {}, []);
  assert.equal(r.level, 'preview');
}
{
  ctx.Agent.sessionWrites = [{ block: 'B', before: '旧', after: '新', level: 'auto' }];
  const committed = [];
  ctx.Agent.undoWrite({ commit: (b, text) => committed.push([b, text]) });
  assert.equal(JSON.stringify(committed), JSON.stringify([['B', '旧']]), 'undo 用 before 还原');
  assert.equal(ctx.Agent.sessionWrites.length, 0, '还原后出栈');
}
// ===== Task 9: 变量工具（直接读写 master 现有格式） =====
// 变量格式 {name, type:'number'|'text'|'boolean', value}；命名 /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/（不得数字开头）
// 注：变量工具直接经 toolsDeps.getVars/saveVars 读写（Task 7 风格直接赋值 toolsDeps）；
// 跨 realm 数组/对象不可 deepEqual，用 JSON.stringify / 取值 primitive 比较。
function mockVars(initial) {
  let vars = initial || [];
  ctx.Agent.toolsDeps = {
    getVars: () => vars,
    saveVars: (arr) => { vars = arr; },
  };
  return () => vars;
}
{
  const m = mockVars([{ name: '金币', type: 'number', value: 10 }]);
  const lv = JSON.stringify(ctx.Agent.tools.list_vars());
  assert.ok(lv.indexOf('金币') >= 0 && lv.indexOf('10') >= 0, 'list_vars 返回全部变量');
  const rv = ctx.Agent.tools.read_var({ name: '金币' });
  assert.equal(rv.name, '金币', 'read_var 命中');
  assert.ok(ctx.Agent.tools.read_var({ name: '没有' }).error, '不存在的变量报错');
}
{
  const m = mockVars([]);
  const r = ctx.Agent.tools.create_var({ name: '金币', type: 'number', value: 100 });
  assert.ok(r.ok);
  assert.equal(m()[0].name, '金币', 'create_var 写入');
  assert.ok(ctx.Agent.tools.create_var({ name: '1bad', type: 'number', value: 1 }).error, '数字开头拒绝');
  assert.ok(ctx.Agent.tools.create_var({ name: '金币', type: 'number', value: 1 }).error, '重名拒绝');
}
{
  const m = mockVars([{ name: '金币', type: 'number', value: 10 }]);
  ctx.Agent.tools.set_var({ name: '金币', value: 50 });
  assert.equal(m()[0].value, 50, 'set_var 更新');
  assert.ok(ctx.Agent.tools.set_var({ name: '金币', value: 'abc' }).error, 'number 类型拒绝非数值');
  ctx.Agent.tools.update_var({ name: '金币', op: '+', delta: 10 });
  assert.equal(m()[0].value, 60, 'update_var 加');
  ctx.Agent.tools.delete_var({ name: '金币' });
  assert.equal(m().length, 0, 'delete_var 删除');
}
// Task 9 边界健壮性：空名拒绝 / boolean·text 强制 / 缺省初值 / update_var 分支 / saveVars 守卫
{
  const m = mockVars([]);
  assert.ok(ctx.Agent.tools.create_var({}).error, '缺 name 不得创建变量（不得落 undefined 垃圾条目）');
  assert.ok(ctx.Agent.tools.create_var({ name: '旗', type: 'boolean' }).ok);
  assert.equal(m()[0].value, false, 'boolean 缺省初值 false');
  assert.ok(ctx.Agent.tools.create_var({ name: '标题', type: 'text' }).ok);
  assert.equal(m()[1].value, '', 'text 缺省初值空串');
  ctx.Agent.tools.set_var({ name: '旗', value: '1' });
  assert.equal(m()[0].value, true, "boolean '1'→true");
  ctx.Agent.tools.set_var({ name: '旗', value: 'false' });
  assert.equal(m()[0].value, false, "boolean 'false'→false");
  ctx.Agent.tools.set_var({ name: '标题', value: 42 });
  assert.equal(m()[1].value, '42', 'text 强制 String(42)');
}
{
  const m = mockVars([{ name: '金币', type: 'number', value: 100 }, { name: '标题', type: 'text', value: 'x' }]);
  ctx.Agent.tools.update_var({ name: '金币', op: '-', delta: 5 });
  assert.equal(m()[0].value, 95, "update_var '-' 减法");
  assert.ok(ctx.Agent.tools.update_var({ name: '标题', op: '+', delta: 1 }).error, 'text 不支持加减');
  assert.ok(ctx.Agent.tools.update_var({ name: '金币', op: '+', delta: 'abc' }).error, 'delta 非数值拒绝');
  assert.ok(ctx.Agent.tools.update_var({ name: '没有', op: '+', delta: 1 }).error, 'update 不存在的变量报错');
  assert.ok(ctx.Agent.tools.set_var({ name: '没有', value: 1 }).error, 'set 不存在的变量报错');
  assert.ok(ctx.Agent.tools.delete_var({ name: '没有' }).error, 'delete 不存在的变量报错');
}
{
  ctx.Agent.toolsDeps = { getVars: () => [{ name: '金币', type: 'number', value: 1 }] };
  const r = ctx.Agent.tools.set_var({ name: '金币', value: 2 });
  assert.ok(r.error, 'saveVars 未接线时写入必须报错而非静默 ok');
}
// ===== Task 10: 结构组工具（create/rename/delete 剧情块） =====
// 块对象视图 {块名: 文本} 经 toolsDeps.blocksDoc 注入；blocks 是测试 realm 普通对象，
// `in`/indexOf 跨 realm 安全；references 数组来自 vm 沙箱 realm，用 JSON.stringify 转 primitive 比较。
function mockBlocks() {
  const blocks = { '第一章': '正文一', '第二章': '甲\n<选项:"去第一章",第一章>' };
  ctx.Agent.toolsDeps = {
    listBlocks: () => Object.keys(blocks),
    getBlockText: (n) => (n in blocks ? blocks[n] : null),
    saveBlocks: (obj) => { for (const k in obj) blocks[k] = obj[k]; for (const k of Object.keys(blocks)) if (!(k in obj)) delete blocks[k]; },
    blocksDoc: () => blocks,
  };
  return () => blocks;
}
{
  const get = mockBlocks();
  const r = ctx.Agent.tools.create_block({ blockName: '番外' });
  assert.ok(r.ok);
  assert.ok('番外' in get(), 'create_block 应新增空剧情块');
  assert.equal(get()['番外'], '', '新块初始文本为空串');
  assert.ok(ctx.Agent.tools.create_block({ blockName: '番外' }).error, '重名拒绝');
}
{
  const get = mockBlocks();
  const r = ctx.Agent.tools.rename_block({ oldName: '第一章', newName: '序章' });
  assert.ok(r.ok);
  assert.ok('序章' in get() && !('第一章' in get()), '改名后旧键删除、新键存在');
  assert.equal(get()['序章'], '正文一', '内容随改名迁移');
  assert.ok(get()['第二章'].indexOf('序章>') >= 0, '选项跳转引用应同步为新块名');
  assert.ok(get()['第二章'].indexOf('第一章>') < 0, '旧跳转目标应被替换');
}
{
  const get = mockBlocks();
  const r = ctx.Agent.tools.delete_block({ blockName: '第一章' });
  assert.ok(r.destructive, '删除块必须标记 destructive');
  assert.ok(Array.isArray(r.references) && r.references.length >= 1, '必须报告其他块的跳转引用');
  assert.equal(r.references[0].block, '第二章');
  assert.ok('第一章' in get(), 'delete_block 只报告引用，不得真的删块（runLoop 确认后才删）');
}
// Task 10 边界：非法/空块名 / 缺旧块 / 新名已存在 / 无引用删除 / 缺 saveBlocks 守卫
{
  const get = mockBlocks();
  assert.ok(ctx.Agent.tools.create_block({ blockName: 'bad name' }).error, '含空格块名拒绝');
  assert.ok(ctx.Agent.tools.create_block({ blockName: '' }).error, '空块名拒绝');
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '不存在', newName: 'X' }).error, '旧块不存在报错');
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '第一章', newName: '第二章' }).error, '新名已存在报错');
  const d = ctx.Agent.tools.delete_block({ blockName: '第二章' });
  assert.equal(JSON.stringify(d.references), '[]', '无其他块引用时返回空数组');
  assert.ok(ctx.Agent.tools.delete_block({ blockName: '没有' }).error, '删除不存在的块报错');
}
{
  const get = mockBlocks();
  ctx.Agent.toolsDeps = { blocksDoc: () => get() };
  assert.ok(ctx.Agent.tools.create_block({ blockName: 'X' }).error, '缺 saveBlocks 时 create 必须报错而非静默 ok');
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '第一章', newName: 'X' }).error, '缺 saveBlocks 时 rename 必须报错');
}
// Task 10 审查修复：newN 校验 / 单括号跳转同步与扫描 / __MAIN__ 守卫
{
  const get = mockBlocks();
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '第一章', newName: '' }).error, '空 newN 拒绝');
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '第一章', newName: '$&' }).error, '替换串特殊字符 newN 拒绝');
  assert.ok('第一章' in get() && !('$&' in get()), '拒绝后数据未动');
}
{
  const get = mockBlocks();
  get()['第二章'] = '甲\n<剧情块:第一章>';
  ctx.Agent.tools.rename_block({ oldName: '第一章', newName: '序章' });
  assert.ok(get()['第二章'].indexOf('<剧情块:序章>') >= 0, '单括号跳转引用同步');
  const get2 = mockBlocks();
  get2()['第二章'] = '甲\n<剧情块:第一章>';
  const r = ctx.Agent.tools.delete_block({ blockName: '第一章' });
  assert.ok(r.references.length >= 1 && r.references[0].snippet.indexOf('<剧情块:第一章>') >= 0, '单括号引用计入删除报告');
}
{
  const get = mockBlocks();
  ctx.Agent.toolsDeps.mainBlock = '__MAIN__';
  assert.ok(ctx.Agent.tools.create_block({ blockName: '__MAIN__' }).error, '不能创建主剧情同名块');
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '__MAIN__', newName: 'X' }).error, '主剧情不可改名');
  assert.ok(ctx.Agent.tools.rename_block({ oldName: '第一章', newName: '__MAIN__' }).error, '不能改名为主剧情');
  assert.ok(ctx.Agent.tools.delete_block({ blockName: '__MAIN__' }).error, '主剧情不可删除');
}
// ===== Task 11: 创作辅助组工具（extract_clues / generate_options） =====
// 工具只调 toolsDeps + 校验结果/语法，不直接碰 AI 或文档（UI 接线：extractClues→window.AI.extractClues，
// applyGeneratedBlocks→window.StoryEditorApi.applyGeneratedBlocks）。deps 按 Task 7 惯例直接赋值 toolsDeps；
// 跨 realm 对象不可 deepEqual → calls[0]/applied[0] 是沙箱对象/数组，只断言 primitive 字段或 join 转 primitive。
{
  const calls = [];
  ctx.Agent.toolsDeps = { extractClues: (opts) => { calls.push(opts); return { ok: true, clues: '线索A' }; } };
  const r = ctx.Agent.tools.extract_clues({ blockName: '第一章' });
  assert.ok(r.ok && r.clues === '线索A', 'extract_clues 返回 deps 的 {ok, clues}');
  assert.equal(calls.length, 1, '恰好调用一次 deps');
  assert.equal(calls[0].blockName, '第一章', 'blockName 原样透传');
}
{
  // 未接线 / deps 失败 / deps 抛异常 → 一律返回 error，不抛异常
  ctx.Agent.toolsDeps = {};
  assert.ok(ctx.Agent.tools.extract_clues({}).error, '未接线时报错');
  ctx.Agent.toolsDeps = { extractClues: () => ({ ok: false, error: '管线超时' }) };
  assert.ok(String(ctx.Agent.tools.extract_clues({}).error).indexOf('管线超时') >= 0, 'deps 失败透传 error');
  ctx.Agent.toolsDeps = { extractClues: () => { throw new Error('boom'); } };
  assert.ok(String(ctx.Agent.tools.extract_clues({}).error).indexOf('boom') >= 0, 'deps 抛异常转 error');
}
{
  // 两行都合法（条件段可含 >，如 金币>5）→ count=2，合法行原样交给 applyGeneratedBlocks
  const applied = [];
  ctx.Agent.toolsDeps = { applyGeneratedBlocks: (blocks) => { applied.push(blocks); return { ok: true }; } };
  const r = ctx.Agent.tools.generate_options({ text: '<选项:"A",块A>\n<选项:"B",块B,条件:金币>5>' });
  assert.ok(r.ok, '两行都合法');
  assert.equal(r.count, 2, '合法行计数');
  assert.equal(r.invalid, 0);
  assert.equal(applied.length, 1, '合法时调用一次 applyGeneratedBlocks');
  assert.equal(applied[0].join('\n'), '<选项:"A",块A>\n<选项:"B",块B,条件:金币>5>', '合法行原样写入');
}
{
  // 全非法 → 报错；混行 → 只写合法行 + invalid 计数；缺/空 text、未接线 → 报错
  assert.ok(ctx.Agent.tools.generate_options({ text: '这不是选项' }).error, '全非法行报错');
  const applied = [];
  ctx.Agent.toolsDeps = { applyGeneratedBlocks: (blocks) => { applied.push(blocks); return { ok: true }; } };
  const mix = ctx.Agent.tools.generate_options({ text: '<选项:"A",块A>\n垃圾行' });
  assert.ok(mix.ok, '有合法行即 ok');
  assert.equal(mix.count, 1);
  assert.equal(mix.invalid, 1, '非法行计数');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].join('\n'), '<选项:"A",块A>', '只写合法行');
  assert.ok(ctx.Agent.tools.generate_options({}).error, '缺 text 报错');
  assert.ok(ctx.Agent.tools.generate_options({ text: '' }).error, '空 text 报错');
  ctx.Agent.toolsDeps = {};
  assert.ok(ctx.Agent.tools.generate_options({ text: '<选项:"A",块A>' }).error, '未接线时报错而非静默 ok');
}
{
  // 同行拼接（引擎强制格式：同决策点多选项同行，editor.js:125 extractOptionLine 闭合规则——
  // 闭合 > 取下一个 <选项: 前最后一个 >，条件表达式里的 > 不算闭合）
  const applied = [];
  ctx.Agent.toolsDeps = { applyGeneratedBlocks: (blocks) => { applied.push(blocks); return { ok: true }; } };
  const r = ctx.Agent.tools.generate_options({ text: '<选项:"A",块A><选项:"B",块B>' });
  assert.ok(r.ok, '同行拼接的多个选项全部合法');
  assert.equal(r.count, 2);
  assert.equal(r.invalid, 0);
  const c = ctx.Agent.tools.generate_options({ text: '<选项:"A",块A,条件:金币>5><选项:"B",块B>' });
  assert.ok(c.ok && c.count === 2, '同行拼接+条件段里的 > 不算闭合');
  assert.equal(applied[1].length, 2, '逐选项写入（同行拆成 2 条）');
  assert.equal(applied[1][0], '<选项:"A",块A,条件:金币>5>', '条件段原样保留');
  assert.equal(applied[1][1], '<选项:"B",块B>');
  assert.ok(ctx.Agent.tools.generate_options({ text: '<选项:"A">' }).error, '缺块名的选项非法');
}
// ===== §14: 历史摘要压缩（classifyHistoryCompression / searchHistoryArchive） =====
// 借鉴 DSH 上下文压缩：超阈值压最旧段、最后一条永不压、原文归档可被 search_history 检索。
{
  const A = ctx.Agent;
  const mk = (role, content) => ({ role, content });
  const big = '字'.repeat(12000);
  // 未超阈值 → 不压缩
  let p = A.classifyHistoryCompression([mk('user', '你好'), mk('assistant', '嗨')], { maxChars: 30000 });
  assert.equal(p.shouldCompress, false);
  // 空数组 → 不压
  assert.equal(A.classifyHistoryCompression([], { maxChars: 100 }).shouldCompress, false);
  // 超阈值 → 压最旧段直到剩余 ≤ 阈值
  const h = [mk('user', '第一轮' + big), mk('assistant', '答' + big), mk('user', '第二轮' + big), mk('assistant', '又答' + big), mk('user', '当前轮')];
  p = A.classifyHistoryCompression(h, { maxChars: 30000 });
  assert.equal(p.shouldCompress, true);
  assert.ok(p.compress.length >= 1 && p.compress[0] === h[0], '从最旧开始压');
  assert.ok(p.keep.length >= 1, '保留最近内容');
  const keepChars = p.keep.reduce((s, m) => s + m.content.length, 0);
  assert.ok(keepChars <= 30000, '剩余保持 ≤ 阈值（' + keepChars + '）');
  // 最后一条永不压：全部压光仍超阈值时也保留最后一条（含超大最后一条 user）
  const h2 = [mk('user', '早' + big), mk('assistant', '答' + big), mk('user', '最新的一轮' + big + big)];
  p = A.classifyHistoryCompression(h2, { maxChars: 100 });
  assert.equal(p.shouldCompress, true);
  assert.ok(p.compress.indexOf(h2[h2.length - 1]) < 0, '最后一条不压');
  assert.equal(p.keep[p.keep.length - 1], h2[h2.length - 1], '最后一条保留');
  // 只有一条 → 永不压
  p = A.classifyHistoryCompression([mk('user', big)], { maxChars: 100 });
  assert.equal(p.shouldCompress, false, '单条不压');
  // 两条都超阈值 → 只压第一条，保留最后一条
  p = A.classifyHistoryCompression([mk('user', '甲' + big), mk('user', '乙' + big)], { maxChars: 100 });
  assert.equal(p.compress.length, 1, '两条都大也只压第一条');
  assert.equal(p.keep.length, 1);
  // searchHistoryArchive：命中/行号/大小写/空/上限
  const arch = [{ role: 'user', content: '第一行\n变量 金币=100\n第三行' }, { role: 'assistant', content: '已确认修改《开头》' }];
  let hits = A.searchHistoryArchive(arch, '金币');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].n, 1, '条目序号');
  assert.equal(hits[0].role, 'user');
  assert.equal(hits[0].lineNo, 2, '行号');
  assert.equal(hits[0].snippet, '变量 金币=100');
  assert.equal(A.searchHistoryArchive(arch, '不存在的词').length, 0);
  assert.equal(A.searchHistoryArchive([], 'x').length, 0);
  assert.equal(A.searchHistoryArchive(arch, '确认修改').length, 1, '大小写/子串命中');
  // 命中上限 20
  const many = [{ role: 'user', content: Array.from({ length: 40 }, (_, i) => 'a行' + i).join('\n') }];
  assert.equal(A.searchHistoryArchive(many, 'a行').length, 20, '命中上限 20');
}
// ===== Task 12: 素材组工具（list_assets / rename_asset / delete_asset / export_project） =====
// 素材记录含 name/type/tags 与 dataURL 二进制 —— list_assets 必须脱敏（只回 name/type/tags，
// 绝不让 base64 进 LLM 上下文）。deps 按 Task 7 惯例直接赋值 toolsDeps；跨 realm 对象不可
// deepEqual → 只断言 primitive 字段，数组用 join 转 primitive 比较。
// 素材工具是 async（接线层 deps 走 IndexedDB 为 async）：调用须 await，且 deps 可返回 Promise。
(async () => {
  {
    const assets = [{ name: 'bg1', type: 'image', tags: ['背景'], dataURL: 'data:image/png;base64,AAAA' }];
    ctx.Agent.toolsDeps.getAllAssets = () => assets;
    ctx.Agent.toolsDeps.renameAsset = (o, n) => { assets[0].name = n; return { ok: true }; };
    ctx.Agent.toolsDeps.deleteAsset = () => ({ ok: true });
    ctx.Agent.toolsDeps.exportProject = () => ({ format: 'story-editor-project', exportedAt: '2026-01-01' });
    const l = await ctx.Agent.tools.list_assets({});
    assert.ok(Array.isArray(l));
    assert.equal(l[0].name, 'bg1');
    assert.equal(l[0].type, 'image');
    assert.equal(l[0].dataURL, undefined, 'list_assets 必须脱敏，不含 dataURL');
    assert.equal(l[0].tags.join(','), '背景', 'tags 原样返回');
    assert.ok((await ctx.Agent.tools.rename_asset({ name: 'bg1', newName: '夜晚森林' })).ok);
    assert.equal(assets[0].name, '夜晚森林', 'rename_asset 透传改名到 deps');
    assert.ok((await ctx.Agent.tools.delete_asset({ name: '夜晚森林' })).destructive, '删素材必须 destructive');
    assert.equal((await ctx.Agent.tools.export_project({})).format, 'story-editor-project');
    assert.equal((await ctx.Agent.tools.export_project({})).exportedAt, '2026-01-01', 'export 透传 exportedAt');
  }
  {
    // 脱敏边界：tags 缺省 → 输出不含 tags 键；多个素材逐条脱敏，dataURL 一律不得外泄
    ctx.Agent.toolsDeps.getAllAssets = () => [
      { name: 'bg2', type: 'image', dataURL: 'data:image/png;base64,BBBB' },
      { name: 'music1', type: 'audio', tags: ['BGM'], dataURL: 'data:audio/mpeg;base64,CCCC' },
    ];
    const l = await ctx.Agent.tools.list_assets({});
    assert.equal(l.length, 2);
    assert.ok(!('tags' in l[0]), 'tags 缺省时输出不含 tags 键');
    assert.equal(l[1].tags.join(','), 'BGM');
    assert.equal(l[0].dataURL, undefined, '大 base64 不得进入输出');
  }
  {
    // 未接线：rename/delete 报「素材系统未接线」、export 报「导出未接线」；
    // list_assets 按只读约定降级为空数组（同 list_blocks/list_vars），不抛错
    ctx.Agent.toolsDeps = {};
    assert.ok(String((await ctx.Agent.tools.rename_asset({ name: 'x', newName: 'y' })).error).indexOf('素材系统未接线') >= 0);
    assert.ok(String((await ctx.Agent.tools.delete_asset({ name: 'x' })).error).indexOf('素材系统未接线') >= 0);
    assert.ok(String((await ctx.Agent.tools.export_project({})).error).indexOf('导出未接线') >= 0);
    assert.equal(JSON.stringify(await ctx.Agent.tools.list_assets({})), '[]', 'list_assets 未接线时降级为空数组');
  }
  {
    // deps 失败透传：rename/delete 失败带 error 原样返回；deps 返回 falsy → 兜底错误；export falsy → 导出失败
    ctx.Agent.toolsDeps.renameAsset = () => ({ ok: false, error: '改名冲突' });
    ctx.Agent.toolsDeps.deleteAsset = () => ({ ok: false, error: '素材不存在' });
    ctx.Agent.toolsDeps.exportProject = () => null;
    assert.ok(String((await ctx.Agent.tools.rename_asset({ name: 'a', newName: 'b' })).error).indexOf('改名冲突') >= 0, 'rename deps 失败透传 error');
    assert.ok(String((await ctx.Agent.tools.delete_asset({ name: 'a' })).error).indexOf('素材不存在') >= 0, 'delete deps 失败透传 error');
    assert.ok(String((await ctx.Agent.tools.export_project({})).error).indexOf('导出失败') >= 0, 'export deps 返回 falsy → 导出失败');
    ctx.Agent.toolsDeps.renameAsset = () => null;
    assert.ok(String((await ctx.Agent.tools.rename_asset({ name: 'a', newName: 'b' })).error).indexOf('改名失败') >= 0, 'rename deps 返回 falsy 兜底「改名失败」');
    ctx.Agent.toolsDeps.deleteAsset = () => null;
    assert.ok(String((await ctx.Agent.tools.delete_asset({ name: 'a' })).error).indexOf('删除失败') >= 0, 'delete deps 返回 falsy 兜底「删除失败」');
  }
  {
    // async deps（真实 Storage 形态，storage.js:331/372/377/613）：工具 await deps 的 Promise；
    // deps reject → 转 error 返回，不炸 runLoop
    ctx.Agent.toolsDeps.getAllAssets = () => Promise.resolve([{ name: 'async1', type: 'image' }]);
    const l = await ctx.Agent.tools.list_assets({});
    assert.equal(l.length, 1);
    assert.equal(l[0].name, 'async1', 'await async deps');
    ctx.Agent.toolsDeps.deleteAsset = () => Promise.resolve({ ok: true });
    assert.ok((await ctx.Agent.tools.delete_asset({ name: 'async1' })).destructive, 'async deps 的 ok 正常判定');
    ctx.Agent.toolsDeps.renameAsset = () => Promise.reject(new Error('素材不存在'));
    assert.ok(String((await ctx.Agent.tools.rename_asset({ name: 'a', newName: 'b' })).error).indexOf('素材不存在') >= 0, 'deps reject 转 error');
    ctx.Agent.toolsDeps.exportProject = () => Promise.reject(new Error('导出失败'));
    assert.ok(String((await ctx.Agent.tools.export_project({})).error).indexOf('导出失败') >= 0, 'deps reject 转 error');
  }
  // ===== Task 13: runLoop（意图轮 → 装配 → 工具循环）+ isContinuation + buildToolDefs =====
  // runLoop 经 deps.request mock 驱动；断言全部用 primitive / JSON.stringify（vm 沙箱对象不做 deepEqual）。
  {
    // 计划 mock 修复：工具结果轮必须返回 {content:'最终答复', toolCalls:null}
    // （model 收到 tool 消息后给出最终答复，而不是工具轮就返回 toolCalls:null）
    const statuses = [];
    const toolEvents = [];
    const toolResults = [];
    const replies = [];
    const calls = [];
    const fakeRequest = (messages) => {
      calls.push(messages);
      if (calls.length === 1) return '{"scenario":"polish","needs":["current_block"],"note":"润色第二段"}';
      if (calls.length === 2) return { content: '已处理', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'get_current_block', arguments: '{}' } }] };
      return { content: '最终答复', toolCalls: null };
    };
    ctx.Agent.toolsDeps.getActiveBlock = () => ({ name: '第一章', text: '正文' });
    const res = await ctx.Agent.runLoop({
      userText: '把这段润色一下',
      history: [],
      activeScenario: null,
      callbacks: { onStatus: (s) => statuses.push(s), onTool: (t) => { toolEvents.push(t.name); toolResults.push(t.result); }, onWrite: () => {}, onReply: (t) => replies.push(t) },
    }, { request: fakeRequest, buildCtx: () => ({}) });
    assert.equal(res.scenario, 'polish', '意图轮解析出 polish');
    assert.ok(calls.length >= 3, '至少 intent + tool + answer 三轮');
    assert.equal(calls[0].length, 2, '意图轮消息最简（system + user）');
    assert.ok(statuses.indexOf('scenario:polish') >= 0, '发出 scenario:polish 状态');
    assert.ok(statuses.indexOf('turn:tool') >= 0, '工具轮发出 turn:tool 信号（UI 据此移除工具轮废话气泡）');
    assert.ok(toolEvents.indexOf('get_current_block') >= 0, 'onTool 上报工具名');
    assert.ok(toolResults.some((r) => r && r.blockName === '第一章'), 'onTool 在工具执行后上报并携带 result（含真实返回数据）');
    assert.equal(replies.join(','), '最终答复', '最终答复回调 onReply');
  }
  {
    // 延续语跳过意图轮：直接以活跃场景进工具循环（省一次请求）
    const calls = [];
    const replies = [];
    const statuses = [];
    const fakeRequest = (messages) => { calls.push(messages); return { content: '好的，继续写。', toolCalls: null }; };
    const res = await ctx.Agent.runLoop({
      userText: '继续',
      history: [],
      activeScenario: 'polish',
      callbacks: { onStatus: (s) => statuses.push(s), onReply: (t) => replies.push(t) },
    }, { request: fakeRequest, buildCtx: () => ({}) });
    assert.ok(calls[0][0].content.indexOf('局部改稿') >= 0, '首轮即 polish 场景提示词（无意图轮）');
    assert.ok(statuses.indexOf('intent') < 0, '延续语不触发意图轮');
    assert.ok(statuses.indexOf('turn:tool') < 0, '纯答复轮不发 turn:tool');
    assert.equal(res.scenario, 'polish', '场景沿用 polish');
    assert.equal(replies.join(','), '好的，继续写。');
  }
  {
    // 异步工具执行：list_assets 是 async（await toolsDeps 的 Promise）→ runLoop 必须 await 工具结果。
    // 断言工具消息回灌的是脱敏素材 JSON（无 dataURL 泄露）→ 验证 await impl(args) 生效（否则 JSON.stringify(Promise)='{}'）
    const toolMsgs = [];
    const fakeRequest = (messages) => {
      const hasTool = messages.some((m) => m && m.role === 'tool');
      if (!hasTool) return { content: '查询素材', toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'list_assets', arguments: '{}' } }] };
      for (const m of messages) if (m.role === 'tool') toolMsgs.push(m);
      return { content: '素材如下', toolCalls: null };
    };
    ctx.Agent.toolsDeps.getAllAssets = () => Promise.resolve([{ name: 'x', type: 'image', dataURL: 'data:image/png;base64,ZZZ' }]);
    const res = await ctx.Agent.runLoop({
      userText: '看下素材',
      history: [],
      activeScenario: 'general',
      callbacks: {},
    }, { request: fakeRequest, buildCtx: () => ({}) });
    assert.equal(toolMsgs.length, 1, '工具结果消息回灌一轮');
    assert.ok(toolMsgs[0].content.indexOf('"name":"x"') >= 0, '工具消息含脱敏素材 JSON');
    assert.ok(toolMsgs[0].content.indexOf('dataURL') < 0 && toolMsgs[0].content.indexOf('base64,ZZZ') < 0, 'dataURL 不得进 LLM 上下文');
    assert.equal(res.rounds, 2, '工具轮 + 答复轮');
  }
  {
    // buildToolDefs 语义（§4.4）：polish 白名单 6 个；空白名单（general/vars）= 全量 25（含 §14 search_history）；__proto__ 兜底 general
    const polish = ctx.Agent.buildToolDefs('polish');
    assert.equal(polish.length, 6, 'polish 白名单 6 个工具');
    assert.equal(ctx.Agent.buildToolDefs('general').length, 28, 'general 空列表 = 全部工具');
    assert.equal(ctx.Agent.buildToolDefs('vars').length, 28, 'vars 空列表 = 全部工具');
    assert.equal(ctx.Agent.buildToolDefs('__proto__').length, 28, '原型链键兜底 general 全量');
    assert.ok(ctx.Agent.buildToolDefs('general').some(d => d.function.name === 'search_history'), 'search_history 在全量工具中');
    assert.ok(ctx.Agent.buildToolDefs('general').some(d => d.function.name === 'update_creation_setting'), 'update_creation_setting 在全量工具中');
    assert.ok(ctx.Agent.buildToolDefs('general').some(d => d.function.name === 'update_appearance'), 'update_appearance 在全量工具中');
    assert.ok(ctx.Agent.buildToolDefs('general').some(d => d.function.name === 'read_appearance'), 'read_appearance 在全量工具中');
    for (const d of polish) {
      assert.equal(d.type, 'function');
      assert.ok(typeof d.function.name === 'string' && d.function.name.length > 0, 'def 有 name');
      assert.ok(typeof d.function.description === 'string' && d.function.description.length > 0, 'def 有 description');
      assert.ok(d.function.parameters && d.function.parameters.type === 'object', 'def 有 parameters');
    }
    const toolNames = Object.keys(ctx.Agent.tools).sort().join(',');
    const defNames = ctx.Agent.buildToolDefs('general').map((d) => d.function.name).sort().join(',');
    assert.equal(defNames, toolNames, 'TOOL_DEFS 键与 Agent.tools 完全一致');
  }
  {
    // 轮数上限：mock 永远返回同一工具调用 → 8 轮后 loop_limit + 提示语
    const statuses = [];
    const replies = [];
    ctx.Agent.toolsDeps.getActiveBlock = () => ({ name: '第一章', text: '正文' });
    const fakeRequest = () => ({ content: '再读', toolCalls: [{ id: 'call_x', type: 'function', function: { name: 'get_current_block', arguments: '{}' } }] });
    const res = await ctx.Agent.runLoop({
      userText: '一直读',
      history: [],
      activeScenario: 'general',
      callbacks: { onStatus: (s) => statuses.push(s), onReply: (t) => replies.push(t) },
    }, { request: fakeRequest, buildCtx: () => ({}) });
    assert.ok(statuses.indexOf('loop_limit') >= 0, '第 8 轮后触发 loop_limit');
    assert.equal(res.rounds, 8, '恰好 8 轮');
    assert.equal(res.loopLimit, true, '返回 loopLimit 标记');
    assert.equal(replies.join(','), '任务步骤过多，已停止。建议拆成更小的步骤，或先撤销不想要的改动。', '提示语回调');
  }
  {
    // 错误路径：request 抛异常 → onStatus('error') + onReply('出错了：…')，runLoop resolve 不抛
    const statuses = [];
    const replies = [];
    const fakeRequest = () => { throw new Error('boom'); };
    let threw = false;
    let res = null;
    try {
      res = await ctx.Agent.runLoop({
        userText: 'hi',
        history: [],
        activeScenario: 'general',
        callbacks: { onStatus: (s, m) => statuses.push([s, m]), onReply: (t) => replies.push(t) },
      }, { request: fakeRequest, buildCtx: () => ({}) });
    } catch (e) { threw = true; }
    assert.ok(!threw, 'runLoop 出错时不抛出，resolve 返回 {error}');
    assert.ok(statuses.some(([s]) => s === 'error'), '发出 error 状态');
    assert.equal(replies.join(','), '出错了：boom', '错误信息透传 onReply');
    assert.ok(res && res.error && res.error.message === 'boom', '返回 {error} 携带原始异常');
  }
  {
    // ⚠️ spec review 修正：工具轮必须带「携带 tool_calls 的 assistant 消息」——
    // OpenAI/DeepSeek 兼容 API 要求 tool_call_id 对应的 assistant 消息先存在，否则 round 2+ 被拒
    const seen = [];
    const req = (messages) => {
      seen.push(messages.slice());
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '最终答复', toolCalls: null };
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list_blocks', arguments: '{}' } }] };
    };
    await ctx.Agent.runLoop({ userText: 'hi', activeScenario: 'general', callbacks: { onReply: () => {} } }, { request: req, buildCtx: () => ({}) });
    // 第 2 次请求（工具结果轮）的 messages 里，role:'assistant' 且带 tool_calls 的消息必须在 role:'tool' 之前
    const toolRoundMsgs = seen[1] || [];
    const asstIdx = toolRoundMsgs.findIndex(m => m.role === 'assistant' && m.tool_calls);
    const toolIdx = toolRoundMsgs.findIndex(m => m.role === 'tool');
    assert.ok(asstIdx >= 0 && toolIdx > asstIdx, 'assistant(tool_calls) 消息必须先于 tool 消息');
  }
  {
    // ⚠️ spec review 修正：写工具的 before 必须回传（append_to_block/insert_at 返回 before: t），
    // runLoop 透传 → applyAgentWrite 记 before → undoWrite 才能真正撤销
    const writes = [];
    ctx.Agent.toolsDeps.getBlockText = (n) => '旧文第一行\n旧文第二行';
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '改好了', toolCalls: null };
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'append_to_block', arguments: '{"blockName":"第一章","text":"新行"}' } }] };
    };
    await ctx.Agent.runLoop({
      userText: '追加', activeScenario: 'general',
      callbacks: { onWrite: (rec) => writes.push(rec), onReply: () => {} },
    }, { request: req, buildCtx: () => ({}) });
    assert.equal(writes.length, 1, '写工具触发 onWrite');
    assert.equal(writes[0].block, '第一章');
    assert.ok(writes[0].before !== null && writes[0].before.indexOf('旧文第一行') >= 0, 'before 必须回传（撤销可用）');
  }
  {
    // I1：thinking 契约——callDeepseek 的 opts.thinking 是 boolean（truthy=开思考+32768），
    // runLoop 必须传 false（传对象会被当 truthy → 反向开启 thinking）
    const seen = [];
    const req = (messages, toolOpts) => { seen.push(toolOpts); return { content: 'hi', toolCalls: null }; };
    await ctx.Agent.runLoop({ userText: 'hi', activeScenario: null, callbacks: { onReply: () => {} } }, { request: req, buildCtx: () => ({}) });
    assert.equal(seen[0].thinking, false, '意图轮 thinking 必须为 false');
    assert.equal(seen[1].thinking, false, '工具轮 thinking 必须为 false');
  }
  {
    // C2：白名单执行门——polish 场景只下发 6 工具，模型注入 delete_asset 调用必须被拒且不执行
    let deleted = 0;
    ctx.Agent.toolsDeps.deleteAsset = async () => { deleted++; return { ok: true }; };
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '收到', toolCalls: null };
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'delete_asset', arguments: '{"name":"bg1"}' } }] };
    };
    await ctx.Agent.runLoop({ userText: '润色', activeScenario: 'polish', callbacks: { onReply: () => {} } }, { request: req, buildCtx: () => ({}) });
    assert.equal(deleted, 0, '白名单外的工具不得执行');
  }
  {
    // C1：破坏性确认门——onConfirm 返回 false → 不执行删除，模型收到取消说明
    let deleted = 0;
    ctx.Agent.toolsDeps.deleteAsset = async () => { deleted++; return { ok: true }; };
    const toolContents = [];
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') { toolContents.push(last.content); return { content: '收到', toolCalls: null }; }
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'delete_asset', arguments: '{"name":"bg1"}' } }] };
    };
    await ctx.Agent.runLoop({
      userText: '删素材', activeScenario: 'general',
      callbacks: { onReply: () => {}, onConfirm: async () => false },
    }, { request: req, buildCtx: () => ({}) });
    assert.equal(deleted, 0, '确认=false 时不执行删除');
    assert.ok(String(toolContents[0] || '').indexOf('用户取消了操作') >= 0, '取消原因回填模型');
  }
  {
    // C1：onConfirm 返回 true → 执行删除
    let deleted = 0;
    ctx.Agent.toolsDeps.deleteAsset = async () => { deleted++; return { ok: true }; };
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '收到', toolCalls: null };
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'delete_asset', arguments: '{"name":"bg1"}' } }] };
    };
    await ctx.Agent.runLoop({
      userText: '删素材', activeScenario: 'general',
      callbacks: { onReply: () => {}, onConfirm: async () => true },
    }, { request: req, buildCtx: () => ({}) });
    assert.equal(deleted, 1, '确认=true 时执行删除');
  }
  {
    // C1：delete_block 报告引用 → onConfirm（带引用结果）→ 确认后真删落盘
    const saved = [];
    ctx.Agent.toolsDeps.listBlocks = () => ['主剧情', '第二章'];
    ctx.Agent.toolsDeps.getBlockText = (n) => n === '第二章' ? '第二章内容' : '主剧情\n<剧情块:第二章>';
    ctx.Agent.toolsDeps.blocksDoc = () => ({ '主剧情': '主剧情\n<剧情块:第二章>', '第二章': '第二章内容' });
    ctx.Agent.toolsDeps.mainBlock = '__MAIN__';
    ctx.Agent.toolsDeps.saveBlocks = (doc) => { saved.push(doc); };
    const confirmResults = [];
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '删了', toolCalls: null };
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'delete_block', arguments: '{"blockName":"第二章"}' } }] };
    };
    await ctx.Agent.runLoop({
      userText: '删块', activeScenario: 'general',
      callbacks: { onReply: () => {}, onConfirm: async (info) => { confirmResults.push(info); return true; } },
    }, { request: req, buildCtx: () => ({}) });
    assert.equal(confirmResults.length, 1, '确认回调收到引用报告');
    assert.ok(confirmResults[0].result && confirmResults[0].result.references, '确认回调携带引用信息');
    assert.equal(saved.length, 1, '确认后保存');
    assert.equal(saved[0]['第二章'], undefined, '块被删除');
    assert.ok(String(saved[0]['主剧情']).indexOf('第二章') >= 0, '主剧情保留');
  }
  {
    // I3：单轮并行工具上限 4（设计 §8）——5 个 toolCalls 只执行前 4 个
    const names = [];
    ctx.Agent.toolsDeps.listBlocks = () => ['a', 'b', 'c', 'd', 'e'];
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '收到', toolCalls: null };
      return {
        content: null,
        toolCalls: ['a', 'b', 'c', 'd', 'e'].map((n, i) => ({ id: 'c' + i, type: 'function', function: { name: 'list_blocks', arguments: '{}' } })),
      };
    };
    await ctx.Agent.runLoop({
      userText: 'x', activeScenario: 'general',
      callbacks: { onTool: (t) => names.push(t.name), onReply: () => {} },
    }, { request: req, buildCtx: () => ({}) });
    assert.equal(names.length, 4, '单轮最多执行 4 个工具');
  }
  {
    // I3：同块写守卫——本轮内两个 append_to_block 写同一块，第二个被拒（防 stale-read 覆盖）
    ctx.Agent.toolsDeps.getBlockText = (n) => '旧文';
    const toolContents = [];
    let writeCount = 0;
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') { toolContents.push(last.content); return { content: '收到', toolCalls: null }; }
      return {
        content: null,
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'append_to_block', arguments: '{"blockName":"第一章","text":"A"}' } },
          { id: 'c2', type: 'function', function: { name: 'append_to_block', arguments: '{"blockName":"第一章","text":"B"}' } },
        ],
      };
    };
    await ctx.Agent.runLoop({
      userText: '追加', activeScenario: 'general',
      callbacks: { onWrite: () => writeCount++, onReply: () => {} },
    }, { request: req, buildCtx: () => ({}) });
    // 第二轮 req 只「看到」最后一条 tool 消息（c2）——它必须是同块拒绝；c1 成功触发 onWrite
    assert.equal(writeCount, 1, '第一个写成功（触发 onWrite）');
    assert.ok(String(toolContents[0] || '').indexOf('已被修改') >= 0, '同块第二次写被拒');
  }
  {
    // I2：单个工具抛错不得炸掉整轮——错误回填，runLoop 正常结束
    const replies = [];
    const req = (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') return { content: '继续', toolCalls: null };
      return { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_block', arguments: '{"blockName":"x"}' } }] };
    };
    ctx.Agent.toolsDeps.getBlockText = () => { throw new Error('boom'); };
    let threw = false;
    try {
      await ctx.Agent.runLoop({ userText: 'x', activeScenario: 'general', callbacks: { onReply: (t) => replies.push(t) } }, { request: req, buildCtx: () => ({}) });
    } catch (e) { threw = true; }
    assert.ok(!threw, '工具抛错不炸 runLoop');
    assert.ok(replies.length >= 1, '仍有最终答复');
  }
  {
    // runLoop 历史接入（spec review 修复）：opts.history 须插入到「当前 userText」之前（多轮对话连续性）
    const captured = [];
    const req = (messages) => {
      captured.push(messages.map(m => m.role + ':' + String(m.content).slice(0, 20)));
      return { content: '好', toolCalls: null };
    };
    await ctx.Agent.runLoop({
      userText: '继续改第二段',
      activeScenario: 'polish',
      history: [
        { role: 'user', content: '第一轮请求' },
        { role: 'assistant', content: '第一轮答复' },
        { role: 'tool', content: '不得进入' },
        { role: 'user', content: '' },
      ],
      callbacks: { onReply: () => {} },
    }, { request: req, buildCtx: () => ({}) });
    const msgs = captured[0];
    const last = msgs[msgs.length - 1];
    assert.ok(last.indexOf('user:继续改第二段') >= 0, '最后一条必须是当前 userText');
    const joined = msgs.join('|');
    assert.ok(joined.indexOf('user:第一轮请求') >= 0, '历史 user 消息参与上下文');
    assert.ok(joined.indexOf('assistant:第一轮答复') >= 0, '历史 assistant 消息参与上下文');
    assert.ok(joined.indexOf('tool:') < 0, '非 user/assistant 历史消息被过滤');
    assert.ok(joined.indexOf('user:') < joined.lastIndexOf('user:继续改第二段'), '历史消息位于当前 userText 之前');
  }
  {
    // 无 history 时消息结构不变（最后一条仍为当前 userText，向后兼容）
    const captured = [];
    await ctx.Agent.runLoop({
      userText: '润色', activeScenario: 'polish',
      callbacks: { onReply: () => {} },
    }, { request: (messages) => { captured.push(messages); return { content: '好', toolCalls: null }; }, buildCtx: () => ({}) });
    const last = captured[0][captured[0].length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content, '润色');
  }
  {
    // Important 1（Task 15 review 修复）：生产调用形状——agentSend 先 push 当前 userText 到历史再整体传入，
    // history 最后一条与 opts.userText 相同。runLoop 不得让当前 userText 重复出现在请求中（重复=token 浪费）。
    const captured = [];
    const req = (messages) => {
      captured.push(messages.map(m => m.role + ':' + String(m.content)));
      return { content: '好', toolCalls: null };
    };
    await ctx.Agent.runLoop({
      userText: '继续写',
      activeScenario: 'polish',
      history: [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '答' },
        { role: 'user', content: '继续写' }, // 最后一条与 userText 相同（agentSend 形状）
      ],
      callbacks: { onReply: () => {} },
    }, { request: req, buildCtx: () => ({}) });
    const msgs = captured[0];
    const userCount = msgs.filter(m => m.indexOf('user:继续写') >= 0).length;
    assert.equal(userCount, 1, '当前 userText 不得重复出现在请求中');
    assert.equal(msgs[msgs.length - 1], 'user:继续写', '当前 userText 仍在最后');
  }
  {
    // ===== §16: 创作设定 + 外观工具（Agent 全面辅助：可写 meta.creation / meta.appearance） =====
    // read_appearance：返回外观对象；缺 deps 报错
    {
      const deps = mockDeps();
      deps.getAppearance = () => ({ fontSize: 20, titleFont: '', bodyFont: '', dividerFont: '', galBoxColor: 'rgba(0,0,0,0.55)', titleColor: '' });
      deps.appearanceFields = ['fontSize', 'titleFont', 'bodyFont', 'dividerFont', 'galBoxColor', 'titleColor'];
      ctx.Agent.toolsDeps = deps;
      const r = ctx.Agent.tools.read_appearance();
      assert.ok(r.appearance && r.appearance.fontSize === 20, 'read_appearance 返回外观对象');
      ctx.Agent.toolsDeps = {};
      assert.equal(ctx.Agent.tools.read_appearance().error, '编辑器未就绪', 'read_appearance 缺 deps 报错');
    }
    // update_appearance：合并保存 + 字段/数值校验 + 缺 deps
    {
      const deps = mockDeps();
      deps._cur = { fontSize: 20, titleFont: '', bodyFont: '', dividerFont: '', galBoxColor: 'rgba(0,0,0,0.55)', titleColor: '' };
      deps.getAppearance = () => Object.assign({}, deps._cur); // 模拟编辑器：saveAppearance 合并后 getAppearance 返回新值
      deps.saveAppearance = (p) => { deps._cur = Object.assign({}, deps._cur, p); };
      deps.appearanceFields = ['fontSize', 'titleFont', 'bodyFont', 'dividerFont', 'galBoxColor', 'titleColor'];
      ctx.Agent.toolsDeps = deps;
      const r = ctx.Agent.tools.update_appearance({ patch: { fontSize: 22, titleColor: '#ff0000' } });
      assert.equal(r.ok, true);
      assert.equal(deps._cur.fontSize, 22, 'saveAppearance 收到 patch');
      assert.equal(deps._cur.titleColor, '#ff0000');
      assert.equal(r.applied.fontSize, 22, 'applied 返回当前外观');
      assert.equal(r.applied.titleColor, '#ff0000');
      assert.ok(ctx.Agent.tools.update_appearance({ patch: { fontSize: 99 } }).error.indexOf('14-32') >= 0, 'fontSize 越界拒绝');
      assert.ok(ctx.Agent.tools.update_appearance({ patch: { fontSize: 'abc' } }).error, 'fontSize 非数值拒绝');
      assert.ok(ctx.Agent.tools.update_appearance({ patch: { noSuchField: 'x' } }).error.indexOf('未知外观字段') >= 0, '未知字段拒绝');
      assert.ok(ctx.Agent.tools.update_appearance({ patch: 'nope' }).error, 'patch 非对象拒绝');
      assert.ok(ctx.Agent.tools.update_appearance({ patch: { fontSize: 18 } }).ok, '合法 patch 应用');
      ctx.Agent.toolsDeps = {};
      assert.equal(ctx.Agent.tools.update_appearance({ patch: { fontSize: 18 } }).error, '编辑器未就绪', 'update_appearance 缺 deps 报错');
    }
    // update_creation_setting：block 编码字段 + preview 分级 + 校验
    {
      const deps = mockDeps();
      deps.getCreation = () => ({ outline: '旧大纲', intro: '', world: '', style: '', clues: '' });
      deps.saveCreation = (c) => { deps._saved = c; };
      ctx.Agent.toolsDeps = deps;
      const r = ctx.Agent.tools.update_creation_setting({ field: 'outline', value: '新大纲很长' });
      assert.equal(r.ok, true);
      assert.equal(r.block, 'creation:outline', 'block 编码字段名');
      assert.equal(r.before, '旧大纲');
      assert.equal(r.resultText, '新大纲很长');
      assert.equal(r.impact.wholeBlock, true, '整字段替换 → preview 确认');
      assert.equal(r.impact.chars, 2, '变更量 = |新-旧| 长度差');
      const rec = ctx.Agent.applyAgentWrite({ block: r.block, before: r.before, resultText: r.resultText, impact: r.impact }, deps, []);
      assert.equal(rec.level, 'preview', '创作设定写入走 preview 分级');
      assert.ok(ctx.Agent.tools.update_creation_setting({ field: 'noSuchField', value: 'x' }).error.indexOf('未知创作设定字段') >= 0, '未知字段拒绝');
      assert.ok(ctx.Agent.tools.update_creation_setting({ field: 'intro', value: 42 }).error, 'value 非字符串拒绝');
      assert.ok(ctx.Agent.tools.update_creation_setting({ field: '', value: 'x' }).error, '空字段拒绝');
      ctx.Agent.toolsDeps = {};
      assert.equal(ctx.Agent.tools.update_creation_setting({ field: 'outline', value: 'x' }).error, '编辑器未就绪', 'update_creation_setting 缺 deps 报错');
    }
  }
  console.log('agent.test.js OK');
})().catch(e => { console.error(e); process.exit(1); });
