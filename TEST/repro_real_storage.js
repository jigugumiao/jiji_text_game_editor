require('fake-indexeddb/auto');
// 最小 localStorage 垫片（storage.js 项目注册表用）
const _ls = {};
global.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; },
};
const path = require('path');
const Storage = require(path.resolve(__dirname, '..', 'js', 'storage.js'));

// 直接用底层 IndexedDB 写入「项目系统加入前」的数据（key 无前缀，模拟老版本导入）
async function seedRaw(key, obj) {
  const req = indexedDB.open('story-editor', 1);
  await new Promise((res, rej) => {
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => res(); req.onerror = () => rej(req.error);
  });
  const db = req.result;
  await new Promise((res, rej) => {
    const tx = db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put(Object.assign({ key }, obj));
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

async function scenario(name, seeds) {
  console.log('\n========== 场景: ' + name + ' ==========');
  for (const s of seeds) await seedRaw(s.key, s.obj);
  await Storage.migrateLegacyIfNeeded();
  const projId = Storage.getCurrentProjectId();
  Storage.setCurrentProject(projId);
  console.log('当前项目:', projId);
  const bg = await Storage.getAllAssets('background');
  const it = await Storage.getAllAssets('item');
  const mu = await Storage.getAllAssets('music');
  const so = await Storage.getAllAssets('sound');
  console.log('  background:', bg.length, bg.map(a => a.id + '/' + a.name));
  console.log('  item:', it.length, it.map(a => a.id + '/' + a.name));
  console.log('  music:', mu.length, mu.map(a => a.id + '/' + a.name));
  console.log('  sound:', so.length);
}

(async () => {
  // 场景1：最老形态——key 无前缀、无 lib、无 id（项目系统前导入）
  await scenario('老数据(无前缀/无lib/无id)', [
    { key: 'background:bg1', obj: { name: '天空', kind: 'image', src: 'data:image/png;base64,xx' } },
    { key: 'music:m1', obj: { name: 'BGM', src: 'data:audio/mp3;base64,yy' } },
    { key: 'item:it1', obj: { name: '宝箱', glb: 'data:model/gltf', exitMesh: null } },
  ]);
})().catch(e => { console.error('!! REJECT:', e && e.stack || e); });
