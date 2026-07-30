const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const fidb = require('fake-indexeddb');
const indexedDB = fidb.indexedDB || (fidb.default && fidb.default.indexedDB);
const IDBKeyRange = fidb.IDBKeyRange || (fidb.default && fidb.default.IDBKeyRange);

const DIR = 'C:/CH_ZAWU/vibecoding工具/剧情编辑器';
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const storageJs = fs.readFileSync(path.join(DIR, 'js/storage.js'), 'utf8');
const editorJs = fs.readFileSync(path.join(DIR, 'js/editor.js'), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file://' + DIR + '/', pretendToBeVisual: true });
const w = dom.window;
w.indexedDB = indexedDB;
w.IDBKeyRange = IDBKeyRange;
if (!w.localStorage) {
  const store = {};
  w.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => w.document.querySelector(s);

(async () => {
  w.eval(storageJs);
  console.log('[1] Storage 加载:', typeof w.Storage);
  w.eval(editorJs); // 触发 init() -> migrateLegacyIfNeeded -> renderProjectsScreen
  await sleep(400);

  // 确保已迁移（建默认项目）
  await w.Storage.migrateLegacyIfNeeded();
  await sleep(100);

  const projects = w.Storage.listProjects();
  console.log('[2] 项目列表:', projects.map(p => p.id));
  const pid = projects[0].id;

  // ===== 形态 B：模拟「项目系统前导入的无前缀老数据」 =====
  // 把当前项目临时置空，使 saveAsset 写入无前缀 key（与老数据一致）
  w.Storage.setCurrentProject(null);
  await w.Storage.saveAsset('background', { id: 'bg1', name: '天空', src: 'data:image/png;base64,iVBORw0KGgo=' });
  await w.Storage.saveAsset('background', { id: 'bg2', name: '森林', src: 'data:image/png;base64,iVBORw0KGgo='' });
  console.log('[3] 已写入 2 条无前缀老数据');

  // 打开默认项目（触发 openProject -> renderLibrary）
  const openBtn = $('.btn-p-open');
  console.log('[4] 项目打开按钮存在:', !!openBtn);
  if (openBtn) openBtn.click();

  await sleep(600); // 等 getAllAssets 异步渲染卡片

  const panel = $('#lib-panel');
  const cards = panel ? panel.querySelectorAll('.asset-card') : [];
  console.log('==== 形态B(无前缀老数据) 渲染卡片数:', cards.length, '====');
  if (cards.length === 0 && panel) {
    console.log('---- #lib-panel 实际内容(前300字符) ----');
    console.log(panel.innerHTML.slice(0, 300));
  } else {
    console.log('---- 卡片名称 ----');
    cards.forEach(c => {
      const nm = c.querySelector('.asset-name');
      console.log('  *', nm ? nm.textContent : '(无name)');
    });
  }

  // ===== 对照：形态 A（当前项目正常写入带前缀数据）=====
  const panel2 = $('#lib-panel');
  console.log('\n[5] 当前 _projectId =', w.Storage.getCurrentProjectId());
})().catch(e => { console.error('TEST ERROR:', e); });
