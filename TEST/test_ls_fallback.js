// 验证 storage.js 的两种存储后端：IndexedDB（线上）与 localStorage 回退（file:// 双击）
require('fake-indexeddb/auto');

function mockLS() {
  const m = {};
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    key: i => Object.keys(m)[i],
    get length() { return Object.keys(m).length; },
  };
}

(async () => {
  // ===== 场景 A：线上 http(s)，IndexedDB 可用 =====
  delete global.location;
  global.localStorage = mockLS();
  delete require.cache[require.resolve('../js/storage.js')];
  const S1 = require('../js/storage.js');
  await S1.setCurrentProject('proj_online');
  await S1.saveAsset('background', { id: 'bg1', name: '天空', kind: 'image', src: 'data:image/x' });
  await S1.saveAsset('music', { id: 'm1', name: 'BGM', src: 'data:audio/x' });
  const bgA = await S1.getAllAssets('background');
  const mA = await S1.getAllAssets('music');
  await S1.deleteAsset('background', 'bg1');
  const bgA2 = await S1.getAllAssets('background');
  console.log('场景A(IndexedDB)  bg=%d music=%d 删后bg=%d', bgA.length, mA.length, bgA2.length);

  // ===== 场景 B：本地 file:// 双击打开，自动回退 localStorage =====
  global.location = { protocol: 'file:' };
  global.localStorage = mockLS(); // 新命名空间，模拟独立 file:// origin
  delete require.cache[require.resolve('../js/storage.js')];
  const S2 = require('../js/storage.js');
  await S2.setCurrentProject('proj_local');
  await S2.saveAsset('background', { id: 'bg2', name: '海', kind: 'image', src: 'data:image/y' });
  await S2.saveAsset('item', { id: 'it2', name: '宝箱', glb: 'data:glb' });
  const bgB = await S2.getAllAssets('background');
  const itB = await S2.getAllAssets('item');
  const muB = await S2.getAllAssets('music'); // 应空
  await S2.deleteAsset('item', 'it2');
  const itB2 = await S2.getAllAssets('item');
  console.log('场景B(file://回退) bg=%d item=%d music=%d 删后item=%d', bgB.length, itB.length, muB.length, itB2.length);

  // 断言
  const ok = bgA.length === 1 && mA.length === 1 && bgA2.length === 0
    && bgB.length === 1 && itB.length === 1 && muB.length === 0 && itB2.length === 0;
  console.log(ok ? 'PASS ✅ 两路存储均正常' : 'FAIL ❌');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(2); });
