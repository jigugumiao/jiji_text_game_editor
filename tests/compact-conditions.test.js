const assert = require('node:assert/strict');
const UI = require('../js/story-visual-ui.js');
const Vars = require('../js/story-vars.js');
const states = { 金币: 'number', 钥匙: 'boolean', 姓名: 'text' };

const draft = {
  mode: 'all', rows: [
    { kind: 'comparison', name: '金币', op: '>=', value: 10 },
    { kind: 'group', mode: 'any', rows: [
      { kind: 'comparison', name: '钥匙', op: '!=', value: false },
      { kind: 'comparison', name: '金币', op: '<', value: '' }
    ] },
    { kind: 'group', mode: 'all', rows: [] }
  ]
};
const before = JSON.stringify(draft);
assert.deepEqual(UI.conditionDraftStatus(draft, states), { count: 3, incomplete: 2, firstIncomplete: 3 },
  '组头应递归统计条件，空子组也必须计为未完成');
assert.equal(UI.conditionNaturalText(draft, states), '请完成第 3 条条件。');
assert.equal(JSON.stringify(draft), before, '读取显示状态不得修改条件草稿');
assert.equal(UI.conditionRowIssue(draft.rows[1].rows[1], states), '请输入数值');
assert.equal(UI.conditionRowIssue({ name: '', op: '', value: '' }, states), '请选择变量');
assert.equal(UI.conditionRowIssue({ name: '失效状态', op: '=', value: 1 }, states), '剧情状态「失效状态」不存在');
assert.equal(UI.conditionRowIssue({ name: '金币', op: 'contains', value: 1 }, states), '请选择判断关系');
assert.equal(UI.conditionRowIssue({ name: '金币', op: '>=', value: '1x' }, states), '请输入有效数值');
assert.equal(UI.conditionRowIssue({ name: '金币', op: '>=', value: 0 }, states), '');
assert.equal(UI.conditionRowIssue({ name: '钥匙', op: '!=', value: false }, states), '');

draft.rows[1].rows[1].value = -2.5;
draft.rows.pop();
assert.deepEqual(UI.conditionDraftStatus(draft, states), { count: 3, incomplete: 0, firstIncomplete: 0 });
assert.equal(Vars.serializeCondition(UI.conditionDraftToAst(draft)), '金币>=10 && (钥匙!=false || 金币<-2.5)',
  '显示状态统计不得改变组内或组间逻辑');
console.log('compact-conditions.test.js passed');
