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

['createEmptyOption', 'validateOptionDraft', 'conditionAstToDraft', 'conditionDraftToAst', 'effectDraftToOps'].forEach((name) => {
  assert.equal(typeof StoryVisualUI[name], 'function', `StoryVisualUI 必须导出 ${name}`);
});

const stateMap = { 金币: 'number', 已见面: 'boolean', 名字: 'text' };
assert.deepEqual(StoryVisualUI.createEmptyOption(['开场', '商店']), {
  text: '', block: '开场', condition: null, unmetBehavior: 'hide', unmetMessage: '', effects: [], unknownFields: []
}, '新选项应选择第一个剧情块，并保持可选字段为空');

const conditionDraft = StoryVisualUI.conditionAstToDraft(
  require(path.join(root, 'js', 'story-vars.js')).parseCondition('金币>=10 && (已见面 || 名字 contains "客")'), stateMap
);
assert.deepEqual(conditionDraft, {
  mode: 'all', rows: [
    { kind: 'comparison', name: '金币', op: '>=', value: 10 },
    { kind: 'group', mode: 'any', rows: [
      { kind: 'comparison', name: '已见面', op: '==', value: true },
      { kind: 'comparison', name: '名字', op: 'contains', value: '客' }
    ] }
  ]
}, '条件 AST 应转换为可递归编辑的组草稿');
assert.deepEqual(StoryVisualUI.conditionDraftToAst(conditionDraft),
  require(path.join(root, 'js', 'story-vars.js')).parseCondition('金币>=10 && (已见面==true || 名字 contains "客")'),
  '条件草稿应转换回可序列化的 AST');

assert.deepEqual(StoryVisualUI.effectDraftToOps([
  { name: '金币', op: '+', value: '3' }, { name: '已见面', op: '=', value: 'true' }, { name: '名字', op: '=', value: '阿岚' }
], stateMap), {
  ok: true,
  ops: [{ name: '金币', op: '+', val: '3' }, { name: '已见面', op: '=', val: 'true' }, { name: '名字', op: '=', val: '阿岚' }],
  errors: []
}, '变量变化应按顺序转换为选项操作');

const invalidDraft = { text: '', block: '', condition: { mode: 'all', rows: [] }, effects: [{ name: '金币', op: '=', value: '1' }, { name: '金币', op: '+', value: '1' }, { name: '未知', op: '=', value: '1' }, { name: '已见面', op: '+', value: 'true' }], unknownFields: ['样式:红'] };
const invalid = StoryVisualUI.validateOptionDraft(invalidDraft, stateMap, ['开场']);
assert.equal(invalid.ok, false);
['选项文字不能为空', '请选择目标剧情块', '变量「金币」重复', '变量「未知」不存在', '变量「已见面」不能使用此操作', '条件组不能为空', '此选项包含无法识别的高级字段，请在源码模式编辑'].forEach((message) => {
  assert.ok(invalid.errors.includes(message), `应报告：${message}`);
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
