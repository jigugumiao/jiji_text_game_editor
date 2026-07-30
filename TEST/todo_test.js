// 素材待办测试：扫描「召唤了但库里没有」的素材；上传/生成器以待办名入库；重复召唤去重
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
global.FileReader = window.FileReader; // 编辑器内 readFileAsDataUrl 用非限定 FileReader，补到 Node 全局
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);

// 可控的内存素材库
const libStore = { background: {}, item: {}, music: {}, sound: {} };
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
  importSceneBundle: noop, deleteAsset: noop, renameAsset: noop,
  // 对话块系统方法（内存版）：block 系统后 computeTodo 扫描的就是 Storage 里的块文本，
  // 故测试桩用真实内存结构，让 API.setText 写入的内容能被 computeTodo 扫到。
  MAIN_BLOCK: '__MAIN__',
  _blocks: { main: '', blocks: {} },
  loadBlocks() { return this._blocks; },
  saveBlocks(b) { this._blocks = b; },
  getBlockText(name) { return name === '__MAIN__' ? (this._blocks.main || '') : (this._blocks.blocks[name] || ''); },
  setBlockText(name, text) { if (name === '__MAIN__') this._blocks.main = text == null ? '' : String(text); else this._blocks.blocks[name] = text == null ? '' : String(text); },
  addBlock(suggest) { const b = this._blocks.blocks; let n = suggest || '新对话', i = 2; while (n === '__MAIN__' || b[n] != null) { n = (suggest || '新对话') + ' ' + i; i++; } b[n] = ''; return n; },
  renameBlock() { return false; }, deleteBlock() { return false; },
  listBlockNames() { return ['__MAIN__'].concat(Object.keys(this._blocks.blocks)); },
  hasBlocksData() { return true; },
};
let genCall = { grad: 0, noise: 0 };
window.Generators = {
  generateGradient: () => { genCall.grad++; return 'data:image/png;base64,GRAD'; },
  generateNoise: () => { genCall.noise++; return 'data:image/png;base64,NOISE'; },
};
window.AI = { loadSettings: () => ({}), saveSettings: noop, buildContext: () => Promise.resolve({}), orchestrate: () => Promise.resolve('x'), splitRequirements: (t) => ({ story: t, requirements: '' }) };
window.Exporter = { exportSingleHTML: noop, exportZip: noop, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};
window.alert = (m) => { console.error('[ALERT]', m); };
global.alert = window.alert;
// window.open 桩：记录调用，避免 jsdom 抛「Not implemented」
let openCalls = [];
window.open = (url, target, feat) => { openCalls.push({ url, target, feat }); return null; };

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 预置：背景库已有「天空」
libStore.background['天空'] = { id: 'b1', name: '天空', kind: 'image', src: 'data:img' };

// 加载编辑器
const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);
const API = window.StoryEditorApi;
// 让 setText 同时持久化到内存块存储：block 系统后 computeTodo 扫描的是 Storage 而非 textarea
const _origSetText = API.setText;
API.setText = (t) => { const ta = document.getElementById('story-text'); if (ta) ta.value = t; window.Storage.setBlockText('__MAIN__', t); };

