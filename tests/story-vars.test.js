// story-vars.js 单元测试：变量系统单一事实源（解析 / 类型 / 条件 / 插值 / 静态分析）
const assert = require('node:assert/strict');
const StoryVars = require('../js/story-vars.js');

// ---------- parseVarLine ----------
{
  // 单操作
  const a = StoryVars.parseVarLine('<变量:金币=10>');
  assert.equal(a.ops.length, 1);
  assert.deepEqual(a.ops[0], { name: '金币', op: '=', val: '10' });
  assert.equal(a.bad.length, 0);

  // 一行多标签（历史 bug：旧导出端把它解析成一个操作、值损坏）
  const b = StoryVars.parseVarLine('<变量:a=1><变量:b=2>');
  assert.equal(b.ops.length, 2);
  assert.deepEqual(b.ops.map(o => o.name), ['a', 'b']);

  // 值含空格（历史 bug：旧导出端要求无空格，导致整行被吞）
  const c = StoryVars.parseVarLine('<变量:名字=你好 世界>');
  assert.equal(c.ops.length, 1);
  assert.equal(c.ops[0].val, '你好 世界');

  // 空值赋值
  const d = StoryVars.parseVarLine('<变量:x=>');
  assert.equal(d.ops.length, 1);
  assert.equal(d.ops[0].val, '');

  // 旧版分号分隔兼容
  const e = StoryVars.parseVarLine('<变量:a=1;b=2>');
  assert.equal(e.ops.length, 2);
  assert.deepEqual(e.ops.map(o => o.name), ['a', 'b']);

  // 坏标签
  const f = StoryVars.parseVarLine('<变量:zzz><变量:k=1>');
  assert.equal(f.ops.length, 1);
  assert.deepEqual(f.bad, ['<变量:zzz>']);

  // 非变量行
  assert.equal(StoryVars.parseVarLine('普通文本').ops.length, 0);
  assert.equal(StoryVars.parseVarLine('').ops.length, 0);

  // 序列化往返
  const ops = [{ name: 'a', op: '=', val: '1' }, { name: 'b', op: '+', val: '2' }, { name: 'c', op: '-', val: '3' }];
  const rt = StoryVars.parseVarLine(StoryVars.serializeVarOps(ops));
  assert.deepEqual(rt.ops, ops);
}

// ---------- parsePlayerInput ----------
{
  assert.deepEqual(StoryVars.parsePlayerInput('<玩家输入变量:主角名,"请输入名字">'), { name: '主角名', prompt: '请输入名字' });
  assert.deepEqual(StoryVars.parsePlayerInput('<玩家输入变量:主角名,"">'), { name: '主角名', prompt: '' });
  assert.equal(StoryVars.parsePlayerInput('<玩家输入变量:主角名>'), null);
}

// ---------- extractCondExprs ----------
{
  // >= 不能截断
  assert.deepEqual(StoryVars.extractCondExprs('<选项:"强攻",战斗块,条件:力量>=20>'), ['力量>=20']);
  assert.deepEqual(StoryVars.extractCondExprs('<选项:"买",商店,条件:金币<=5>'), ['金币<=5']);
  // 多选项
  const two = StoryVars.extractCondExprs('<选项:"A",块A,条件:a>=1> <选项:"B",块B,条件:b>=2>');
  assert.deepEqual(two, ['a>=1', 'b>=2']);
}

