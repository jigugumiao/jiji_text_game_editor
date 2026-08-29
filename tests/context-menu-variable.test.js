// 右键变量插入的纯模型：操作集合、生成语法与源码替换。
const assert = require('node:assert/strict');
const StoryVars = require('../js/story-vars.js');

assert.deepEqual(
  StoryVars.getInsertActions({ name: '金币', type: 'number' }, false).map(item => item.act),
  ['read', 'assign', 'inc', 'dec']
);
assert.deepEqual(
  StoryVars.getInsertActions({ name: '工作', type: 'text' }, false).map(item => item.act),
  ['read', 'assign', 'input']
);
assert.deepEqual(
  StoryVars.getInsertActions({ name: '已开门', type: 'boolean' }, true).map(item => item.act),
  ['read', 'assign', 'cond']
);

const boolRead = '{已开门:是|否}';
assert.deepEqual(StoryVars.buildInsertChoice('read', '已开门', 'boolean'), {
  text: boolRead, caretOffset: boolRead.length, standalone: false
});
const assignOpen = '<变量:金币=';
assert.deepEqual(StoryVars.buildInsertChoice('assign', '金币', 'number'), {
  text: assignOpen + '>', caretOffset: assignOpen.length, standalone: true
});
const inputOpen = '<玩家输入变量:工作,"';
assert.deepEqual(StoryVars.buildInsertChoice('input', '工作', 'text'), {
  text: inputOpen + '">', caretOffset: inputOpen.length, standalone: true
});

const inline = StoryVars.applyInsertChoice('你 好', 1, 2, StoryVars.buildInsertChoice('read', '工作', 'text'));
assert.deepEqual(inline, { source: '你{工作}好', caret: '你{工作}'.length });
const standalone = StoryVars.applyInsertChoice('前文后文', 2, 2, StoryVars.buildInsertChoice('assign', '金币', 'number'));
assert.equal(standalone.source, '前文\n<变量:金币=>\n后文');
assert.equal(standalone.caret, ('前文\n' + assignOpen).length);

console.log('context-menu-variable.test.js passed');
