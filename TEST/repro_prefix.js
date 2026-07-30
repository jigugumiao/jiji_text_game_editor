// 模拟真实用户场景：已打开项目(_projectId 非空) + 旧素材 key 无命名空间前缀（迁移未生效）
// 验证 v25.1.2 的「lib 修复」为何无效，以及本次「前缀兜底」修复是否生效。
const fs = require('fs');

// ---- localStorage mock ----
const lsMap = new Map();
global.localStorage = {
  getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: k => lsMap.delete(k),
};

// ---- IndexedDB mock (faithful to storage.js 用到的 API) ----
function makeStore() {
  const m = new Map();
  return {
    m,
    put(v){ m.set(v.key, JSON.parse(JSON.stringify(v))); },
    get(k){ return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined; },
    getAll(){ return Array.from(m.values()).map(v=>JSON.parse(JSON.stringify(v))); },
    delete(k){ m.delete(k); },
  };
}
const dbs = {};
global.__IDB__ = dbs;
global.indexedDB = {
  open(name, ver) {
    const req = { result: null, error: null, onsuccess: null, onupgradeneeded: null };
    setTimeout(() => {
      let db = dbs[name];
      if (!db) {
        const stores = { assets: makeStore(), meta: makeStore() };
        db = {
          objectStoreNames: { contains: (n) => !!stores[n] },
          assets: stores.assets,
          meta: stores.meta,
          transaction: (store, mode) => {
            const s = stores[store];
            const tx = {
              objectStore: () => ({
                put: (v) => { s.put(v); const r = { onsuccess:null }; setTimeout(()=>r.onsuccess&&r.onsuccess(),0); return r; },
                get: (k) => { const r = { result: s.get(k), onsuccess:null }; setTimeout(()=>r.onsuccess&&r.onsuccess({target:r}),0); return r; },
                getAll: () => { const r = { result: s.getAll(), onsuccess:null }; setTimeout(()=>r.onsuccess&&r.onsuccess({target:r}),0); return r; },
                delete: (k) => { s.delete(k); const r = { onsuccess:null }; setTimeout(()=>r.onsuccess&&r.onsuccess(),0); return r; },
              }),
              oncomplete: null, onerror: null,
            };
            setTimeout(()=>tx.oncomplete&&tx.oncomplete(),0);
            return tx;
          },
        };
        dbs[name] = db;
      }
      if (req.onupgradeneeded && !db._upgraded) { db._upgraded = true; req.result = db; req.onupgradeneeded({ target: { result: db } }); }
      req.result = db;
      if (req.onsuccess) req.onsuccess({ target: { result: db } });
    }, 0);
    return req;
  },
};

const Storage = require('C:/CH_ZAWU/vibecoding工具/剧情编辑器/js/storage.js');

(async () => {
  // 模拟「已打开项目」：projects 注册表已有默认项目（迁移逻辑的 defaultId = projects[0].id）
  const projId = 'proj_OLD';
  localStorage.setItem('story-editor:projects', JSON.stringify([{ id: projId, name: '默认项目', createdAt: Date.now() }]));
  localStorage.setItem('story-editor:current', projId);
  Storage.setCurrentProject(projId);

  // 先触发一次 openDB，等待底层 db 建立（mock 的 open 是异步的）
  await Storage.getAllAssets('item');
  await new Promise(r => setTimeout(r, 10));

  // 直接往底层 IDB 写入「旧版无前缀、无 lib」素材，模拟迁移未生效（openDB 异步失败被吞）的真实用户数据
  const db = global.__IDB__['story-editor'];
  db['assets'].put({ key: 'background:bg1', name: '天空', kind: 'image', src: 'data:image/png;base64,xxx' });
  db['assets'].put({ key: 'music:m1', name: 'BGM', src: 'data:audio/mp3;base64,yyy' });

  const bg = await Storage.getAllAssets('background');
  const music = await Storage.getAllAssets('music');
  const item = await Storage.getAllAssets('item');
  console.log('【读取】background 数:', bg.length, '| music 数:', music.length, '| item 数:', item.length);
  console.log('   background[0]:', bg[0] ? (bg[0].id + ':' + bg[0].name) : '(空)');

  // 删除旧记录测试（修复前用 _assetKey 删 proj_OLD::background:bg1，删不掉真实 key background:bg1）
  await Storage.deleteAsset('background', 'bg1');
  const bgAfter = await Storage.getAllAssets('background');
  console.log('【删除】删 background:bg1 后 剩余数:', bgAfter.length, '(应为 0)');

  // 新记录（saveAsset 会写带前缀 key）保存+读取
  await Storage.saveAsset('item', { name: '宝箱', glb: 'data:glb' });
  const items = await Storage.getAllAssets('item');
  console.log('【新增】item 数:', items.length, items.map(a=>a.id));
})();
