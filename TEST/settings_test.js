// 端到端测试：设置抽屉重构（设置按钮 / 子导航切换 / 创作设定入 meta / 通用子项渲染 / AI 写作卡片）
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

// ---- 可持久化 mock：meta / AI settings 都存在闭包里 ----
let META = { title: '', creation: {} };
let AISET = {};
const noop = () => Promise.resolve();
window.Storage = {
  migrateLegacyIfNeeded: noop,
  setCurrentProject() {}, createProject: () => 'p1', renameProject: noop, deleteProject: noop,
  listProjects: () => [], getProjectStats: () => ({ models: 0, folders: 0 }),
  loadMeta: () => META, loadStoryText: () => '', loadStory: () => [],
  saveStory: noop, saveStoryText: noop, saveMeta: (m) => { META = m; },
  getAllAssets: () => Promise.resolve([]),
  saveAsset: noop, importSceneBundle: noop, deleteAsset: noop, renameAsset: noop,
  // 对话块系统方法：block 系统落地后 editor.js 会调用，测试桩补齐
  MAIN_BLOCK: '__MAIN__', loadBlocks: () => ({ main: '', blocks: {} }), saveBlocks: noop,
  getBlockText: () => '', setBlockText: noop, addBlock: () => '新对话',
  renameBlock: () => false, deleteBlock: () => false, listBlockNames: () => ['__MAIN__'], hasBlocksData: () => false,
};
window.AI = {
  loadSettings: () => AISET,
  saveSettings: (s) => { AISET = s; },
  buildContext: () => Promise.resolve({ before: '前文', after: '后文', hasSel: false, selStart: 0, selEnd: 0 }),
  orchestrate: () => Promise.resolve('AI 生成的剧本文字'),
  splitRequirements: (t) => ({ story: t, requirements: '' }),
};
window.Exporter = { exportSingleHTML: noop, exportZip: noop, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.Generators = { generateGradient: () => '', generateNoise: () => '' };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// confirm 模拟：默认接受；测试可临时改为拒绝以验证警告
let lastConfirm = '', confirmReturn = true;
window.confirm = (msg) => { lastConfirm = msg || ''; return confirmReturn; };

const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);

