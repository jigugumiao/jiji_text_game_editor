const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert.match(html, /<button id="editor-mode-visual" type="button">可视化编辑<\/button>/,
  '编辑器必须提供可视化编辑模式切换');
assert.match(html, /<button id="editor-mode-source" type="button">源码模式<\/button>/,
  '编辑器必须提供源码模式切换');
assert.match(html, /<div id="story-visual-editor" class="story-visual-editor" hidden><\/div>/,
  '编辑器必须提供独立的可视化编辑器宿主');

const StoryVisualUI = require(path.join(root, 'js', 'story-visual-ui.js'));
['createController', 'renderDocument', 'describeNode', 'commitFocusedEditor', 'destroy'].forEach((name) => {
  assert.equal(typeof StoryVisualUI[name], 'function', `StoryVisualUI 必须导出 ${name}`);
});

assert.deepEqual(
  StoryVisualUI.describeNode({ kind: 'state_change', data: { effects: [{ name: '金币', op: '-', val: '10' }] } }, { 金币: 'number' }),
  { kind: 'state_change', summary: '金币减少 10', editable: true },
  '变量变化应只显示可读的非空摘要'
);

assert.deepEqual(
  StoryVisualUI.describeNode({ kind: 'text', raw: '获得 {金币}，门{拿到钥匙:已打开|仍锁着}，{{金币}}。' }, { 金币: 'number', 拿到钥匙: 'boolean' }),
  {
    kind: 'text',
    editable: true,
    parts: [
      { kind: 'text', value: '获得 ' },
      { kind: 'state_token', source: '{金币}', name: '金币', type: 'number' },
      { kind: 'text', value: '，门' },
      { kind: 'state_token', source: '{拿到钥匙:已打开|仍锁着}', name: '拿到钥匙', type: 'boolean', trueText: '已打开', falseText: '仍锁着' },
      { kind: 'text', value: '，{{金币}}。' }
    ]
  },
  '单花括号插值应成为原子 token，双花括号则保持原始文字'
);

console.log('visual-story-ui.test.js passed');
