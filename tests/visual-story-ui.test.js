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
assert.match(editorSource, /document\.querySelectorAll\('\.project-conversion-hint'\)\.forEach/,
  '切换到转换后的项目时必须清理旧项目遗留的转换提示');
assert.match(storageSource, /if \(m === 'game'\) project\.visualEditorVersion = 1;/,
  '新建剧情游戏必须默认标记为可视化项目，不能进入旧项目转换流程');
assert.match(styleSource, /\.editor-text-wrap\[hidden\], \.story-visual-editor\[hidden\] \{ display: none !important; \}/,
  '模式切换时被 hidden 的源码区或可视化区必须彻底隐藏，不能形成上下分栏');

[
  ['story-visual-state-token-read', 'read'],
  ['story-visual-node-state_change', 'write'],
  ['story-visual-node-option_group', 'option'],
  ['story-visual-chip-background', 'background'],
  ['story-visual-chip-item', 'item'],
  ['story-visual-chip-music', 'music'],
  ['story-visual-chip-sound', 'sound'],
  ['story-visual-chip-flow', 'flow']
].forEach(([selector, token]) => {
  assert.match(styleSource, new RegExp('\\.' + selector + '[\\s\\S]*?var\\(--visual-chip-' + token + '-fg\\)'),
    selector + ' 必须使用对应的低饱和 chip 前景 token');
});
assert.match(styleSource, /body\.dark\s*\{[\s\S]*?--visual-chip-read-bg:[^;]+;[\s\S]*?--visual-chip-flow-border:/,
  '暗色主题必须覆盖 visual chip token，保持亮暗主题清晰');
assert.match(styleSource, /\.story-visual-chip\s*\{[\s\S]*?box-shadow:\s*none;/,
  '命令 chip 不得使用阴影卡片感');
assert.match(visualUiSource, /token\.className = 'story-visual-state-token story-visual-state-token-read';/,
  '正文状态插值必须标记为 read chip');
assert.match(visualUiSource, /story-visual-chip story-visual-chip-' \+ descriptor\.category/,
  '指令 chip 必须保留分类 class 以应用语义色彩');

const StoryVisualUI = require(path.join(root, 'js', 'story-visual-ui.js'));
['createController', 'renderDocument', 'describeNode', 'splitEditableText', 'sourceFromTextEditor', 'serializeCommandEdit', 'commitFocusedEditor', 'destroy'].forEach((name) => {
  assert.equal(typeof StoryVisualUI[name], 'function', `StoryVisualUI 必须导出 ${name}`);
});
assert.equal(StoryVisualUI.serializeCommandEdit({ raw: '<标题:旧标题>', data: { name: '标题', value: '旧标题' } }, '新标题'), '<标题:新标题>',
  '点击指令 chip 后编辑内容必须只替换指令值');
assert.equal(StoryVisualUI.serializeCommandEdit({ raw: '<停顿>', data: { name: '停顿', value: '' } }, ''), '<停顿>',
  '留空的无参指令必须保持无冒号的简洁语法');

assert.deepEqual(StoryVisualUI.splitEditableText('\r\n\r\n这就是你踏上旅程的地方。\r\n深吸一口气，迈出了第一步。\r\n\r\n'), {
  leading: '\r\n\r\n', body: '这就是你踏上旅程的地方。\r\n深吸一口气，迈出了第一步。', trailing: '\r\n\r\n'
}, '连续正文应作为一个编辑段，段首和段尾换行必须留在框外并原样保留');
assert.deepEqual(StoryVisualUI.splitEditableText('\n\n'), { leading: '\n\n', body: '', trailing: '' },
  '只有换行的空白节点不应生成可编辑文本框');

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
  StoryVisualUI.describeNode({ kind: 'command_chip', data: { category: 'music', summary: '召唤音乐：雨' } }, {}),
  { kind: 'command_chip', category: 'music', summary: '召唤音乐：雨', editable: true },
  '可识别指令应成为带分类的可编辑芯片'
);
assert.equal(typeof StoryVisualUI.insertAtVisualSelection, 'function', '可视化编辑器必须导出插入边界函数');
assert.equal(StoryVisualUI.insertAtVisualSelection('甲乙', 1, '丙'), '甲丙乙', '插入应保留选中位置两侧源码');
assert.equal(StoryVisualUI.insertAtVisualSelection('甲乙', -1, '丙'), '丙甲乙', '插入位置不得越过源码开头');
assert.equal(StoryVisualUI.insertAtVisualSelection('甲乙', 99, '丙'), '甲乙丙', '插入位置不得越过源码结尾');
assert.match(html, /id="visual-insert-menu"/, '可视化模式必须有插入菜单');
assert.doesNotMatch(html, /id="btn-split"/, '工具栏不应再提供分屏按钮');
assert.doesNotMatch(editorSource, /splitMode/, '编辑器不应保留分屏状态分支');
assert.match(editorSource, /function insertVisualOrSource\(text\)/, '编辑器必须提供视觉/源码统一插入入口');
assert.match(editorSource, /visualController\.insert\(text\)/, '视觉模式插入必须委托给可视化控制器');
assert.match(editorSource, /insertVisualOrSource\('<清除叠层>'\)/, '叠层库功能卡必须走统一插入入口');
assert.match(editorSource, /insertVisualOrSource\('<停止音乐>'\)/, '音乐库功能卡必须走统一插入入口');
assert.match(editorSource, /insertVisualOrSource\(ph\)/, '状态库插入正文必须走统一插入入口');
assert.match(editorSource, /function updatePreviewLayout\(\)[\s\S]*?editorTextWrap\.hidden = previewMode[\s\S]*?storyVisualEditor\.hidden = previewMode[\s\S]*?storyPreview\.hidden = !previewMode/, '预览必须独占编辑器主体并隐藏两种编辑器');
assert.match(editorSource, /storyPreview\.classList\.toggle\('hidden', !previewMode\)/, '预览切换必须同步移除初始 hidden class，避免预览内容空白');
assert.match(visualUiSource, /moveBetweenEditableParagraphs\(element, -1\)/, '正文输入框顶端按上键必须能移至上一段');
assert.match(visualUiSource, /moveBetweenEditableParagraphs\(element, 1\)/, '正文输入框底端按下键必须能移至下一段');
assert.match(visualUiSource, /story-visual-command-input/, '点击指令 chip 必须进入直接编辑状态');
['剧情状态', '选项', '背景', '物品', '音乐', '音效', '标题', '停顿', '分割线', '剧情块', '跳回', '随机跳转'].forEach((label) => {
  assert.match(editorSource, new RegExp("label: '" + label), '视觉插入菜单必须提供「' + label + '」');
});

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