(async () => {
  await new Promise(r => setTimeout(r, 90));

  const drawer = document.getElementById('settings-drawer');
  const btnSettings = document.getElementById('btn-settings');
  const btnAiOld = document.getElementById('btn-ai');
  const libTabs = document.querySelectorAll('#lib-tabs button[data-lib]');

  // 1. 顶栏：旧 AI 按钮消失，新设置按钮存在（项目右边）
  assert(!btnAiOld, '右上角旧「🤖 AI编剧」按钮应已移除');
  assert(!!btnSettings, '顶栏应存在「⚙ 设置」按钮');
  assert(btnSettings.previousElementSibling && btnSettings.previousElementSibling.id === 'btn-projects', '设置按钮应在「项目」按钮右边');

  // 2. 库 tab 共 5 个（背景/物品/音乐/音效/对话块，创作/全局 已移入设置）
  assert(libTabs.length === 5, '素材库应有 5 个 tab（背景/物品/音乐/音效/对话块），实际 ' + libTabs.length);
  let hasCreation = false, hasGlobal = false;
  libTabs.forEach(b => { if (b.dataset.lib === 'creation') hasCreation = true; if (b.dataset.lib === 'global') hasGlobal = true; });
  assert(!hasCreation && !hasGlobal, '库 tab 不应再有 创作 / 全局');

  // 3. 点击设置 → 抽屉打开，默认 AI 子项
  click(btnSettings);
  assert(!drawer.classList.contains('hidden'), '点击设置：抽屉应打开');
  const aiSub = drawer.querySelector('.settings-sub[data-sub="ai"]');
  const genSub = drawer.querySelector('.settings-sub[data-sub="general"]');
  assert(!aiSub.classList.contains('hidden'), '打开时默认应显示 AI 编剧子项');
  assert(genSub.classList.contains('hidden'), '打开时通用子项应隐藏');

  // 4. 创作设定输入写入 meta（验证「创作信息放进 AI 编剧」）
  const cOutline = document.getElementById('c-outline');
  cOutline.value = '主角被困矿洞';
  cOutline.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(META.creation && META.creation.outline === '主角被困矿洞', '创作设定「大纲」应写入 meta.creation.outline');
  // 重新打开应回填
  click(document.getElementById('settings-close'));
  click(btnSettings);
  assert(document.getElementById('c-outline').value === '主角被困矿洞', '重新打开应回填已存的大纲');

  // 5. 切到通用子项 → 渲染全局设置（游戏名/开场背景/水印等）
  click(drawer.querySelector('.settings-subnav[data-sub="general"]'));
  assert(genSub.classList.contains('hidden') === false, '切到通用后通用子项应显示');
  assert(aiSub.classList.contains('hidden'), '切到通用后 AI 子项应隐藏');
  assert(!!document.getElementById('gs-name'), '通用子项应渲染「游戏名」输入');
  assert(!!document.getElementById('gs-opening'), '通用子项应渲染「开场背景」输入');
  assert(!!document.getElementById('wm-text'), '通用子项应渲染「水印文字」输入');
  // 改游戏名写入 globalSettings（通过 saveGlobal → meta）
  const gsName = document.getElementById('gs-name');
  gsName.value = '我的互动剧';
  gsName.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(META.gameName === '我的互动剧', '通用子项改游戏名应写入 meta.gameName');

  // 6. AI 写作入口（列头 🤖 AI 快捷菜单）：无 key 时点续写 → 提示并打开 AI 子项
  click(document.getElementById('settings-close'));
  click(btnSettings); // 先开设置确认无 key 状态
  click(document.getElementById('settings-close'));
  click(document.getElementById('btn-ai-quick'));
  const qm = document.getElementById('ai-quick-menu');
  assert(!qm.classList.contains('hidden'), '点 🤖 AI 应弹出写作方式菜单');
  assert(qm.querySelectorAll('button[data-mode]').length === 5, '菜单应列出全部 5 种写作方式（钩子/大纲/续写/重写/润色）');
  click(qm.querySelector('button[data-mode="continue"]'));
  await new Promise(r => setTimeout(r, 30));
  assert(!drawer.classList.contains('hidden'), '无 key 点写作方式：应打开设置抽屉提示填 key');

  // 7. 有 key 时：点列头 🤖 AI 续写 → 先列上下文（不直接生成）→ 点「开始续写」→ 出文本
  AISET = { key: 'sk-test', base: '', model: 'deepseek-v4-flash', intensity: '中', temp: 0.8, selfCheck: false };
  const reviewModal = document.getElementById('ai-review-modal');
  reviewModal.classList.add('hidden');
  click(document.getElementById('btn-ai-quick'));
  click(document.getElementById('ai-quick-menu').querySelector('button[data-mode="continue"]'));
  await new Promise(r => setTimeout(r, 40));
  assert(!reviewModal.classList.contains('hidden'), '有 key 点写作方式：应弹出审阅窗');
  assert(!document.getElementById('ai-review-start').classList.contains('hidden'), '应先进入「列上下文 + 开始按钮」预览态（不自动生成）');
  assert(document.getElementById('ai-review-text').classList.contains('hidden'), '预览态正文文本框应隐藏');
  const startBtn = document.getElementById('ai-start-gen');
  assert(startBtn && startBtn.textContent.indexOf('开始') === 0, '开始按钮文案应以「开始」开头');
  // 点开始续写 → 出文本
  click(startBtn);
  await new Promise(r => setTimeout(r, 120));
  assert(document.getElementById('ai-review-text').value === 'AI 生成的剧本文字', '点开始后审阅窗应显示 AI 生成文本');
  assert(!document.getElementById('ai-review-text').classList.contains('hidden'), '结果态正文文本框应可见');

  // 7b. 结果态点窗口外 → 警告「token 不返还」，可取消（保留）/ 可确认（关闭）
  const backdrop = document.getElementById('ai-review-modal');
  confirmReturn = false;
  backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(!reviewModal.classList.contains('hidden'), '结果态点窗口外且取消确认：窗口应保留');
  assert(lastConfirm.indexOf('token') >= 0 && lastConfirm.indexOf('消失') >= 0, '应弹出「结果会消失，token 不会返还」警告');
  confirmReturn = true;
  backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(reviewModal.classList.contains('hidden'), '结果态确认关闭后窗口应消失');

  // 7c. 预览态（无结果）点窗口外 → 直接关闭，无需确认
  lastConfirm = '____reset____';
  click(document.getElementById('btn-ai-quick'));
  click(document.getElementById('ai-quick-menu').querySelector('button[data-mode="continue"]'));
  await new Promise(r => setTimeout(r, 40));
  assert(!reviewModal.classList.contains('hidden'), '重新进入应为预览态审阅窗');
  assert(document.getElementById('ai-review-start').classList.contains('hidden') === false, '预览态应显示开始按钮');
  backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert(reviewModal.classList.contains('hidden'), '预览态（无结果）点窗口外应直接关闭、不警告');
  assert(lastConfirm === '____reset____', '预览态关闭不应触发 confirm 警告');

  console.log('\n==== 设置抽屉重构测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log(fail === 0 ? '全部 PASS ✅' : '有失败 ❌');
  if (fail) process.exit(1);
})();
