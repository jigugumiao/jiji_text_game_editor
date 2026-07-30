// 复现 storage.js 的迁移 + 按项目读取逻辑，验证素材是否可见
// 用最小桩模拟 localStorage 与 indexedDB

// ---- 桩：localStorage ----
const _ls = {};
global.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
};

// ---- 桩：indexedDB（内存版，支持 storage.js 用到的 API） ----
function makeIDB() {
  const stores = {}; // name -> Map(key, value)
  function ensure(name) { if (!stores[name]) stores[name] = new Map(); return stores[name]; }
  function createReq(result, ok) {
    const r = { result, error: null,
      onsuccess: null, onerror: null,
      _fire() { if (this.onsuccess) this.onsuccess({ target: this }); },
      _fail(e) { this.error = e; if (this.onerror) this.onerror({ target: this }); },
    };
    return r;
  }
  const api = {
    open(name, ver) {
      const req = createReq(null, true);
      // 模拟 onupgradeneeded
      setTimeout(() => {
        api._db = { objectStoreNames: { contains: (n) => !!stores[n] }, createObjectStore: (n) => { ensure(n); } };
        if (req.onupgradeneeded) req.onupgradeneeded({ target: { result: api._db } });
        if (req.onsuccess) req.onsuccess({ target: { result: api._db } });
      }, 0);
      return req;
    },
  };
  api._getDB = () => api._db;
  api._tx = (store, mode) => ({
    objectStore: (n) => {
      const m = ensure(n);
      return {
        put: (value) => { m.set(value.key, JSON.parse(JSON.stringify(value))); const r = createReq(undefined, true); setTimeout(() => r._fire(), 0); return r; },
        get: (key) => { const r = createReq(m.has(key) ? JSON.parse(JSON.stringify(m.get(key))) : undefined, true); setTimeout(() => r._fire(), 0); return r; },
        getAll: () => { const arr = []; for (const v of m.values()) arr.push(JSON.parse(JSON.stringify(v))); const r = createReq(arr, true); setTimeout(() => r._fire(), 0); return r; },
        delete: (key) => { m.delete(key); const r = createReq(undefined, true); setTimeout(() => r._fire(), 0); return r; },
      };
    },
    oncomplete: null,
    onerror: null,
    _fire() { if (this.oncomplete) this.oncomplete(); },
  });
  return api;
}

// ---- 加载 storage.js ----
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8');

// 注入全局 indexedDB 桩
global.indexedDB = (function () {
  const dbs = {};
  return {
    open(name, ver) {
      const req = { result: null, error: null, onsuccess: null, onupgradeneeded: null };
      setTimeout(() => {
        let db = dbs[name];
        const isNew = !db;
        if (isNew) db = makeDB();
        req.result = db; // 关键：先设置 result
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: { result: db } });
        if (req.onsuccess) req.onsuccess({ target: { result: db } });
      }, 0);
      return req;
    },
  };
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
})();

// 运行 storage.js（它会在 global 上挂 window.Storage）
global.window = global;
global.module = undefined;
eval(code);
const Storage = global.Storage;

(async () => {
  console.log('== 模拟：旧版已有一批无命名空间素材 ==');
  // 直接用底层 idbPut 写几条"旧版"素材（key 不含 ::）
  // 通过 Storage 的 saveAsset 会加命名空间，这里手动写底层模拟旧数据
  await Storage._rawPutLegacy && Storage._rawPutLegacy(); // 无此函数则跳过

  // 直接借助 idb 写旧版数据：用 Storage.saveAsset 前先清 _projectId= null
  // 简单做法：调用 openDB 后 put。storage.js 没暴露 openDB，但 saveAsset 会在 _projectId=null 时写无前缀 key。
  // 所以先把当前项目设 null
  Storage.setCurrentProject(null);
  await Storage.saveAsset('background', { id: 'bg1', name: '天空', kind: 'image', src: 'data:image/x' });
  await Storage.saveAsset('music', { id: 'm1', name: 'BGM', src: 'data:audio/x' });
  await Storage.saveAsset('item', { id: 'it1', name: '宝箱', glb: 'data:glb' });
  console.log('写入旧版素材（_projectId=null），理论上 key 无前缀');

  // 现在模拟启动：迁移
  console.log('\n== 调用 migrateLegacyIfNeeded ==');
  await Storage.migrateLegacyIfNeeded();

  // 迁移后看当前项目
  const curId = Storage.getCurrentProjectId();
  console.log('当前项目 id (LS_CURRENT):', curId);
  Storage.setCurrentProject(curId);

  // 打开默认项目后读取各库
  const bg = await Storage.getAllAssets('background');
  const music = await Storage.getAllAssets('music');
  const items = await Storage.getAllAssets('item');
  const sound = await Storage.getAllAssets('sound');
  console.log('背景库:', bg.length, bg.map(a=>a.name));
  console.log('音乐库:', music.length, music.map(a=>a.name));
  console.log('物品库:', items.length, items.map(a=>a.name));
  console.log('音效库:', sound.length, sound.map(a=>a.name));

  if (bg.length === 0) {
    console.log('\n❌ 复现成功：素材读不出来（迁移或命名空间隔离有问题）');
  } else {
    console.log('\n✅ 源码逻辑下素材能正常读出');
  }
})().catch(e => { console.error('运行异常:', e); });
