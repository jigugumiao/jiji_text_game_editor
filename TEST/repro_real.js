// 用真实 IndexedDB(fake-indexeddb) 跑 storage.js 真实逻辑
// 模拟"老格式素材"：key 无命名空间前缀、且缺 lib / id 字段
require('fake-indexeddb/auto');

// 内存版 localStorage 给 storage.js 用
const _ls = {};
global.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; },
  clear: () => { for (const k in _ls) delete _ls[k]; },
};

const path = require('path');
const Storage = require(path.join(__dirname, '..', 'js', 'storage.js'));

(async () => {
  // 1) 模拟"旧版"已存在的素材：无前缀、无 lib、无 id
  const openReq = indexedDB.open('story-editor', 1);
  await new Promise((res, rej) => {
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    openReq.onsuccess = res; openReq.onerror = () => rej(openReq.error);
  });
  const db = openReq.result;
  const tx = db.transaction('assets', 'readwrite');
  const store = tx.objectStore('assets');
  store.put({ key: 'background:bg1', name: '天空', kind: 'image', src: 'data:image/png;base64,AAA' });
  store.put({ key: 'item:it1', name: '宝箱', kind: 'glb', glb: 'data:model/glb,BBB' });
  store.put({ key: 'music:m1', name: 'BGM', kind: 'audio', src: 'data:audio/mp3;base64,CCC' });
  store.put({ key: 'sound:s1', name: '点击音', kind: 'audio', src: 'data:audio/wav;base64,DDD' });
  await new Promise(res => { tx.oncomplete = res; });
  console.log('已注入 4 条老格式记录（无前缀 / 无 lib / 无 id）');

  // 2) 迁移（首次启动）
  await Storage.migrateLegacyIfNeeded();

  // 3) 打开默认项目（与真实 openProject 一致）
  const projects = Storage.listProjects();
  console.log('项目列表:', projects.map(p => p.id + ':' + p.name));
  Storage.setCurrentProject(projects[0].id);

  // 4) 读四库
  for (const lib of ['background', 'item', 'music', 'sound']) {
    try {
      const arr = await Storage.getAllAssets(lib);
      console.log(`[${lib}] 读到 ${arr.length} 条:`, arr.map(a => a.name).join(', ') || '(空)');
    } catch (e) {
      console.log(`[${lib}] 抛错:`, e.message);
    }
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
