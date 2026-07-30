// block_test.js — 对话块系统（主对话 / 分支对话）测试
// 覆盖：存储层主对话置顶+不可删、parseStory 分支节点、storyToText 往返、
// 编辑器 insertBlockJump / insertBlockOption / 对话块切换 / 拖放插入选项、
// 以及运行时分支引擎（jsdom 驱动：选项推进 / <跳回> / 存档读档）。
const fs = require('fs');
const path = require('path');
const WORKSPACE_MODULES = 'C:/Users/z1x2c/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM } = require(path.join(WORKSPACE_MODULES, 'jsdom'));

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ============ 编辑器 DOM ============
const dom = new JSDOM(HTML, { url: 'https://localhost/', pretendToBeVisual: true });
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.navigator = window.navigator;
global.FileReader = window.FileReader;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);

// ============ 真实存储层（由 localStorage 支撑，不碰 IndexedDB）============
const storageSrc = fs.readFileSync(path.join(__dirname, '..', 'js/storage.js'), 'utf8');
window.eval(storageSrc);
const Storage = window.Storage;
// 让 init() 的微任务走桩，不触发 IndexedDB 迁移
Storage.migrateLegacyIfNeeded = () => Promise.resolve();
// JSDOM 无 IndexedDB：渲染素材库 / 项目统计时改为返回空，避免报错（本测试不校验素材层）
Storage.getAllAssets = () => Promise.resolve([]);
Storage.getProjectStats = async () => ({ assetCount: 0, lineCount: 0 });
// JSDOM 未实现 Element.scrollTo：运行时与编辑器都用它做自动滚动，置为空操作
window.Element.prototype.scrollTo = function () {};

// ============ 编辑器依赖的其它模块桩（仅被事件处理器引用，不参与启动）============
window.Generators = { generateGradient: () => 'data:img;grad', generateNoise: () => 'data:img;noise' };
window.AI = { loadSettings: () => ({}), saveSettings: () => {}, buildContext: () => Promise.resolve({}), orchestrate: () => Promise.resolve('x'), splitRequirements: (t) => ({ story: t, requirements: '' }), splitIntoBlocks: require('../js/ai.js').splitIntoBlocks };
window.Exporter = { exportSingleHTML: () => {}, exportZip: () => {}, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};
window.alert = (m) => { console.error('[ALERT]', m); };
global.alert = window.alert;

const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(editorSrc);
// 若 init() 因 DOMContentLoaded 已触发而未能自动运行，这里补发一次，确保 bindGlobal 绑定好拖放监听
try { window.document.dispatchEvent(new window.Event('DOMContentLoaded')); } catch (e) {}
const API = window.StoryEditorApi;

// ============ 运行时（单独 JSDOM 加载 buildRuntimeHTML 产物）============
const exporterSrc = fs.readFileSync(path.join(__dirname, '..', 'js/exporter.js'), 'utf8');
window.eval(exporterSrc); // 暴露 window.Exporter
const Exporter = window.Exporter;
// 运行时与编辑器共用同一套节点结构，直接用已验证的 API.parseStory 解析块文本
const parseX = (txt) => API.parseStory(txt);

// ============ 断言工具 ============
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(win, pred, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      let ok = false;
      try { ok = pred(win); } catch (e) {}
      if (ok) return resolve(true);
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor 超时'));
      setTimeout(poll, 25);
    })();
  });
}
function buildRuntimeDOM(mainText, blocksMap) {
  const data = {
    title: '分支测试',
    blocks: Object.assign({ '__MAIN__': parseX(mainText) }, blocksMap || {}),
    start: '__MAIN__',
    assets: { background: {}, item: {}, music: {}, sound: {} },
    global: {},
  };
  const html = Exporter.buildRuntimeHTML(data, 'single');
  return new JSDOM(html, {
    url: 'https://localhost/',
    runScripts: 'dangerously',
    beforeParse(w) {
      w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
      w.cancelAnimationFrame = (id) => clearTimeout(id);
      w.Element.prototype.scrollTo = function () {};
      w.Audio = class { constructor() { this.loop = false; this.volume = 1; } play() { return Promise.resolve(); } pause() {} load() {} };
    },
  });
}

