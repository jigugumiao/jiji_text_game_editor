// 用 jsdom 加载真实页面，验证「重提要求」时 prompt 预填了上次的备注，
// 且二次重提会预填上一次重提后的内容（备注默认保留、可改）。
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
const captured = [];
setTimeout(async () => {
  try {
    const AI = window.AI;
    if (!AI) { console.log('NO window.AI'); return; }
    let genCount = 0;
    AI.orchestrate = () => { genCount++; return Promise.resolve('雨越下越大。\n[b]那把伞[/b]还靠在墙角。'); };

    window.localStorage.setItem('storyeditor:ai:key', 'fake-key');

    const quickBtn = document.querySelector('#btn-ai-quick');
    quickBtn.click();
    await sleep(20);
    const contItem = Array.from(document.querySelectorAll('#ai-quick-menu [data-mode]')).find(b => b.dataset.mode === 'continue');
    contItem.click();
    await sleep(50);

    // 首次生成前，填方向备注
    const noteEl = document.querySelector('#ai-note');
    noteEl.value = '方向：震惊向';
    document.querySelector('#ai-start-gen').click();
    await sleep(150);
    console.log('[1] 首次生成完成 ai-review-text.len =', document.querySelector('#ai-review-text').value.length, 'genCount =', genCount);

    // 第一次重提：prompt 应预填「方向：震惊向」
    window.prompt = (msg, def) => { captured.push({ msg, def }); return (def || '') + '＋更冷一点'; };
    const revise1 = document.querySelector('#ai-revise');
    console.log('[1] #ai-revise visible?', !!revise1 && !revise1.classList.contains('hidden'));
    revise1.click();
    await sleep(150);
    console.log('[1] 重提后 genCount =', genCount, '| prompt.def =', JSON.stringify(captured[0] && captured[0].def));
    console.log('[1] 预填正确(=方向：震惊向)?', (captured[0] && captured[0].def) === '方向：震惊向');

    // 第二次重提：prompt 应预填「方向：震惊向＋更冷一点」（上次重提后的内容）
    document.querySelector('#ai-revise').click();
    await sleep(150);
    console.log('[2] 二次重提 genCount =', genCount, '| prompt.def =', JSON.stringify(captured[1] && captured[1].def));
    console.log('[2] 预填正确(=上一次重提内容)?', (captured[1] && captured[1].def) === '方向：震惊向＋更冷一点');

    process.exit(0);
  } catch (e) {
    console.log('REPRO ERROR:', e.message, '\n', e.stack);
    process.exit(1);
  }
}, 500);
