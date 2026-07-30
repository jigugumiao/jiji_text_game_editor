// 端到端测试：分割线功能（解析 / 预览渲染 / 工具栏插入 / 序列化往返）
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(HTML, { url: 'https://localhost/', pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.navigator = window.navigator;
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
global.requestAnimationFrame = window.requestAnimationFrame;
global.cancelAnimationFrame = window.cancelAnimationFrame;
global.Audio = window.Audio;

const noop = () => Promise.resolve();
window.Storage = {
  migrateLegacyIfNeeded: noop, setCurrentProject() {}, createProject: () => 'p1', renameProject: noop, deleteProject: noop,
  listProjects: () => [], getProjectStats: () => ({ models: 0, folders: 0 }),
  loadMeta: () => ({ title: '', creation: {} }),
  loadStoryText: () => '', loadStory: () => [],
  saveStory: noop, saveStoryText: noop, saveMeta: noop,
  getAllAssets: () => Promise.resolve([]),
  saveAsset: noop, importSceneBundle: noop, deleteAsset: noop, renameAsset: noop,
  // 对话块系统方法：block 系统落地后 editor.js 会调用，测试桩补齐
  MAIN_BLOCK: '__MAIN__', loadBlocks: () => ({ main: '', blocks: {} }), saveBlocks: noop,
  getBlockText: () => '', setBlockText: noop, addBlock: () => '新对话',
  renameBlock: () => false, deleteBlock: () => false, listBlockNames: () => ['__MAIN__'], hasBlocksData: () => false,
};
window.AI = { loadSettings: () => ({}), saveSettings() {}, buildContext: () => Promise.resolve({}), orchestrate: () => Promise.resolve('') };
window.Exporter = { exportSingleHTML: noop, exportZip: noop, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.Generators = { generateGradient: () => '', generateNoise: () => '' };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);

(async () => {
  await new Promise(r => setTimeout(r, 80));
  const api = window.StoryEditorApi;
  const ta = document.getElementById('story-text');

  // ---- 1. 解析：带备注 / 空备注 / 无冒号 三种写法 ----
  const nodes = api.parseStory('前文\n<分割线:第三章>\n<分割线:>\n<分割线>\n后文');
  const divs = nodes.filter(n => n.type === 'divider');
  assert(divs.length === 3, '应解析出 3 个 divider 节点');
  assert(divs[0].text === '第三章', '带备注 divider.text 应为「第三章」');
  assert(divs[1].text === '', '空备注 <分割线:> 的 text 应为空');
  assert(divs[2].text === '', '无冒号 <分割线> 的 text 应为空');

  // ---- 2. 序列化往返 ----
  const ser = api.storyToText(nodes);
  assert(ser.includes('<分割线:第三章>'), '序列化应含 <分割线:第三章>');
  assert(ser.includes('<分割线:>'), '序列化应含空备注 <分割线:>');
  const reparsed = api.parseStory(ser).filter(n => n.type === 'divider');
  assert(reparsed.length === 3 && reparsed[0].text === '第三章', '序列化后再解析应保持备注文字');

  // ---- 3. 预览渲染：带备注显示居中文字，空备注显示横线 ----
  ta.value = '一段剧情\n<分割线:第三章>\n<分割线:>\n另一段';
  click(document.getElementById('btn-bbcode-preview')); // 进入预览
  const pv = document.getElementById('story-preview');
  const divEls = pv.querySelectorAll('.pv-divider');
  assert(divEls.length === 2, '预览应渲染 2 个 .pv-divider');
  const txtEl = pv.querySelector('.pv-divider .pv-divider-text');
  assert(txtEl && txtEl.textContent.includes('第三章'), '带备注预览应显示居中文字「第三章」');
  const lineEl = pv.querySelector('.pv-divider .pv-divider-line');
  assert(!!lineEl, '空备注预览应渲染 .pv-divider-line');
  click(document.getElementById('btn-bbcode-preview')); // 切回编辑

  // ---- 4. 工具栏按钮：无选区插入 <分割线:>，光标停在冒号后 ----
  ta.value = '第一行\n第二行';
  ta.setSelectionRange(ta.value.length, ta.value.length);
  click(document.getElementById('bb-divider-btn'));
  assert(ta.value.includes('<分割线:>'), '点击分割线按钮应插入 <分割线:>');
  const pos = ta.selectionStart;
  assert(ta.value[pos - 1] === ':' && ta.value[pos] === '>', '光标应停在冒号后、> 之前');

  // ---- 5. 工具栏按钮：有选区时把选区作为备注包裹 ----
  ta.value = 'abc';
  ta.setSelectionRange(0, 3);
  click(document.getElementById('bb-divider-btn'));
  assert(ta.value.includes('<分割线:abc>'), '有选区时应把选区作为备注包裹');

  // ---- 6. 文字工具栏的停顿按钮：点击插入整行 <停顿> ----
  ta.value = '第一段\n第二段';
  ta.setSelectionRange(3, 3); // 光标停在「第一段」行尾（前后均有文字）
  click(document.getElementById('bb-pause-btn'));
  assert(ta.value.includes('\n<停顿>\n'), '点击工具栏停顿按钮应在光标处插入整行 <停顿>');

  console.log('\n==== 分割线功能测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log(fail === 0 ? '全部 PASS ✅' : '有失败 ❌');
  if (fail) process.exit(1);
})();
