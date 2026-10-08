// 右键变量插入的纯模型：操作集合、生成语法与源码替换。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

// 右键菜单必须将变量作为动态子菜单接入，并复用共享的变量插入模型。
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

assert.match(editorSource, /kind: 'variable', label: '变量'/);
assert.match(editorSource, /function buildVariableSubmenu\(\)/);
assert.match(editorSource, /window\.Storage\.getVars\(\)/);
assert.match(editorSource, /function buildVariableActionSubmenu\(state, includeCondition\)/);
assert.match(editorSource, /window\.StoryVars\.getInsertActions\(state, includeCondition\)/);
assert.match(editorSource, /window\.StoryOptions\.extractOptionLine\(line\)\.some/);
assert.match(editorSource, /label: '变量库为空', disabled: true/);
assert.match(editorSource, /label: '前往变量库'/);
assert.match(editorSource, /switchLib\('variable'\)/);
assert.match(editorSource, /if \(it\.disabled\)/);
assert.match(cssSource, /\.ctx-item\.disabled/);

console.log('context-menu-variable.test.js passed');
