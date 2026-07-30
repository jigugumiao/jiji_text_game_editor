// 回归测试：颜色/阴影/发光 工具的「套用」必须正确写入标签、关闭弹层，
// 且绝不能调用 window.close()（旧 bug：用了未定义的 close()，浏览器里解析为 window.close 直接关掉标签页）
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
window.Zip = {};

// 真实 BBCode，让 wrapSelection 真正写标签
const bbSrc = fs.readFileSync(path.join(__dirname, '..', 'js/bbcode.js'), 'utf8');
window.eval(bbSrc);

let closeCalls = 0;
const origClose = window.close ? window.close.bind(window) : null;
window.close = function () { closeCalls++; if (origClose) origClose(); };

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const click = (el) => { if (!el) { fail++; console.error('  ✗ click target null'); return; } try { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); } catch (e) { fail++; console.error('  ✗ click threw: ' + e.message); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);

(async () => {
  await new Promise(r => setTimeout(r, 120));
  const ta = document.getElementById('story-text');
  const pop = document.getElementById('color-pop');

  async function applyEffect(label, openBtn, expectTag) {
    ta.value = '主角站在悬崖边，风很大。';
    ta.setSelectionRange(0, ta.value.length);
    if (!pop.classList.contains('hidden')) click(document.getElementById('color-pop-cancel'));
    const before = closeCalls;
    click(openBtn);
    await new Promise(r => setTimeout(r, 10));
    click(document.getElementById('color-pop-ok'));
    await new Promise(r => setTimeout(r, 10));
    assert(ta.value.includes('[' + expectTag + '='), '[' + label + '] 应写入 [' + expectTag + '=...] 标签');
    assert(pop.classList.contains('hidden'), '[' + label + '] 套用后弹层应关闭');
    assert(closeCalls === before, '[' + label + '] 套用绝不可调用 window.close()（否则会关掉标签页）');
  }

  await applyEffect('发光', document.querySelector('[data-tag="glow"]'), 'glow');
  await applyEffect('阴影', document.querySelector('[data-tag="shadow"]'), 'shadow');
  await applyEffect('颜色', document.getElementById('bb-color-btn'), 'color');

  // 点色板色块直接套用（不经「套用」按钮）同样不能关页面
  ta.value = '夜色深沉。';
  ta.setSelectionRange(0, ta.value.length);
  const before = closeCalls;
  click(document.getElementById('bb-color-btn'));
  await new Promise(r => setTimeout(r, 10));
  const sw = document.querySelector('#common-colors .cc-swatch');
  click(sw);
  await new Promise(r => setTimeout(r, 10));
  assert(ta.value.includes('[color='), '点色板色块应直接写入 [color=...]');
  assert(closeCalls === before, '点色板色块套用绝不可调用 window.close()');

  console.log('\n==== 选色弹层套用回归测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log(fail === 0 ? '全部 PASS ✅' : '有失败 ❌');
  if (fail) process.exit(1);
})();
