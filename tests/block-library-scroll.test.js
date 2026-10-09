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
let promptAnswer = null;
const sandbox = {
  document: { createElement: element }, libPanel: element(),
  MAIN_BLOCK: '主剧情',
  activeLib: 'dialogueblock', _lastRenderedLib: 'dialogueblock', libFilter: '结局',
  activeBlock: 'first', storyText: { value: '第一块未保存修改' },
  visualController: null, saveTimer: null, histTimer: null, clearTimeout,
  prompt: () => promptAnswer,
  alert: (m) => { throw new Error('不应弹 alert：' + m); },
  toast: () => {},
  commitEdit: () => {},
  window: { Storage: {
    setBlockText: (name, text) => { blocks[name] = text; },
    getBlockText: name => blocks[name],
    renameBlock: (oldName, newName) => { blocks[newName] = blocks[oldName]; delete blocks[oldName]; return newName; },
  } },
};
for (const name of ['renderLibList', 'applyLibFilter', 'updateWordCount', 'refreshClueHint',
  'pushHistory', 'updateBlockChip', 'updateUndoButtons', 'refreshTodo',
  'refreshBlockReviewLine', 'renderReviewPanel', 'refreshReviewToggleBadge']) {
  sandbox[name] = () => {};
}
vm.createContext(sandbox);
vm.runInContext(extract('  function renderLibrary(', '  // 渲染当前库的工具条')
  + extract('  function switchBlock(', '  // 在光标处插入「进入剧情块」')
  + extract('  async function handleRenameBlock(', '  async function handleDeleteBlock('), sandbox);

(async () => {
  sandbox.renderLibrary();
  sandbox.libPanel.querySelector('.lib-scroll').scrollTop = 720;
  sandbox.switchBlock('second');
  assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 720,
    '切换剧情块必须保留滚动位置');
  assert.equal(sandbox.libFilter, '结局', '切块保留筛选');
  assert.equal(blocks.first, '第一块未保存修改', '切块仍保存之前正文');
  assert.equal(sandbox.storyText.value, '第二块正文');
  sandbox.switchBlock('second');
  assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 720,
    '重复点击当前剧情块也不能跳回顶部');
  // 统一修复核心断言：同库普通重渲（重命名/删除/保存/刷新等全部操作）不销毁滚动容器
  sandbox.renderLibrary();
  assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 720,
    '同库普通重渲必须保留滚动位置（统一修复核心断言）');
  sandbox.renderLibrary({ resetScroll: true });
  assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 0,
    '显式 resetScroll（换项目）应从顶部开始');
  // 用户实际报告的 bug 场景：重命名剧情块
  sandbox.libPanel.querySelector('.lib-scroll').scrollTop = 640;
  promptAnswer = 'second改';
  await sandbox.handleRenameBlock('second');
  assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 640,
    '重命名剧情块后滚动位置必须保留（用户报告的 bug）');
  assert.equal(sandbox.activeBlock, 'second改', '重命名后 activeBlock 同步');
  assert.ok(!('second' in blocks) && ('second改' in blocks), '存储中块已改名');
  // 换库：整体重建 + 清空筛选
  sandbox.libPanel.querySelector('.lib-scroll').scrollTop = 720;
  sandbox.activeLib = 'background';
  sandbox.renderLibrary();
  assert.equal(sandbox.libPanel.querySelector('.lib-scroll').scrollTop, 0,
    '切换素材库不继承剧情块库位置');
  assert.equal(sandbox.libFilter, '');
  console.log('block library scroll tests passed');
})().catch(e => { console.error(e); process.exit(1); });
