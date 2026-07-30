// 用 jsdom 加载真实页面，stub AI，走真实「生成钩子开头」流程，点「选用」验证是否插入
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 去掉外部 script，改为手动注入，方便 stub
const htmlNoScripts = html.replace(/<script[^>]*><\/script>/g, '');

const dom = new JSDOM(htmlNoScripts, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const { window } = dom;
const { document } = window;

// --- 极简内存版 indexedDB stub（让 init 通过）---
function makeIDB() {
  const stores = {};
  function open(name, ver) {
    const req = {};
    const db = {
      objectStoreNames: { contains: (n) => !!stores[n] },
      createObjectStore: (n) => { stores[n] = {}; return {}; },
      transaction: (storeName, mode) => ({
        objectStore: (sn) => ({
          put: (val) => { stores[sn][val.key] = val; return {}; },
          get: (k) => { const r = {}; setTimeout(() => { r.result = stores[sn][k]; if (r.onsuccess) r.onsuccess(); }, 0); return r; },
          delete: (k) => { delete stores[sn][k]; return {}; },
          getAll: () => { const r = {}; setTimeout(() => { r.result = Object.values(stores[sn]); if (r.onsuccess) r.onsuccess(); }, 0); return r; },
        }),
        onerror: null, oncomplete: null,
      }),
    };
    setTimeout(() => {
      req.result = db;
      if (!stores[name] && req.onupgradeneeded) { req.onupgradeneeded(); }
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }
  return { open };
}
window.indexedDB = makeIDB();
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
// 简易 localStorage
const _ls = {};
window.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; },
};

// 注入各 JS（顺序同 index.html），用 window.eval 保真作用域
const order = ['js/zip.js', 'js/storage.js', 'js/generators.js', 'js/bbcode.js', 'js/exporter.js', 'js/ai.js', 'js/editor.js'];
for (const f of order) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try { window.eval(code); } catch (e) { console.log('LOAD ERROR in', f, ':', e.message); }
}

// 等待 DOMContentLoaded 后的 init
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
setTimeout(async () => {
  try {
    // stub AI.orchestrate 让 hook 模式直接返回 6 个钩子
    const AI = window.AI;
    if (!AI) { console.log('NO window.AI'); return; }
    AI.orchestrate = (opts) => {
      const fakeStory = Array.from({length:6}, (_,i)=>'【钩子'+(i+1)+'】这是第'+(i+1)+'个开头。【/钩子'+(i+1)+'】').join('\n');
      return Promise.resolve(fakeStory);
    };
    console.log('orchestrate stubbed');

    // 预置假 API key，否则 prepareMode 会提前 return
    window.localStorage.setItem('storyeditor:ai:key', 'fake-key');

    // 打开 AI 快捷菜单并进入 hook 模式
    const quickBtn = document.querySelector('#btn-ai-quick');
    if (quickBtn) quickBtn.click();
    await sleep(20);
    const hookItem = Array.from(document.querySelectorAll('#ai-quick-menu [data-mode]')).find(b => b.dataset.mode === 'hook');
    if (!hookItem) { console.log('NO hook item in quick menu'); return; }
    hookItem.click();
    await sleep(50); // 等 buildContext -> openReviewModal
    console.log('hook mode opened, modal hidden?', document.querySelector('#ai-review-modal').classList.contains('hidden'));

    // 点击「开始生成 6 个开头」
    const startBtn = document.querySelector('#ai-start-gen');
    if (!startBtn) { console.log('NO start btn'); return; }
    startBtn.click();
    await sleep(150); // 等 orchestrate.then -> showHookChooser

    const chooser = document.querySelector('#ai-hook-chooser');
    const visible = chooser && !chooser.classList.contains('hidden');
    console.log('chooser visible?', visible);
    const cards = document.querySelectorAll('#ai-hook-list .ai-hook-card');
    console.log('cards rendered:', cards.length);
    const storyEl = window.document.querySelector('#story-text');
    const before = (storyEl || {}).value || '';
    console.log('storyText before click length:', before.length);

    const useBtn = document.querySelector('#ai-hook-list .ai-hook-card .btn');
    if (!useBtn) { console.log('NO 选用 button found'); return; }
    useBtn.click();
    await sleep(20);

    const after = (storyEl || {}).value || '';
    console.log('storyText after click length:', after.length);
    console.log('INSERTED (len grew)?', after.length > before.length);
    console.log('modal closed?', document.querySelector('#ai-review-modal').classList.contains('hidden'));
    process.exit(0);
  } catch (e) {
    console.log('REPRO ERROR:', e.message, '\n', e.stack);
    process.exit(1);
  }
}, 500);
