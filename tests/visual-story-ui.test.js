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
['createController', 'renderDocument', 'commitFocusedEditor', 'destroy'].forEach((name) => {
  assert.equal(typeof StoryVisualUI[name], 'function', `StoryVisualUI 必须导出 ${name}`);
});

console.log('visual-story-ui.test.js passed');
