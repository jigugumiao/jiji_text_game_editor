const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = { window: {}, document: { getElementById: () => null, activeElement: null } };
vm.createContext(sandbox);
for (const name of ['story-vars', 'story-options', 'story-visual-doc', 'story-visual-ui']) {
  let code = fs.readFileSync(path.join(__dirname, '../js/' + name + '.js'), 'utf8');
  // Only substitute rendering, retaining the actual controller and document parser.
  if (name === 'story-visual-ui') {
    code = code.replace('function renderDocument(host, doc, onDiagnostic, options) {', 'function renderDocument(host, doc, onDiagnostic, options) { window.renderOptions = options; return doc;');
    code = code.replace('function renderOptionEditor(host, node, initialDraft, context, viewState) {', 'function renderOptionEditor(host, node, initialDraft, context, viewState) { window.optionContext = context; return;');
  }
  vm.runInContext(code, sandbox);
}
const w = sandbox.window;
let source = '结局正文\n<选项:"再来一次",__MAIN__>', key = 'project:结局', writes = 0;
const ending = source, main = '主剧情原文\n<停顿>\n不可覆盖';
const controller = w.StoryVisualUI.createController({ sourceTextarea: { selectionStart: 0 }, sourceWrap: {}, visualHost: { contains: () => true }, getSource: () => source, getDocumentKey: () => key, setSource: next => { writes++; source = next; }, getStates: () => ({}), getBlocks: () => ['__MAIN__', '结局'] });
function edit() {
  controller.refresh();
  const node = w.StoryVisualDoc.scan(source).nodes.find(n => n.kind === 'option_group');
  w.renderOptions.onEditOption(node);
  return w.optionContext;
}
controller.showVisual();
const oldForm = edit();
controller.resetContext(); key = 'project:__MAIN__'; source = main; controller.refresh();
assert.equal(oldForm.commit('<选项:"重玩",__MAIN__>').ok, false);
oldForm.restore(); assert.equal(source, main); assert.equal(writes, 0);
// A switched block with identical content must still reject the old callback.
key = 'project:结局'; source = ending;
const identicalForm = edit(); key = 'other-project:结局';
assert.equal(identicalForm.commit('<选项:"重玩",__MAIN__>').ok, false);
assert.equal(source, ending); assert.equal(writes, 0);
controller.refresh();
const changedForm = edit(); source += '\n刚新增的内容';
assert.equal(changedForm.commit('<选项:"重玩",__MAIN__>').ok, false);
changedForm.restore(); assert.ok(source.endsWith('刚新增的内容')); assert.equal(writes, 0);
controller.resetContext(); source = ending;
const validForm = edit();
assert.equal(validForm.commit('<选项:"重玩",__MAIN__>').ok, true);
assert.equal(source, '结局正文\n<选项:"重玩",__MAIN__>');
assert.equal(writes, 1, '合法的二周目选项可以局部保存');
const textCallback = w.renderOptions.commitTextNode;
const textNode = w.StoryVisualDoc.scan(source).nodes.find(n => n.kind === 'text');
sandbox.document.activeElement = {
  nodeType: 1, tagName: 'DIV', childNodes: [{ nodeType: 3, nodeValue: '正在输入的结局' }],
  closest: () => ({ dataset: { start: String(textNode.start), end: String(textNode.end) } }),
  matches: selector => selector.includes('contenteditable'),
  blur: () => { throw new Error('后台备份不能使用户失焦'); }
};
assert.equal(controller.getSnapshotSource(), '正在输入的结局\n<选项:"重玩",__MAIN__>');
assert.equal(source, '结局正文\n<选项:"重玩",__MAIN__>');
assert.equal(writes, 1, '后台读取草稿不修改编辑器或存储');
key = 'other-project:__MAIN__';
assert.equal(controller.getSnapshotSource(), source, '旧剧情块的焦点不能进入新项目快照');
textCallback(textNode, '结局不能迟到覆盖其他项目'); assert.equal(writes, 1);
const editor = fs.readFileSync(path.join(__dirname, '../js/editor.js'), 'utf8');
assert.doesNotMatch(editor, /不建议选项跳到主剧情块/);
console.log('visual block isolation tests passed');
