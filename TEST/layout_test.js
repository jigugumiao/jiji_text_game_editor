// 端到端测试：左侧大纲折叠 + 文字工具栏开关（加载真实 index.html + editor.js）
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

// ---- 内存 mock Storage（不依赖 indexedDB，仅支撑 init 链路） ----
const noop = () => Promise.resolve();
window.Storage = {
  migrateLegacyIfNeeded: noop,
  setCurrentProject() {}, createProject: () => 'p1', renameProject: noop, deleteProject: noop,
  listProjects: () => [], getProjectStats: () => ({ models: 0, folders: 0 }),
  loadMeta: () => ({ title: '', creation: {} }),
  loadStoryText: () => '', loadStory: () => [],
  saveStory: noop, saveStoryText: noop, saveMeta: noop,
  getAllAssets: () => Promise.resolve([]),
  saveAsset: noop, importSceneBundle: noop, deleteAsset: noop, renameAsset: noop,
};
window.AI = { loadSettings: () => ({}), saveSettings() {}, buildContext: () => Promise.resolve({}), orchestrate: () => Promise.resolve('') };
window.Exporter = { exportSingleHTML: noop, exportZip: noop, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.Generators = { generateGradient: () => '', generateNoise: () => '' };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// 执行 editor.js（浏览器脚本，挂到 window 作用域）
const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);

(async () => {
  await new Promise(r => setTimeout(r, 80)); // 等 init 的异步链完成（bindGlobal 绑定监听）

  const outlineCol = document.getElementById('outline-col');
  const outlineToggle = document.getElementById('outline-toggle');
  const outlineReopen = document.getElementById('outline-reopen');
  const bbToggle = document.getElementById('btn-bbcode-toggle');
  const bbFloat = document.getElementById('bbcode-float');

  // 初始状态
  assert(!outlineCol.classList.contains('collapsed'), '初始：大纲不应折叠');
  assert(outlineReopen.classList.contains('hidden'), '初始：展开按钮应隐藏');
  assert(!bbToggle.classList.contains('active'), '初始：工具栏开关应非 active（默认关闭）');
  assert(bbFloat.classList.contains('hidden'), '初始：文字工具栏应默认隐藏');

  // 折叠大纲
  click(outlineToggle);
  assert(outlineCol.classList.contains('collapsed'), '点击折叠后：outline-col 应有 collapsed');
  assert(!outlineReopen.classList.contains('hidden'), '点击折叠后：展开按钮应显示');
  assert(localStorage.getItem('storyeditor:outline-collapsed') === '1', '折叠应写入 localStorage=1');

  // 重新展开（走列头展开按钮）
  click(outlineReopen);
  assert(!outlineCol.classList.contains('collapsed'), '点击展开后：collapsed 应移除');
  assert(outlineReopen.classList.contains('hidden'), '点击展开后：展开按钮应隐藏');
  assert(localStorage.getItem('storyeditor:outline-collapsed') === '0', '展开应写入 localStorage=0');

  // 显示文字工具栏（初始默认关闭）
  click(bbToggle);
  assert(!bbFloat.classList.contains('hidden'), '点击开关后：文字工具栏应可见');
  assert(bbToggle.classList.contains('active'), '点击开关后：开关应变 active');
  assert(localStorage.getItem('storyeditor:bbcode-visible') === '1', '显示工具栏应写入 localStorage=1');

  // 再次隐藏
  click(bbToggle);
  assert(bbFloat.classList.contains('hidden'), '再次点击：文字工具栏应隐藏');
  assert(!bbToggle.classList.contains('active'), '再次点击：开关应取消 active');
  assert(localStorage.getItem('storyeditor:bbcode-visible') === '0', '隐藏工具栏应写入 localStorage=0');

  // 持久化恢复：独立第二个 JSDOM 实例（全新 mock），写入 localStorage 后 eval，验证自动恢复
  const dom2 = new JSDOM(HTML, { url: 'https://localhost/', pretendToBeVisual: true });
  const w2 = dom2.window;
  global.window = w2; global.document = w2.document; global.localStorage = w2.localStorage; global.navigator = w2.navigator;
  w2.requestAnimationFrame = (cb) => setTimeout(cb, 0); w2.cancelAnimationFrame = (id) => clearTimeout(id);
  const noop2 = () => Promise.resolve();
  w2.Storage = { migrateLegacyIfNeeded: noop2, setCurrentProject() {}, createProject: () => 'p1', renameProject: noop2, deleteProject: noop2, listProjects: () => [], getProjectStats: () => ({ models: 0, folders: 0 }), loadMeta: () => ({ title: '', creation: {} }), loadStoryText: () => '', loadStory: () => [], saveStory: noop2, saveStoryText: noop2, saveMeta: noop2, getAllAssets: () => Promise.resolve([]), saveAsset: noop2, importSceneBundle: noop2, deleteAsset: noop2, renameAsset: noop2 };
  w2.AI = { loadSettings: () => ({}), saveSettings() {}, buildContext: () => Promise.resolve({}), orchestrate: () => Promise.resolve('') };
  w2.Exporter = { exportSingleHTML: noop2, exportZip: noop2, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
  w2.Generators = { generateGradient: () => '', generateNoise: () => '' };
  w2.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
  w2.Zip = {};
  w2.localStorage.setItem('storyeditor:outline-collapsed', '1');
  w2.localStorage.setItem('storyeditor:bbcode-visible', '0');
  try { w2.eval(src); } catch (e) { console.log('  [debug] dom2 eval error:', e.message); }
  // 若 init 因 readyState 推迟到 DOMContentLoaded，手动触发一次
  try { w2.document.dispatchEvent(new w2.Event('DOMContentLoaded')); } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
  const restoredCollapsed = w2.document.getElementById('outline-col').classList.contains('collapsed');
  const restoredHidden = w2.document.getElementById('bbcode-float').classList.contains('hidden');
  assert(restoredCollapsed, '恢复：大纲应默认折叠（读 localStorage）');
  assert(restoredHidden, '恢复：文字工具栏应默认隐藏（读 localStorage）');

  console.log('\n==== 布局开关测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log(fail === 0 ? '全部 PASS ✅' : '有失败 ❌');
  if (fail) process.exit(1);
})();
