// 双端一致性回归测试：导出端 parseStoryForExport 与编辑端共享的 StoryVars 解析行为必须一致。
// 历史 bug（本测试防回归）：
//   1) 一行多标签 <变量:a=1><变量:b=2> 被旧导出端解析成一个操作、值损坏为 "1><变量:b=2"；
//   2) 值含空格 <变量:名字=你好 世界> 被旧导出端整行静默丢弃；
//   3) 无法识别的 <变量:...> 行被旧导出端静默吞掉（编辑器按普通文本保留）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const exporterSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'exporter.js'), 'utf8');

// 导出端必须接入共享模块
assert.match(exporterSrc, /window\.StoryVars\.parseVarLine\(t\)/, 'exporter.js 的 parseStoryForExport 必须走 StoryVars.parseVarLine');
assert.equal((exporterSrc.match(/__STORY_VARS_RUNTIME__/g) || []).length, 2, '占位必须恰好出现两次（模板内 1 处 + replace 1 处），注释里不能复述占位符');
assert.match(exporterSrc, /StoryVars\.buildRuntimeSource/, 'buildRuntimeHTML 必须注入 StoryVars 运行时源码');
// 编辑器同样必须接入共享模块
const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');
assert.match(editorSrc, /StoryVars\.parseVarLine\(t\)/, 'editor.js 预览解析必须走 StoryVars.parseVarLine');
assert.doesNotMatch(editorSrc, /RE_VAR_OP\s*=/, 'editor.js 不应再保留本地 RE_VAR_OP 正则（避免分叉）');

// 提取 parseStoryForExport 真实源码执行（顶层函数，闭括号在第 0 列）
function grabTopLevel(name, src) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  assert.ok(m, 'source contains top-level ' + name);
  return m[0];
}
const SV = require('../js/story-vars.js');
const ctx = { window: { StoryVars: SV } };
vm.createContext(ctx);
vm.runInContext(grabTopLevel('parseStoryForExport', exporterSrc) + '\nthis.parseStoryForExport = parseStoryForExport;', ctx);
const parse = ctx.parseStoryForExport;

// —— 用例 1：一行多标签必须得到两个独立操作 ——
{
  const nodes = parse('<变量:a=1><变量:b=2>');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'varop');
  assert.deepEqual(nodes[0].ops, [{ name: 'a', op: '=', val: '1' }, { name: 'b', op: '=', val: '2' }]);
}
// —— 用例 2：值含空格必须完整保留 ——
{
  const nodes = parse('<变量:名字=你好 世界>');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'varop');
  assert.deepEqual(nodes[0].ops, [{ name: '名字', op: '=', val: '你好 世界' }]);
}
// —— 用例 3：坏标签按普通文本保留，不再静默吞掉 ——
{
  const nodes = parse('前文\n<变量:zzz>\n后文');
  const texts = nodes.filter(n => n.type === 'text').map(n => n.content).join('\n');
  assert.ok(texts.includes('<变量:zzz>'), '坏标签行应作为文本保留');
  assert.ok(!nodes.some(n => n.type === 'varop'), '不应产生 varop 节点');
}
// —— 用例 4：与 StoryVars.parseVarLine 结果一致（双端一致性） ——
{
  const samples = [
    '<变量:金币=100>',
    '<变量:a=1><变量:b=2>',
    '<变量:名字=你好 世界>',
    '<变量:x=1;y=2>',
    '<变量:勇气+1>',
    '<变量:血量-5>',
    '<变量:bad>',
    '<玩家输入变量:主角名,"请输入">',
  ];
  for (const s of samples) {
    const expected = SV.parseVarLine(s.trim());
    if (expected.ops.length) {
      const nodes = parse(s);
      assert.equal(nodes.length, 1, s);
      assert.equal(nodes[0].type, 'varop', s);
      assert.deepEqual(nodes[0].ops, expected.ops, s);
    }
  }
}

// —— 运行时注入源码自校验：序列化出的 StoryVars 在干净环境里可用 ——
{
  const runtimeCtx = { window: {} };
  vm.createContext(runtimeCtx);
  vm.runInContext(SV.buildRuntimeSource(), runtimeCtx);
  const R = runtimeCtx.window.StoryVars;
  assert.ok(R && typeof R.evalCondition === 'function', '注入源应定义 window.StoryVars');
  const vars = {};
  R.applyOps(vars, [{ name: '金币', op: '=', val: '100' }, { name: '金币', op: '+', val: '50' }]);
  assert.equal(vars.金币, 150);
  assert.equal(R.evalCondition('金币>=120', n => vars[n]), true);
  // 混合逻辑（旧运行时会算错的用例）：a&&b||c 应按 || 优先级正确求值
  const v2 = { a: true, b: false, c: true };
  assert.equal(R.evalCondition('a&&b||c', n => v2[n]), true, '混合逻辑优先级必须正确');
}

console.log('var-conformance.test.js passed');
