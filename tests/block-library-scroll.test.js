const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/editor.js'), 'utf8');
function extract(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function element() {
  return {
    children: [], scrollTop: 0,
    set innerHTML(value) { this.children = []; },
    appendChild(child) { this.children.push(child); },
    querySelector(selector) {
      return this.children.find(child => '.' + child.className === selector) || null;
    },
    setAttribute() {}, addEventListener() {},
  };
}
const blocks = { first: '第一块正文', second: '第二块正文' };
const sandbox = {
  document: { createElement: element }, libPanel: element(),
  activeLib: 'dialogueblock', _lastRenderedLib: 'dialogueblock', libFilter: '结局',
  activeBlock: 'first', storyText: { value: '第一块未保存修改' },
  visualController: null, saveTimer: null, histTimer: null, clearTimeout,
  window: { Storage: {
    setBlockText: (name, text) => { blocks[name] = text; },
    getBlockText: name => blocks[name],
  } },
};
for (const name of ['renderLibList', 'applyLibFilter', 'updateWordCount', 'refreshClueHint',
  'pushHistory', 'updateBlockChip', 'updateUndoButtons', 'refreshTodo',
  'refreshBlockReviewLine', 'renderReviewPanel', 'refreshReviewToggleBadge']) {
  sandbox[name] = () => {};
}
vm.createContext(sandbox);
vm.runInContext(extract('  function renderLibrary(', '  // 渲染当前库的工具条')
  + extract('  function switchBlock(', '  // 在光标处插入「进入剧情块」'), sandbox);
sandbox.renderLibrary();
sandbox.libPanel.querySelector('.lib-scroll').scrollTop = 720;
sandbox.switchBlock('second');
assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 720,
  '切换剧情块必须恢复新滚动容器的位置');
assert.equal(sandbox.libFilter, '结局', '切块保留筛选');
assert.equal(blocks.first, '第一块未保存修改', '切块仍保存之前正文');
assert.equal(sandbox.storyText.value, '第二块正文');
sandbox.switchBlock('second');
assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 720,
  '重复点击当前剧情块也不能跳回顶部');
sandbox.renderLibrary();
assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 0,
  '普通重绘（包括项目切换）不继承之前项目的位置');
sandbox.libPanel.querySelector('.lib-scroll').scrollTop = 720;
sandbox.activeLib = 'background';
sandbox.renderLibrary({ preserveScroll: true });
assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 0,
  '切换素材库不继承剧情块库位置');
assert.equal(sandbox.libFilter, '');
console.log('block library scroll tests passed');
