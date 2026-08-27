const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const docs = fs.readFileSync(path.join(root, 'docs.html'), 'utf8');
const visualUiSource = fs.readFileSync(path.join(root, 'js', 'story-visual-ui.js'), 'utf8');
const editorSource = fs.readFileSync(path.join(root, 'js', 'editor.js'), 'utf8');
const storageSource = fs.readFileSync(path.join(root, 'js', 'storage.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');

assert.match(html, /<button id="editor-mode-visual" type="button">可视化编辑<\/button>/,
  '编辑器必须提供可视化编辑模式切换');
assert.match(html, /<button id="editor-mode-source" type="button">源码模式<\/button>/,
  '编辑器必须提供源码模式切换');
assert.match(html, /<div id="story-visual-editor" class="story-visual-editor" hidden><\/div>/,
  '编辑器必须提供独立的可视化编辑器宿主');
assert.match(html, /id="project-convert-modal"/, '旧项目转换必须使用共用转换弹窗');
assert.match(html, /js\/project-converter\.js/, '转换器必须在编辑器前加载');

['五分钟快速入门', '金币与商店', '好感度与分支', '钥匙状态', '玩家姓名', '多条件路线', '高级源码参考', '旧项目转换'].forEach((heading) => {
  assert.match(docs, new RegExp('<h3[^>]*>[^<]*' + heading), `文档必须提供「${heading}」章节`);
});
assert.match(docs, /10 金币买钥匙/, '文档首个剧情状态示例必须展示 10 金币买钥匙');
assert.doesNotMatch(docs.match(/<h3 id="adv-var"[\s\S]*?<h3 id="adv-clue"/)[0].slice(0, 500), /\{\}|&&/, '剧情状态章节开头不得以源码符号引导');
assert.match(visualUiSource, /story-visual-context-tip/, '可视化编辑器必须渲染非阻塞上下文提示');
assert.match(visualUiSource, /first-option/, '首次编辑选项必须触发提示');
assert.match(visualUiSource, /first-condition/, '首次添加条件必须触发提示');
assert.match(visualUiSource, /first-effect/, '首次添加效果必须触发提示');
assert.match(editorSource, /getUiPreference/, '提示已读状态必须通过命名空间 UI 偏好读取');
assert.match(editorSource, /setUiPreference/, '提示已读状态必须通过命名空间 UI 偏好保存');
assert.match(storageSource, /if \(m === 'game'\) project\.visualEditorVersion = 1;/,
  '新建剧情游戏必须默认标记为可视化项目，不能进入旧项目转换流程');
assert.match(styleSource, /\.editor-text-wrap\[hidden\], \.story-visual-editor\[hidden\] \{ display: none !important; \}/,
  '模式切换时被 hidden 的源码区或可视化区必须彻底隐藏，不能形成上下分栏');

const StoryVisualUI = require(path.join(root, 'js', 'story-visual-ui.js'));
['createController', 'renderDocument', 'describeNode', 'sourceFromTextEditor', 'commitFocusedEditor', 'destroy'].forEach((name) => {
  assert.equal(typeof StoryVisualUI[name], 'function', `StoryVisualUI 必须导出 ${name}`);
});

const text = (value) => ({ nodeType: 3, nodeValue: value });
const element = (tagName, children, source) => ({ nodeType: 1, tagName, childNodes: children || [], dataset: source == null ? {} : { source } });
assert.equal(StoryVisualUI.sourceFromTextEditor(element('DIV', [text('第一行'), element('DIV', [text('第二行')]), element('BR'), text('第三行')])), '第一行\n第二行\n第三行',
  '可视化正文按 Enter 生成的 block/BR 必须回写为换行，不能吞掉内容');

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