async function run() {
  // ---- 用例1：扫描缺失（存在的不算，缺失的算，重复召唤去重） ----
  const TEXT =
    '<召唤背景:天空>\n' +       // 已有 -> 不算待办
    '<召唤背景:夜路>\n' +        // 缺失
    '<召唤背景:夜路>\n' +        // 重复 -> 仍只算一次
    '<召唤物品:宝箱>\n' +        // 缺失
    '<召唤音乐:主题>\n';         // 缺失
  API.setText(TEXT);
  let todo = await API.computeTodo();
  assert(todo.length === 3, '应识别出 3 个缺失素材（夜路/宝箱/主题），实际 ' + todo.length);
  const names = todo.map(t => t.kind + ':' + t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['background:夜路', 'item:宝箱', 'music:主题'].sort()),
    '待办应为 夜路/宝箱/主题，实际 ' + JSON.stringify(names));
  assert(!todo.some(t => t.name === '天空'), '已存在的天空不应出现在待办');

  // ---- 用例2：refreshTodo 渲染列表 + 角标 ----
  await API.refreshTodo();
  await sleep(10);
  const badge = document.getElementById('todo-badge');
  assert(badge.hidden === false && badge.textContent === '3', '角标应显示 3 且不隐藏，实际 hidden=' + badge.hidden + ' text=' + badge.textContent);
  const items = document.querySelectorAll('#todo-list .todo-item');
  assert(items.length === 3, '列表应渲染 3 个待办项，实际 ' + items.length);
  // 背景待办应有 2 个生成器按钮
  const bgItem = document.querySelector('#todo-list .todo-item.todo-background');
  assert(!!bgItem, '应有背景类待办项');
  assert(bgItem.querySelectorAll('.todo-gengrad, .todo-gennoise').length === 2, '背景待办应含 渐变+噪波 两个生成器按钮');
  // 非背景待办不应有生成器按钮
  const musicItem = document.querySelector('#todo-list .todo-item.todo-music');
  assert(musicItem && musicItem.querySelectorAll('.todo-gengrad, .todo-gennoise').length === 0, '音乐待办不应含生成器按钮');

  // ---- 用例3：音乐待办的上传按钮以待办名入库 + 补齐后从列表消失 ----
  let targetItem = null;
  document.querySelectorAll('#todo-list .todo-item').forEach(el => {
    if (el.querySelector('.todo-name') && el.querySelector('.todo-name').textContent === '主题') targetItem = el;
  });
  assert(!!targetItem, '应能定位到 主题 待办项');
  const fileInput = targetItem.querySelector('input[type=file]');
  const fakeFile = new window.File(['audiodata'], '随便叫.mp3', { type: 'audio/mpeg' });
  Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(30); // 等 readFileAsDataUrl + saveAsset
  assert(libStore.music['主题'] && libStore.music['主题'].name === '主题', '上传后音乐库应以待办名「主题」入库，而非文件名；当前=' + JSON.stringify(Object.keys(libStore.music)));
  // 重新刷新，主题应消失
  await API.refreshTodo();
  await sleep(10);
  let remain = Array.from(document.querySelectorAll('#todo-list .todo-item .todo-name')).map(e => e.textContent);
  assert(!remain.includes('主题'), '补齐后 主题 应从待办列表消失；当前=' + JSON.stringify(remain));

  // ---- 用例3b：物品待办上传 GLB 场景包 JSON，以待办名入库（覆盖包内原名） ----
  API.setText('<召唤物品:宝箱>');
  await API.refreshTodo();
  await sleep(10);
  let itemItem = document.querySelector('#todo-list .todo-item.todo-item');
  assert(itemItem && itemItem.querySelector('.todo-name').textContent === '宝箱', '应定位到 宝箱 待办项');
  const bundleJson = JSON.stringify({ schema: 'glb-scene-bundle', version: 1, exportedAt: 'x', count: 1, models: [{ id: 'm1', name: '原模型名', glb: 'data:model', exitMesh: null, interactions: {}, sounds: {}, defaultView: null, bg: null }] });
  const bundleFile = new window.File([bundleJson], 'pack.json', { type: 'application/json' });
  const itemFileInput = itemItem.querySelector('input[type=file]');
  Object.defineProperty(itemFileInput, 'files', { value: [bundleFile], configurable: true });
  itemFileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(30);
  assert(libStore.item['宝箱'] && libStore.item['宝箱'].name === '宝箱' && libStore.item['宝箱'].glb === 'data:model',
    '物品上传场景包后应以待办名「宝箱」入库（覆盖包内原名），且保留 glb；当前=' + JSON.stringify(libStore.item['宝箱'] || null));

  // ---- 用例4：背景生成器按钮打开可调弹层，用户在弹层点「生成」后以待办名入库 ----
  // 重新设文字只含一个缺失背景，便于定位
  API.setText('<召唤背景:星云>');
  await API.refreshTodo();
  await sleep(10);
  const bg2 = document.querySelector('#todo-list .todo-item.todo-background');
  assert(bg2 && bg2.querySelector('.todo-name').textContent === '星云', '应定位到 星云 待办项');
  // 点渐变按钮：应弹出「渐变生成器」弹层（含颜色选择），而非直接生成
  genCall.grad = 0;
  bg2.querySelector('.todo-gengrad').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(10);
  assert(!document.getElementById('gen-modal').classList.contains('hidden'), '点渐变按钮应弹出生成器弹层（可调颜色界面）');
  assert(!!document.getElementById('g-c1') && !!document.getElementById('g-c2'), '弹层应含颜色选择器');
  // 用户在弹层里点「生成并加入背景库」（重置计数，隔离本次点击的调用）
  genCall.grad = 0;
  document.getElementById('g-go').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(20);
  assert(libStore.background['星云'] && libStore.background['星云'].name === '星云' && libStore.background['星云'].kind === 'gradient',
    '弹层生成后应以「星云」入库且 kind=gradient；当前=' + JSON.stringify(libStore.background['星云'] || null));
  assert(genCall.grad === 1, '点「生成并加入背景库」应调用一次 generateGradient');
  // 噪波同理：点按钮弹层 -> 点「生成」
  bg2.querySelector('.todo-gennoise').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(10);
  assert(!document.getElementById('gen-modal').classList.contains('hidden'), '点噪波按钮应再次弹出生成器弹层');
  genCall.noise = 0;
  document.getElementById('n-go').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(20);
  assert(libStore.background['星云'] && libStore.background['星云'].kind === 'noise', '弹层生成后噪波应覆盖为 kind=noise（同名覆盖）');
  assert(genCall.noise === 1, '点「生成并加入背景库」应调用一次 generateNoise');

  // ---- 用例4b：音效待办「一键搜索」按钮 -> 新窗口跳转 tosound 搜索 ----
  API.setText('<召唤音效:雷声>');
  await API.refreshTodo();
  await sleep(10);
  const snd = document.querySelector('#todo-list .todo-item.todo-sound');
  assert(snd && snd.querySelector('.todo-name').textContent === '雷声', '应定位到 雷声 音效待办项');
  assert(snd.querySelector('.todo-search'), '音效待办应含「一键搜索」按钮');
  assert(!snd.querySelector('.todo-gengrad'), '音效待办不应含背景生成器按钮');
  openCalls.length = 0;
  snd.querySelector('.todo-search').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(5);
  assert(openCalls.length === 1, '点搜索按钮应调用一次 window.open');
  assert(openCalls[0].url === 'https://www.tosound.com/search/word-' + encodeURIComponent('雷声'),
    '跳转地址应为 tosound 搜索页，实际=' + (openCalls[0] && openCalls[0].url));
  assert(openCalls[0].target === '_blank', '应新窗口打开（target=_blank）');

  // ---- 用例4c：音乐待办「一键搜索」按钮 -> 跳转 tosound 并带 /music-1 后缀 ----
  API.setText('<召唤音乐:主题曲>');
  await API.refreshTodo();
  await sleep(10);
  const mus = document.querySelector('#todo-list .todo-item.todo-music');
  assert(mus && mus.querySelector('.todo-name').textContent === '主题曲', '应定位到 主题曲 音乐待办项');
  assert(mus.querySelector('.todo-search'), '音乐待办应含「一键搜索」按钮');
  assert(!mus.querySelector('.todo-gengrad'), '音乐待办不应含背景生成器按钮');
  openCalls.length = 0;
  mus.querySelector('.todo-search').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(5);
  assert(openCalls.length === 1, '点搜索按钮应调用一次 window.open');
  assert(openCalls[0].url === 'https://www.tosound.com/search/word-' + encodeURIComponent('主题曲') + '/music-1',
    '音乐跳转地址应带 /music-1 后缀，实际=' + (openCalls[0] && openCalls[0].url));

  // ---- 用例5：空文本 -> 无待办 ----
  API.setText('');
  todo = await API.computeTodo();
  assert(todo.length === 0, '空文本应无待办');
  await API.refreshTodo();
  await sleep(10);
  assert(document.getElementById('todo-badge').hidden === true, '空文本角标应隐藏');
  assert(document.querySelector('#todo-list .todo-empty'), '应显示「都已就绪」空态');

  console.log('\n素材待办测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e); process.exit(1); });