// ---------- 类型与求值 ----------
{
  assert.equal(StoryVars.coerceLiteral('true'), true);
  assert.equal(StoryVars.coerceLiteral('false'), false);
  assert.equal(StoryVars.coerceLiteral('3.5'), 3.5);
  assert.equal(StoryVars.coerceLiteral('你好 世界'), '你好 世界');

  const v = {};
  StoryVars.applyOps(v, [
    { name: '金币', op: '=', val: '100' },
    { name: '金币', op: '+', val: '50' },
    { name: '金币', op: '-', val: '30' },
    { name: '开关', op: '=', val: 'true' },
    { name: '文本', op: '=', val: '' },
    { name: '新值', op: '=', val: '你好 世界' },
  ]);
  assert.equal(v.金币, 120);
  assert.equal(v.开关, true);
  assert.equal(v.文本, '');
  assert.equal(v.新值, '你好 世界');

  const vars = { 金币: 120, 力量: 20, 中毒: false, 名字: '张三' };
  const g = n => vars[n];
  // 优先级：&& 高于 ||
  assert.equal(StoryVars.evalCondition('力量>=20 && 金币>100 || 中毒', g), true);
  assert.equal(StoryVars.evalCondition('力量>=20 && (金币<100 || 中毒)', g), false);
  // 括号
  assert.equal(StoryVars.evalCondition('(力量<5 || 中毒) && 金币>=100', g), false);
  // ! 与裸名
  assert.equal(StoryVars.evalCondition('!中毒', g), true);
  assert.equal(StoryVars.evalCondition('中毒', g), false);
  // 引号字符串
  assert.equal(StoryVars.evalCondition('名字=="张三"', g), true);
  assert.equal(StoryVars.evalCondition('名字!="张三"', g), false);
  // 旧写法「=」作等于
  assert.equal(StoryVars.evalCondition('力量=20', g), true);
  // 空表达式恒真
  assert.equal(StoryVars.evalCondition('', g), true);
  // 语法错误返回 false 且 parseCondition 返回 null
  assert.equal(StoryVars.parseCondition('力量>>'), null);
  assert.equal(StoryVars.evalCondition('力量>>', g), false);
  // 未定义变量按 undefined 参与
  assert.equal(StoryVars.evalCondition('不存在==', g), false);
}

// ---------- 条件 AST 公共接口 / 类型化运算符 ----------
{
  const ast = StoryVars.parseCondition('(金币>=10 && 见过商人) || 声望>=20');
  assert.equal(ast.k, 'or');
  assert.equal(StoryVars.serializeCondition(ast), '(金币>=10 && 见过商人) || 声望>=20');
  assert.equal(StoryVars.summarizeCondition(ast, {
    金币: 'number', 见过商人: 'boolean', 声望: 'number'
  }), '金币不少于 10 且见过商人是“是”，或者声望不少于 20');

  const textVars = { 身份: '皇家贵宾' };
  assert.equal(StoryVars.evalCondition('身份 contains "贵宾"', n => textVars[n]), true);
  assert.equal(StoryVars.evalCondition('身份 notcontains "平民"', n => textVars[n]), true);
  const containsAst = StoryVars.parseCondition('身份 contains "贵宾"');
  const notContainsAst = StoryVars.parseCondition('身份 notcontains "平民"');
  assert.equal(StoryVars.serializeCondition(containsAst), '身份 contains "贵宾"');
  assert.equal(StoryVars.serializeCondition(notContainsAst), '身份 notcontains "平民"');
  assert.deepEqual(StoryVars.parseCondition(StoryVars.serializeCondition(containsAst)), containsAst);
  assert.deepEqual(StoryVars.parseCondition(StoryVars.serializeCondition(notContainsAst)), notContainsAst);
  assert.deepEqual(StoryVars.validateConditionTypes(containsAst, { 身份: 'text' }), { ok: true, errors: [] });
  assert.deepEqual(StoryVars.validateConditionTypes(containsAst, { 身份: 'number' }), {
    ok: false,
    errors: [{ name: '身份', op: 'contains', expected: 'text', actual: 'number' }]
  });

  // 否定逻辑组必须保留括号，否则 !a || b 会改变 !(a || b) 的语义。
  ['!(钥匙 || 通行证)', '!(金币>=10 && 见过商人)'].forEach(expr => {
    const negated = StoryVars.parseCondition(expr);
    assert.equal(StoryVars.serializeCondition(negated), expr);
    assert.equal(
      StoryVars.evalCondition(StoryVars.serializeCondition(negated), n => ({ 钥匙: true, 通行证: false, 金币: 10, 见过商人: true })[n]),
      false
    );
  });
}