async function main() {
  // ============ Part A：存储层 ============
  console.log('— Part A：存储层（主对话置顶 / 不可删 / 读写 / 重命名同步引用）—');
  window.localStorage.clear();

  let names = Storage.listBlockNames();
  assert(names[0] === '__MAIN__', 'listBlockNames 首元素必须是主对话(__MAIN__)，实际=' + names[0]);
  assert(names.includes('__MAIN__'), 'listBlockNames 必须包含主对话');

  assert(Storage.deleteBlock('__MAIN__') === false, 'deleteBlock(主对话) 必须返回 false');
  assert(Storage.getBlockText('__MAIN__') !== undefined, '主对话删除后仍应可读（结构存在）');

  const b1 = Storage.addBlock('支线');
  assert(b1 && b1 !== '__MAIN__', 'addBlock 返回名不应是主对话，实际=' + b1);
  names = Storage.listBlockNames();
  assert(names[0] === '__MAIN__' && names.includes(b1), '新建块后主对话仍置顶且块在列表中：' + names.join(','));

  Storage.setBlockText('__MAIN__', '主对话内容');
  Storage.setBlockText(b1, '支线内容');
  assert(Storage.getBlockText('__MAIN__') === '主对话内容', '主对话读写不一致');
  assert(Storage.getBlockText(b1) === '支线内容', '支线读写不一致');

  // 重命名同步更新主对话与其它块里的引用
  Storage.setBlockText('__MAIN__', '先去 <对话块:旧名> 然后 <选项:"选",旧名> 结束。');
  Storage.addBlock('旧名');
  Storage.setBlockText('旧名', '旧内容。');
  const renamed = Storage.renameBlock('旧名', '新名');
  assert(renamed === '新名', 'renameBlock 应返回新名，实际=' + renamed);
  const mt = Storage.getBlockText('__MAIN__');
  assert(mt.includes('<对话块:新名>') && mt.includes('<选项:"选",新名>'), '重命名后主对话引用未更新：' + mt);
  assert(!mt.includes('旧名'), '重命名后主对话仍含旧名：' + mt);
  assert(Storage.getBlockText('新名') === '旧内容。', '重命名后内容未迁移');

  // ============ Part B：编辑器解析 / API ============
  console.log('— Part B：编辑器 parseStory / storyToText / 插入指令 / 块切换 / 拖放 —');
  const p = API.parseStory('普通文字\n<对话块:支线A>\n<跳回>\n<选项:"去左",左岸> <选项:"去右",右岸> <选项:"只推进">');
  assert(p[0].type === 'text' && p[0].content === '普通文字', '文本节点解析错误');
  assert(p.some(n => n.type === 'block' && n.name === '支线A'), '对话块节点解析错误');
  assert(p.some(n => n.type === 'return'), '跳回节点解析错误');
  const optNode = p.find(n => n.type === 'options');
  assert(optNode, '选项节点缺失');
  assert(optNode.options.length === 3, '单行三选项应解析为 3 个，实际=' + optNode.options.length);
  assert(optNode.options[0].text === '去左' && optNode.options[0].block === '左岸', '选项1 解析错误：' + JSON.stringify(optNode.options[0]));
  assert(optNode.options[2].text === '只推进' && optNode.options[2].block === null, '无块选项解析错误：' + JSON.stringify(optNode.options[2]));

  const rt = API.storyToText(p);
  const p2 = API.parseStory(rt);
  assert(JSON.stringify(p2) === JSON.stringify(p), 'storyToText→parseStory 往返不一致');

  const st = window.document.getElementById('story-text');
  st.value = '开头\n'; st.selectionStart = st.selectionEnd = st.value.length;
  API.insertBlockJump('支线A');
  assert(st.value.includes('<对话块:支线A>'), 'insertBlockJump 未插入指令：' + st.value);

  st.value = '正文\n'; st.selectionStart = st.selectionEnd = st.value.length;
  API.insertBlockOption('支线A');
  const m = st.value.match(/<选项:"([^"]*)",支线A>/);
  assert(m, 'insertBlockOption 未插入选项指令：' + st.value);
  assert(m[1] === '文字', 'insertBlockOption 占位符应为「文字」，实际=' + (m && m[1]));
  assert(st.selectionStart === st.value.indexOf('文字') && st.selectionEnd === st.selectionStart + 2, 'insertBlockOption 未选中占位符');

  // 添加选项按钮：移到本行末尾、同行追加 <选项:"">，不换行；光标落在引号内
  st.value = '第一行 ABC\n第二行\n';
  st.selectionStart = st.selectionEnd = '第一行 AB'.length; // 光标在第一行中间
  API.insertOptionEmpty();
  assert(st.value.includes('<选项:"">'), 'insertOptionEmpty 未插入 <选项:"">：' + st.value);
  assert(st.value === '第一行 ABC<选项:"">\n第二行\n', 'insertOptionEmpty 应在本行末尾追加且不换行：' + st.value);
  const optAt = st.value.indexOf('<选项:"">');
  assert(st.selectionStart === optAt + 5 && st.selectionEnd === optAt + 5, 'insertOptionEmpty 光标未落在引号内：start=' + st.selectionStart);

  const cur = API.getActiveBlock();
  assert(cur === '__MAIN__', '默认活动块应为主对话，实际=' + cur);
  const blkName = Storage.addBlock('测试块B');
  Storage.setBlockText(blkName, '块B专属文字');
  API.setActiveBlock(blkName);
  assert(API.getActiveBlock() === blkName, 'setActiveBlock 未切换');
  assert(API.getBlockText(blkName) === '块B专属文字', 'getBlockText 取错块');

  // 模拟拖放对话块 → 插入选项
  st.value = '拖放测试\n'; st.selectionStart = st.selectionEnd = st.value.length;
  const dropEv = new window.Event('drop', { bubbles: true });
  dropEv.preventDefault = () => {};
  dropEv.dataTransfer = { types: ['application/x-block'], getData: (t) => t === 'application/x-block' ? JSON.stringify({ name: '支线A' }) : '' };
  st.dispatchEvent(dropEv);
  assert(/<选项:"文字",支线A>/.test(st.value), '拖放对话块未插入选项：' + st.value);

  // ============ Part C：运行时分支引擎（jsdom）============
  console.log('— Part C：运行时（选项推进 / <跳回> / 存档读档）—');

  // C1：分支 + 跳回 + 主对话尾部继续
  const r1 = buildRuntimeDOM(
    '开场，你会怎么做？\n<选项:"去左岸",左岸> <选项:"去右岸",右岸>\n回来了，故事继续。',
    {
      '左岸': parseX('左岸风景不错。\n<跳回>'),
      '右岸': parseX('右岸风浪很大。\n<跳回>'),
    }
  );
  const w1 = r1.window, d1 = w1.document;
  d1.getElementById('btn-start-game').click();
  await waitFor(w1, () => /开场/.test(d1.getElementById('message-list').textContent));
  await waitFor(w1, () => d1.querySelectorAll('#options-bar .opt-btn').length === 2);
  d1.querySelectorAll('#options-bar .opt-btn')[0].click(); // 去左岸
  await waitFor(w1, () => /左岸风景不错/.test(d1.getElementById('message-list').textContent) && /回来了，故事继续/.test(d1.getElementById('message-list').textContent));
  await waitFor(w1, () => d1.getElementById('end-card').style.display === 'flex');
  const txt1 = d1.getElementById('message-list').textContent;
  assert(/左岸风景不错/.test(txt1), 'C1：应执行左岸分支');
  assert(/回来了，故事继续/.test(txt1), 'C1：<跳回> 后应继续执行主对话尾部');
  assert(!/右岸风浪很大/.test(txt1), 'C1：未选的右岸分支不应执行');
  assert(d1.getElementById('options-bar').className.indexOf('show') === -1, 'C1：结束时选项栏应隐藏');

  // C2：存档（选项点，choices 为空） + 读档（重放回到选项点）
  const r2 = buildRuntimeDOM(
    '第一句。\n<选项:"去支线",支线> <选项:"去别处",支线B>\n结尾句。',
    { '支线': parseX('支线内容。\n<跳回>'), '支线B': parseX('别处内容。\n<跳回>') }
  );
  const w2 = r2.window, d2 = w2.document;
  d2.getElementById('btn-start-game').click();
  await waitFor(w2, () => /第一句/.test(d2.getElementById('message-list').textContent));
  await waitFor(w2, () => d2.querySelectorAll('#options-bar .opt-btn').length === 2);
  // 在选项点存档（此时未选任何选项，choices 应为空数组）
  d2.getElementById('tb-save').click();
  d2.querySelector('.sm-row[data-slot="1"] button[data-act="save"]').click();
  const GAME_KEY = 'storysave_分支测试_1';
  const raw = w2.localStorage.getItem(GAME_KEY);
  assert(raw, 'C2：存档应写入 localStorage');
  const saved = JSON.parse(raw);
  assert(Array.isArray(saved.choices) && saved.choices.length === 0, 'C2：选项点存档 choices 应为空数组，实际=' + JSON.stringify(saved));
  assert(typeof saved.line === 'number', 'C2：存档应含行号');
  // 选择「去支线」走到结局
  d2.querySelectorAll('#options-bar .opt-btn')[0].click();
  await waitFor(w2, () => /结尾句/.test(d2.getElementById('message-list').textContent));
  await waitFor(w2, () => d2.getElementById('end-card').style.display === 'flex');
  const txt2 = d2.getElementById('message-list').textContent;
  assert(/支线内容/.test(txt2), 'C2：应执行支线分支');
  assert(!/别处内容/.test(txt2), 'C2：未选的支线B分支不应执行');
  // 读档：应重放回到选项点（choices 空）
  d2.getElementById('tb-load').click();
  d2.querySelector('.sm-row[data-slot="1"] button[data-act="load"]').click();
  await waitFor(w2, () => d2.querySelectorAll('#options-bar .opt-btn').length === 2, 6000);
  assert(/第一句/.test(d2.getElementById('message-list').textContent), 'C2：读档后应从头重放至选项点');
  assert(d2.getElementById('end-card').style.display !== 'flex', 'C2：读档后不应处于结局');
  assert(w2.localStorage.getItem(GAME_KEY), 'C2：读档后原存档仍在');

  // ============ Part D：applyGeneratedBlocks 本地拆分并写入存储 ============
  console.log('— Part D：applyGeneratedBlocks（AI 一次出完 → 本地拆块）—');
  // 清空现有块，干净验证
  Storage.saveBlocks({ main: '', blocks: {} });
  const sample = '开场，眼前有扇铁门。\n<停顿>\n<<对话块:密室>>\n你在密室里搜查，发现一张图纸。\n<跳回>\n<<对话块:天台>>\n天台风很大，远处是城市灯火。\n<跳回>';
  API.applyGeneratedBlocks(sample);
  const mainTxt = Storage.getBlockText(Storage.MAIN_BLOCK);
  assert(mainTxt.includes('开场，眼前有扇铁门'), 'D：主对话应含开场内容');
  assert(mainTxt.includes('<对话块:密室>') && mainTxt.includes('<对话块:天台>'), 'D：主对话应含两个分支跳转指令');
  assert(!mainTxt.includes('<<对话块:'), 'D：主对话不应残留双尖括号定义标记');
  const mi = mainTxt.indexOf('<对话块:密室>'), ti = mainTxt.indexOf('<对话块:天台>');
  assert(mi >= 0 && ti >= 0 && mi < ti, 'D：主对话中密室跳转应排在天台之前');
  const room = Storage.getBlockText('密室');
  assert(room && room.includes('发现一张图纸'), 'D：密室块应含其内容');
  assert(room.trim().endsWith('<跳回>'), 'D：密室块应以 <跳回> 收尾');
  const roof = Storage.getBlockText('天台');
  assert(roof && roof.includes('城市灯火'), 'D：天台块应含其内容');
  assert(roof.trim().endsWith('<跳回>'), 'D：天台块应以 <跳回> 收尾');
  const dNames = API.listBlockNames();
  assert(dNames.indexOf('密室') >= 0 && dNames.indexOf('天台') >= 0, 'D：对话块列表应含密室与天台');
  assert(dNames.indexOf(Storage.MAIN_BLOCK) === 0, 'D：主对话应始终置顶');

  console.log('\n对话块系统测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
