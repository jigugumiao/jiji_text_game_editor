// 用 jsdom 加载真实页面，stub AI，走真实「续写模式 → 生成 → 点 接受并插入」流程
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlNoScripts = html.replace(/<script[^>]*><\/script>/g, '');

const dom = new JSDOM(htmlNoScripts, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const { document } = window;

function makeIDB() {
  const stores = {};
  function open(name) {
    const req = {};
    const db = {
      objectStoreNames: { contains: (n) => !!stores[n] },
      createObjectStore: (n) => { stores[n] = {}; return {}; },
      transaction: (sn, mode) => ({ objectStore: (n) => ({
        put: (val) => { stores[n][val.key] = val; return {}; },
        get: (k) => { const r = {}; setTimeout(() => { r.result = stores[n][k]; if (r.onsuccess) r.onsuccess(); }, 0); return r; },
        delete: (k) => { delete stores[n][k]; return {}; },
        getAll: () => { const r = {}; setTimeout(() => { r.result = Object.values(stores[n]); if (r.onsuccess) r.onsuccess(); }, 0); return r; },
      }) }),
    };
    setTimeout(() => { req.result = db; if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); }, 0);
    return req;
  }
  return { open };
}
window.indexedDB = makeIDB();
window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
const _ls = {};
window.localStorage = { getItem: k => (k in _ls ? _ls[k] : null), setItem: (k, v) => { _ls[k] = String(v); }, removeItem: k => { delete _ls[k]; } };

const order = ['js/zip.js', 'js/storage.js', 'js/generators.js', 'js/bbcode.js', 'js/exporter.js', 'js/ai.js', 'js/editor.js'];
for (const f of order) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try { window.eval(code); } catch (e) { console.log('LOAD ERROR in', f, ':', e.message); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
setTimeout(async () => {
  try {
    const AI = window.AI;
    if (!AI) { console.log('NO window.AI'); return; }
    // stub：返回一段普通续写（含 BBCode，非 hook）
    AI.orchestrate = (opts) => {
      console.log('orchestrate called, mode=', opts && opts.mode);
      const fakeStory = '雨越下越大。\n[b]那把伞[/b]还靠在墙角。\n<停顿>\n我蹲下，指尖碰到湿冷的金属。';
      return Promise.resolve(fakeStory);
    };

    window.localStorage.setItem('storyeditor:ai:key', 'fake-key');

    const quickBtn = document.querySelector('#btn-ai-quick');
    if (!quickBtn) { console.log('NO #btn-ai-quick'); return; }
    quickBtn.click();
    await sleep(20);
    const contItem = Array.from(document.querySelectorAll('#ai-quick-menu [data-mode]')).find(b => b.dataset.mode === 'continue');
    if (!contItem) { console.log('NO continue item in quick menu'); return; }
    contItem.click();
    await sleep(50);
    console.log('continue mode opened, modal hidden?', document.querySelector('#ai-review-modal').classList.contains('hidden'));

    const startBtn = document.querySelector('#ai-start-gen');
    if (!startBtn) { console.log('NO start btn'); return; }
    startBtn.click();
    await sleep(150); // orchestrate.then -> result 阶段

    const textArea = document.querySelector('#ai-review-text');
    console.log('ai-review-text value len:', textArea ? textArea.value.length : 'NO TEXTAREA');
    console.log('ai-review-text value:', JSON.stringify(textArea ? textArea.value : ''));

    const acceptBtn = document.querySelector('#ai-accept');
    console.log('ai-accept exists?', !!acceptBtn, 'hidden?', acceptBtn ? acceptBtn.classList.contains('hidden') : 'n/a', 'disabled?', acceptBtn ? acceptBtn.disabled : 'n/a');

    const storyEl = document.querySelector('#story-text');
    const before = storyEl ? storyEl.value : '';
    console.log('storyText before len:', before.length);

    if (acceptBtn) {
      try { acceptBtn.click(); } catch (e) { console.log('ACCEPT CLICK THREW:', e.message, '\n', e.stack); }
    }
    await sleep(30);

    const after = storyEl ? storyEl.value : '';
    console.log('storyText after len:', after.length);
    console.log('INSERTED (len grew)?', after.length > before.length);
    console.log('modal closed?', document.querySelector('#ai-review-modal').classList.contains('hidden'));
    process.exit(0);
  } catch (e) {
    console.log('REPRO ERROR:', e.message, '\n', e.stack);
    process.exit(1);
  }
}, 500);
