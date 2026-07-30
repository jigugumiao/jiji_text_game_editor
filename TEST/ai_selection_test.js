// 端到端测试：选择类模式（重写/润色）预览只显示选中文字，且备注占位按模式区分
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

let META = { title: '', creation: { outline: '矿洞遇险', intro: '主角被困', world: '废土', tone: '冷峻' } };
let AISET = {};
const noop = () => Promise.resolve();
const STORY = '我推开矿洞的门。\n里面漆黑一片，我屏住呼吸往前走。\n脚步声在石壁间回荡。';
const SEL_START = STORY.indexOf('里面漆黑');
const SEL_END = STORY.indexOf('回荡');
const SEL_TEXT = STORY.slice(SEL_START, SEL_END);

window.Storage = {
  migrateLegacyIfNeeded: noop,
  setCurrentProject() {}, createProject: () => 'p1', renameProject: noop, deleteProject: noop,
  listProjects: () => [], getProjectStats: () => ({ models: 0, folders: 0 }),
  loadMeta: () => META, loadStoryText: () => STORY, loadStory: () => [],
  saveStory: noop, saveStoryText: noop, saveMeta: (m) => { META = m; },
  getAllAssets: () => Promise.resolve([]),
  saveAsset: noop, importSceneBundle: noop, deleteAsset: noop, renameAsset: noop,
};
window.AI = {
  loadSettings: () => AISET,
  saveSettings: (s) => { AISET = s; },
  buildContext: () => Promise.resolve({
    full: STORY, selStart: SEL_START, selEnd: SEL_END, hasSel: true, selText: SEL_TEXT,
    before: '我推开矿洞的门。', after: '脚步声在石壁间回荡。', creation: META.creation,
  }),
  orchestrate: () => Promise.resolve('AI 生成的剧本文字'),
  splitRequirements: (t) => ({ story: t, requirements: '' }),
};
window.Exporter = { exportSingleHTML: noop, exportZip: noop, buildPreviewHTML: () => Promise.resolve(''), collectRuntimeData: () => Promise.resolve({}) };
window.Generators = { generateGradient: () => '', generateNoise: () => '' };
window.BBCode = { wrapSelection() {}, insertAtCursor() {}, bbcodeToHtml: (s) => s };
window.Zip = {};
window.StoryEditorApi = {
  getText: () => STORY,
  getSel: () => ({ start: SEL_START, end: SEL_END }),
  getCreation: () => META.creation,
};

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const vis = (id) => !document.getElementById(id).classList.contains('hidden');

const src = fs.readFileSync(path.join(__dirname, '..', 'js/editor.js'), 'utf8');
window.eval(src);
// editor.js 自身会挂载 window.StoryEditorApi（getSel 读真实 textarea 选区，jsdom 下为 {0,0}），
// 覆盖 getSel 以模拟「用户已选中一段文字」，对齐真实有选区时的行为
if (window.StoryEditorApi && window.StoryEditorApi.getSel) {
  window.StoryEditorApi.getSel = () => ({ start: SEL_START, end: SEL_END });
}

async function openMode(mode) {
  const modal = document.getElementById('ai-review-modal');
  click(document.getElementById('btn-ai-quick'));
  click(document.getElementById('ai-quick-menu').querySelector('button[data-mode="' + mode + '"]'));
  await new Promise(r => setTimeout(r, 40));
  return modal;
}
async function closeModal() {
  click(document.getElementById('ai-discard'));
  await new Promise(r => setTimeout(r, 10));
}

(async () => {
  await new Promise(r => setTimeout(r, 90));
  AISET = { key: 'sk-test', base: '', model: 'deepseek-v4-flash', intensity: '中', temp: 0.8, selfCheck: false };

  // ---- expand（AI 重写选中文字）----
  let modal = await openMode('expand');
  assert(vis('ai-review-modal'), 'expand：应弹出审阅窗');
  assert(vis('ai-review-selection'), 'expand：应显示「选中文字」预览块');
  assert(!vis('ai-review-before') && !vis('ai-review-after'), 'expand：不应显示前后文上下文');
  assert(document.getElementById('ai-review-selection-text').textContent.includes('里面漆黑一片'), 'expand：选中文字块应含选中片段');
  assert(document.getElementById('ai-note').placeholder.indexOf('生成方向备注') === 0, 'expand：备注占位应为「生成方向备注」');
  assert(document.getElementById('ai-start-gen').textContent === '开始重写', 'expand：开始按钮文案应为「开始重写」');
  // 填备注 → 点开始 → 出文本
  document.getElementById('ai-note').value = '语气再冷一点';
  click(document.getElementById('ai-start-gen'));
  await new Promise(r => setTimeout(r, 120));
  assert(document.getElementById('ai-review-text').value === 'AI 生成的剧本文字', 'expand：点开始后应显示生成文本');
  await closeModal();

  // ---- polish（润色加文字效果）----
  modal = await openMode('polish');
  assert(vis('ai-review-selection'), 'polish：应显示「选中文字」预览块');
  assert(!vis('ai-review-before') && !vis('ai-review-after'), 'polish：不应显示前后文上下文');
  assert(document.getElementById('ai-note').placeholder.indexOf('生成方向备注') === 0, 'polish：备注占位应为「生成方向备注」');
  assert(document.getElementById('ai-start-gen').textContent === '开始润色', 'polish：开始按钮文案应为「开始润色」');
  await closeModal();

  // ---- continue（根据光标上下文续写）：应显示前后文、备注为续写 ----
  modal = await openMode('continue');
  assert(vis('ai-review-before') && vis('ai-review-after'), 'continue：应显示前后文上下文');
  assert(!vis('ai-review-selection'), 'continue：不应显示选中文字块');
  assert(document.getElementById('ai-note').placeholder.indexOf('生成方向备注') === 0, 'continue：备注占位应为「生成方向备注」');
  assert(document.getElementById('ai-start-gen').textContent === '开始续写', 'continue：开始按钮文案应为「开始续写」');
  await closeModal();

  // ---- outline（从大纲生成）：应显示大纲+已写前文并排块，隐藏前后文与选中块 ----
  modal = await openMode('outline');
  assert(vis('ai-review-outline'), 'outline：应显示大纲预览块');
  assert(!vis('ai-review-before') && !vis('ai-review-after'), 'outline：不应显示前后文');
  assert(!vis('ai-review-selection'), 'outline：不应显示选中文字块');
  assert(document.getElementById('ai-outline-creation').textContent.includes('矿洞遇险'), 'outline：大纲块应含创作设定');
  assert(document.getElementById('ai-outline-existing').textContent.includes('推开矿洞'), 'outline：已写前文块应含已写内容');
  // 对齐后：去掉前/后文框，只保留「创作设定 + 已写前文 + 输出栏」三框；开始按钮与方向备注统一在输出栏
  assert(vis('ai-review-mid'), 'outline：预览态应显示输出栏(mid)');
  assert(!document.getElementById('ai-start-gen-outline'), 'outline：大纲块独立开始按钮应已移除');
  assert(document.getElementById('ai-note').placeholder.indexOf('生成方向备注') === 0, 'outline：备注占位应为「生成方向备注」');
  assert(document.getElementById('ai-start-gen').textContent === '开始从大纲生成', 'outline：开始按钮应在输出栏、文案为「开始从大纲生成」');

  console.log('\n==== 选择类模式预览测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log(fail === 0 ? '全部 PASS ✅' : '有失败 ❌');
  if (fail) process.exit(1);
})();
