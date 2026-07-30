// 拖拽上传智能归类测试：图片→背景库；场景包(GLB/.json)→物品库；音频按时长归入音效/音乐/询问
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
global.FileReader = window.FileReader;
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);

// 可控的内存素材库 + 记录 importSceneBundle 调用
const libStore = { background: {}, item: {}, music: {}, sound: {} };
let importCalls = [];
const noop = () => Promise.resolve();
window.Storage = {
  LIBS: ['background', 'item', 'music', 'sound'],
  migrateLegacyIfNeeded: noop,
  setCurrentProject() {}, createProject: () => 'p1', renameProject: noop, deleteProject: noop,
  listProjects: () => [], getProjectStats: () => ({ models: 0, folders: 0 }),
  loadMeta: () => ({ creation: {} }), loadStoryText: () => '', loadStory: () => [],
  saveStory: noop, saveStoryText: noop, saveMeta: noop,
  getAllAssets: (kind) => Promise.resolve(Object.values(libStore[kind] || {})),
  saveAsset: (kind, asset) => { (libStore[kind] = libStore[kind] || {}); libStore[kind][asset.name] = asset; return Promise.resolve(asset.id || 'id'); },
  importSceneBundle: (json) => { importCalls.push(json); return Promise.resolve([{ id: 'm1', name: 'x' }]); },
  deleteAsset: noop, renameAsset: noop,
  // 对话块系统方法：block 系统落地后 editor.js 会调用，测试桩补齐
  MAIN_BLOCK: '__MAIN__', loadBlocks: () => ({ main: '', blocks: {} }), saveBlocks: noop,
  getBlockText: () => '', setBlockText: noop, addBlock: () => '新对话',
  renameBlock: () => false, deleteBlock: () => false, listBlockNames: () => ['__MAIN__'], hasBlocksData: () => false,
};
window.Generators = { generateGradient: () => 'data:img;grad', generateNoise: () => 'data:img;noise' };
window.AI = { loadSettings: () => ({}), saveSettings: noop, buildContext: () => Promise.resolve({}), orchestrate: () => Promise.resolve('x'), splitRequirements: (t) => ({ story: t, requirements: '' }) };
window.Exporter = { exportSingleHTML: noop, exportZip: noop, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};
window.alert = (m) => { console.error('[ALERT]', m); };
global.alert = window.alert;

// Audio 桩：src 赋值后触发 onloadedmetadata，duration 从队列取
window.__durQueue = [];
window.Audio = class {
  constructor() { this.duration = NaN; this.onloadedmetadata = null; this.onerror = null; }
  set src(v) {
    this._src = v;
    const d = window.__durQueue.length ? window.__durQueue.shift() : NaN;
    this.duration = d;
    if (this.onloadedmetadata) setTimeout(() => this.onloadedmetadata(), 0);
  }
};
global.Audio = window.Audio;
global.URL = window.URL;
window.URL.createObjectURL = () => 'blob:x';
window.URL.revokeObjectURL = () => {};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);
const API = window.StoryEditorApi;

async function run() {
  // ---- 用例1：图片文件拖入 -> 背景库 ----
  const img = new window.File(['imgdata'], 'bg.png', { type: 'image/png' });
  await API.handleDroppedFiles([img]);
  await sleep(10);
  assert(libStore.background['bg.png'] && libStore.background['bg.png'].name === 'bg.png', '图片应归入背景库，实际=' + JSON.stringify(Object.keys(libStore.background)));

  // ---- 用例2：场景包（.json）拖入（即便当前在背景库）-> 物品库 ----
  const bundleJson = JSON.stringify({ schema: 'glb-scene-bundle', version: 1, exportedAt: 'x', count: 1, models: [{ id: 'm1', name: '模型', glb: 'data:model', exitMesh: null, interactions: {}, sounds: {}, defaultView: null, bg: null }] });
  const bundle = new window.File([bundleJson], 'scene.json', { type: 'application/json' });
  importCalls = [];
  await API.handleDroppedFiles([bundle]);
  await sleep(10);
  assert(importCalls.length === 1, '场景包应调用 importSceneBundle 归入物品库，实际调用次数=' + importCalls.length);

  // ---- 用例3：音频 <10s -> 音效库 ----
  window.__durQueue.push(5);
  const shortA = new window.File(['aud'], 'short.mp3', { type: 'audio/mpeg' });
  await API.handleDroppedFiles([shortA]);
  await sleep(10);
  assert(libStore.sound['short.mp3'] && libStore.sound['short.mp3'].name === 'short.mp3', '时长<10s 应归入音效库，实际 sound=' + JSON.stringify(Object.keys(libStore.sound)));
  assert(!libStore.music['short.mp3'], '时长<10s 不应归入音乐库');

  // ---- 用例4：音频 >30s -> 音乐库 ----
  window.__durQueue.push(45);
  const longA = new window.File(['aud'], 'long.mp3', { type: 'audio/mpeg' });
  await API.handleDroppedFiles([longA]);
  await sleep(10);
  assert(libStore.music['long.mp3'] && libStore.music['long.mp3'].name === 'long.mp3', '时长>30s 应归入音乐库，实际 music=' + JSON.stringify(Object.keys(libStore.music)));
  assert(!libStore.sound['long.mp3'], '时长>30s 不应归入音效库');

  // ---- 用例5：音频 10~30s -> 弹窗询问，选「音效库」 -> 音效库 ----
  window.__durQueue.push(20);
  const midA = new window.File(['aud'], 'mid.mp3', { type: 'audio/mpeg' });
  const p = API.handleDroppedFiles([midA]); // 不 await：等弹窗出现
  await sleep(15);
  const overlay = document.getElementById('audio-ask');
  assert(!overlay.classList.contains('hidden'), '10~30s 音频应弹出归类询问弹窗');
  assert(document.getElementById('audio-ask-file').textContent === 'mid.mp3', '弹窗应显示文件名');
  document.getElementById('audio-ask-sound').dispatchEvent(new window.Event('click', { bubbles: true }));
  await p;
  await sleep(10);
  assert(libStore.sound['mid.mp3'] && libStore.sound['mid.mp3'].name === 'mid.mp3', '选「音效库」后音频应入 sound 库，实际=' + JSON.stringify(Object.keys(libStore.sound)));
  assert(overlay.classList.contains('hidden'), '选择后弹窗应关闭');

  console.log('\n拖拽智能归类测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e); process.exit(1); });