// ---------- interpolate ----------
{
  const vars = { 金币: 120, 中毒: false, 已见面: true };
  const g = n => vars[n];
  assert.equal(StoryVars.interpolate('你有{金币}枚金币', g), '你有120枚金币');
  assert.equal(StoryVars.interpolate('{中毒:中毒了|没事}', g), '没事');
  assert.equal(StoryVars.interpolate('{已见面:见过|初见}', g), '见过');
  assert.equal(StoryVars.interpolate('{{转义保留}}', g), '{{转义保留}}');
  assert.equal(StoryVars.interpolate('{不存在的变量}', g), '{不存在的变量}');
}

// ---------- analyze ----------
{
  const blocks = {
    __MAIN__: [
      '<变量:金帀=5>',                 // 错别字赋值（库中是 金币）→ undeclared_write + rename 建议
      '{金帀}枚钱',                    // → undeclared_read
      '<变量:金币=你好 世界>',          // 合法（新解析器支持空格）
      '{金币}',
      '<选项:"买",商店,条件:金币>=10 && !会员>',
      '<变量:zzz>',                   // 坏标签 → malformed_tag
    ].join('\n'),
    商店: '{金币}金币花出去了\n<变量:金币-10>',
  };
  const varDefs = [
    { name: '金币', type: 'number', value: 0 },
    { name: '会员', type: 'boolean', value: false },
  ];
  const r = StoryVars.analyze(blocks, varDefs);
  const kinds = r.issues.map(i => i.kind);

  assert.ok(kinds.includes('undeclared_write'), '应有未声明赋值');
  const uw = r.issues.find(i => i.kind === 'undeclared_write');
  assert.equal(uw.block, '__MAIN__');
  assert.equal(uw.line, 1);
  assert.equal(uw.name, '金帀');
  // 错别字建议：金帀 → 金币
  const ren = (uw.fixes || []).find(f => f.type === 'rename_var');
  assert.ok(ren && ren.to === '金币', '应建议改名为金币');
  assert.ok((uw.fixes || []).some(f => f.type === 'create_var'), '应提供创建变量修复');

  assert.ok(kinds.includes('undeclared_read'), '应有未定义读取');
  assert.ok(kinds.includes('malformed_tag'), '应有坏标签');
  const bad = r.issues.find(i => i.kind === 'malformed_tag');
  assert.equal(bad.raw, '<变量:zzz>');
  assert.ok((bad.fixes || []).some(f => f.type === 'remove_tag'));

  // 使用关系图跨模块聚合：金币 写在主剧情和商店、读在两边
  const u = r.usage['金币'];
  assert.ok(u.writes.length >= 2);
  assert.ok(u.reads.length >= 2);
  assert.equal(u.conds.length, 1);

  // never_written：库里有但从未赋值的变量
  const varDefs2 = [{ name: '孤儿', type: 'text', value: '' }];
  const r2 = StoryVars.analyze({ __MAIN__: '{孤儿}' }, varDefs2);
  assert.ok(r2.issues.some(i => i.kind === 'never_written' && i.name === '孤儿'));

  // dead_var：写了但从不读
  const r3 = StoryVars.analyze({ __MAIN__: '<变量:死变量=1>' }, [{ name: '死变量', type: 'number', value: 0 }]);
  assert.ok(r3.issues.some(i => i.kind === 'dead_var' && i.name === '死变量'));

  // 类型混用：非数字做加减
  const r4 = StoryVars.analyze(
    { __MAIN__: '<变量:开关+1>' },
    [{ name: '开关', type: 'boolean', value: false }]
  );
  assert.ok(r4.issues.some(i => i.kind === 'type_mismatch' && i.name === '开关'));
}

// ---------- suggestRename / inferTypeFromValue ----------
{
  assert.equal(StoryVars.suggestRename('金帀', ['金币', '勇气']), '金币');
  assert.equal(StoryVars.suggestRename('完全不同', ['金币']), null);
  assert.equal(StoryVars.inferTypeFromValue('12'), 'number');
  assert.equal(StoryVars.inferTypeFromValue('true'), 'boolean');
  assert.equal(StoryVars.inferTypeFromValue('你好 世界'), 'text');
}

console.log('story-vars.test.js passed');
