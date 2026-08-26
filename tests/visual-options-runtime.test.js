const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const StoryOptions = require('../js/story-options.js');

const root = path.join(__dirname, '..');
const exporterSrc = fs.readFileSync(path.join(root, 'js', 'exporter.js'), 'utf8');
const editorSrc = fs.readFileSync(path.join(root, 'js', 'editor.js'), 'utf8');

// Both consumers must delegate extraction and serialization to the one grammar.
for (const [name, src] of [['editor.js', editorSrc], ['exporter.js', exporterSrc]]) {
  assert.doesNotMatch(src, /function extractOptionLine\(line\)/, name + ' must not keep an option extractor');
  assert.doesNotMatch(src, /function splitOptionExtra\(extra\)/, name + ' must not keep option field splitting');
  assert.match(src, /StoryOptions\.extractOptionLine/, name + ' must use StoryOptions extraction');
}
assert.match(editorSrc, /StoryOptions\.serializeOption/, 'editor round-trips option nodes through the shared serializer');

// Export parsing must retain all visual fields, including quoted commas and unknown fields.
const parseMatch = exporterSrc.match(/function parseStoryForExport\(src\) \{[\s\S]*?\n\}/);
assert.ok(parseMatch, 'parseStoryForExport is present');
const context = { window: { StoryOptions, StoryVars: require('../js/story-vars.js') } };
vm.createContext(context);
vm.runInContext(parseMatch[0] + '\nthis.parseStoryForExport = parseStoryForExport;', context);
const story = context.parseStoryForExport('<选项:"她说\\"好,走吧\\"",目标,条件:(金币>=10),不满足:禁用,提示:"还差,一点",变化:金币-10,样式:红>');
assert.deepEqual(JSON.parse(JSON.stringify(story[0].options[0])), {
  text: '她说"好,走吧"', block: '目标', condition: '(金币>=10)', unmetBehavior: 'disable',
  unmetMessage: '还差,一点', effects: [{ name: '金币', op: '-', val: '10' }], unknownFields: ['样式:红']
});

// Runtime behavior: unmet options hide by default, disable only when asked, and effects
// are gated by a valid target then applied once on the normal click path (never replayed).
assert.match(exporterSrc, /if \(unmet && opt\.unmetBehavior !== 'disable'\) return;/, 'unmet options default to hidden');
assert.match(exporterSrc, /btn\.classList\.add\('is-disabled'\)/, 'disabled unmet options receive a disabled state');
assert.match(exporterSrc, /btn\.disabled = true/, 'disabled unmet options cannot be clicked');
assert.match(exporterSrc, /if \(opt\.effects && opt\.effects\.length && \(!opt\.block \|\| nodesOf\(opt\.block\)\.length\)\)/, 'effects run only after target validation');
assert.match(exporterSrc, /applyVarOps\(opt\.effects\);/, 'selected option effects are applied');
assert.doesNotMatch(exporterSrc.match(/function fastReplay\([\s\S]*?\n  \}/)[0], /applyVarOps\(opt\.effects\)/, 'replay does not apply option effects a second time');

console.log('visual-options-runtime.test.js passed');
