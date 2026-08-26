const assert = require('node:assert/strict');
const VisualDoc = require('../js/story-visual-doc.js');

// Exact bytes, including line endings and otherwise unsupported source, remain
// the document authority until an explicitly selected span is replaced.
{
  const source = '正文\r\n\r\n<召唤背景:村口>\r\n<选项:"A",块A><选项:"B",块B>\r\n<变量:金币+1>\r\n坏行 <选项:"未闭合\r\n';
  const doc = VisualDoc.scan(source);
  assert.equal(doc.source, source);
  assert.equal(VisualDoc.serializeUnchanged(doc), source);
  assert.ok(doc.nodes.some(n => n.kind === 'option_group'));
  assert.ok(doc.nodes.some(n => n.kind === 'state_change'));
  assert.ok(doc.nodes.some(n => n.kind === 'source_error'));

  const optionNode = doc.nodes.find(n => n.kind === 'option_group');
  const patched = VisualDoc.replaceNode(source, optionNode, '<选项:"改名",块A>');
  assert.equal(patched.slice(0, optionNode.start), source.slice(0, optionNode.start));
  assert.equal(patched.slice(optionNode.start + '<选项:"改名",块A>'.length), source.slice(optionNode.end));
}

// StoryOptions owns quote/comma/parenthesis parsing. The scanner retains the
// exact individual option spans, so changing one option cannot disturb peers.
{
  const source = '<选项:"买,钥匙",商店,条件:(金币>=10, 声望>2),样式:红><选项:"B",块B>\n';
  const doc = VisualDoc.scan(source);
  const options = doc.nodes.filter(n => n.kind === 'option_group');
  assert.equal(options.length, 2);
  assert.equal(options[0].raw, '<选项:"买,钥匙",商店,条件:(金币>=10, 声望>2),样式:红>');
  assert.deepEqual(options[0].data.option.unknownFields, ['样式:红']);
  assert.equal(VisualDoc.replaceNode(source, options[1], '<选项:"C",块C>'),
    '<选项:"买,钥匙",商店,条件:(金币>=10, 声望>2),样式:红><选项:"C",块C>\n');
}

// Only standalone state directives are elevated; ordinary prose and raw
// commands are separately addressable without changing their source bytes.
{
  const source = '你好 {金币}\n<变量:金币+1><变量:钥匙=true>\n<玩家输入变量:姓名,"请输入,姓名">\n<播放音乐:主题曲>\n';
  const doc = VisualDoc.scan(source);
  const state = doc.nodes.filter(n => n.kind === 'state_change');
  assert.equal(state.length, 2);
  assert.deepEqual(state[0].data.effects, [
    { name: '金币', op: '+', val: '1' }, { name: '钥匙', op: '=', val: 'true' }
  ]);
  assert.deepEqual(state[1].data.playerInput, { name: '姓名', prompt: '请输入,姓名' });
  assert.ok(doc.nodes.some(n => n.kind === 'raw_command' && n.raw === '<播放音乐:主题曲>'));
  assert.equal(VisualDoc.findNodeAtOffset(doc, source.indexOf('播放音乐')).kind, 'raw_command');
  assert.equal(VisualDoc.summarizeDiagnostics(doc).length, 0);
}

{
  const source = '<选项:"未闭合\n';
  const doc = VisualDoc.scan(source);
  assert.equal(doc.nodes[0].kind, 'source_error');
  assert.equal(doc.nodes[0].raw, '<选项:"未闭合');
  assert.equal(VisualDoc.summarizeDiagnostics(doc).length, 1);
  assert.throws(() => VisualDoc.replaceNode(source, { start: 0, end: 1, raw: '错' }, 'x'), /does not match/);
}

// Deleting the final state effect must delete its entire standalone directive
// line, rather than leaving an empty line or a bare variable tag behind.
{
  const source = '开始\r\n<变量:金币-10>\r\n结尾';
  const doc = VisualDoc.scan(source);
  const state = doc.nodes.find(n => n.kind === 'state_change');
  assert.equal(VisualDoc.removeNode(source, state), '开始\r\n结尾');
}

console.log('story-visual-doc.test.js passed');
