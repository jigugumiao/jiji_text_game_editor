// 复现假设：旧版素材记录不含 lib 字段（且可能不含 id），当前 getAllAssets 用 r.lib===lib 过滤会全部漏掉。
const _ls = {};
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
};

// 暴露底层 dbs 以便注入"旧版"记录
const _dbs = {};
function makeDB() {
  const stores = {};
  return {
    objectStoreNames: { contains: (n) => !!stores[n] },
    createObjectStore: (n) => { stores[n] = new Map(); },
    _stores: stores,
    transaction: (store, mode) => {
      const tx = { oncomplete: null, onerror: null };
      const fireDone = () => setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 1);
      tx.objectStore = (n) => {
        const m = stores[n];
        return {
          put: (v) => { m.set(v.key, JSON.parse(JSON.stringify(v))); const r = { onsuccess: null, onerror: null, _fire(){ this.onsuccess && this.onsuccess(); } }; setTimeout(()=>r._fire(),0); fireDone(); return r; },
          get: (k) => { const r = { result: m.has(k)?JSON.parse(JSON.stringify(m.get(k))):undefined, onsuccess:null, onerror:null, _fire(){ this.onsuccess && this.onsuccess({target:this}); } }; setTimeout(()=>r._fire(),0); fireDone(); return r; },
          getAll: () => { const a=[]; for(const v of m.values()) a.push(JSON.parse(JSON.stringify(v))); const r={result:a, onsuccess:null, onerror:null, _fire(){ this.onsuccess && this.onsuccess({target:this}); }}; setTimeout(()=>r._fire(),0); fireDone(); return r; },
          delete: (k) => { m.delete(k); const r={onsuccess:null,onerror:null,_fire(){this.onsuccess&&this.onsuccess();}}; setTimeout(()=>r._fire(),0); fireDone(); return r; },
        };
      };
      return tx;
    },
  };
}
global.indexedDB = {
  open(name, ver) {
    const req = { result: null, error: null, onsuccess: null, onupgradeneeded: null };
    setTimeout(() => {
      let db = _dbs[name]; const isNew = !db; if (isNew) { db = makeDB(); _dbs[name] = db; }
      req.result = db;
      if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
      if (req.onsuccess) req.onsuccess({ target: { result: db } });
    }, 0);
    return req;
  },
};

const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');
global.window = global; global.module = undefined;
eval(code);
const Storage = global.Storage;

(async () => {
  // 先触发 openDB（建好 stores），再注入"旧版"记录：无 lib、无 id
  await Storage.getAllAssets('background'); // 仅用于初始化 DB
  const assetsStore = _dbs['story-editor']._stores['assets'];
  assetsStore.set('background:bg1', { key: 'background:bg1', name: '天空', kind: 'image', src: 'data:image/x' });
  assetsStore.set('music:m1', { key: 'music:m1', name: 'BGM', src: 'data:audio/x' });
  assetsStore.set('item:it1', { key: 'item:it1', name: '宝箱', glb: 'data:glb' });
  console.log('已注入 3 条旧版记录（无 lib / 无 id）, 当前 store 大小:', assetsStore.size);

  await Storage.migrateLegacyIfNeeded();
  const curId = Storage.getCurrentProjectId();
  console.log('当前项目 id:', curId);
  Storage.setCurrentProject(curId);
  const bg = await Storage.getAllAssets('background');
  const music = await Storage.getAllAssets('music');
  const items = await Storage.getAllAssets('item');
  console.log('背景库:', bg.length, bg.map(a=>a.name));
  console.log('音乐库:', music.length, music.map(a=>a.name));
  console.log('物品库:', items.length, items.map(a=>a.name));
  if (bg.length === 0) console.log('\n❌ 复现成功：旧版记录因缺 lib 字段被过滤，素材不显示');
  else console.log('\n✅ 当前逻辑能显示旧版记录');
})().catch(e => { console.error('异常:', e); });
