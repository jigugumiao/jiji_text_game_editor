// 验证：在 file:// 协议下（_useLS 默认 false），大素材走 IndexedDB 而非 localStorage，不超配额。
require('fake-indexeddb/auto');

// 内存版 localStorage（仅用于项目/剧情等小数据；素材不走它）
const _ls = {};
global.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; },
  key: i => Object.keys(_ls)[i] ?? null,
  get length() { return Object.keys(_ls).length; },
};
// 模拟“双击本地文件”打开
global.location = { protocol: 'file:' };
global.window = undefined;

const Storage = require('C:/CH_ZAWU/vibecoding工具/剧情编辑器/js/storage.js');

(async () => {
  await Storage.migrateLegacyIfNeeded();
  const projects = Storage.listProjects();
  const pid = projects[0].id;
  Storage.setCurrentProject(pid);

  // 5MB 的伪 dataURL（超过 localStorage ~5MB 上限）—— 此前会触发 quota 报错
  const big = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024);
  await Storage.saveAsset('background', { name: '噪波测试', kind: 'noise', src: big });

  const all = await Storage.getAllAssets('background');
  console.log('background 素材数:', all.length, '| 名称:', all[0] && all[0].name);

  // 关键断言：素材没走 localStorage 回退（localStorage 里不应出现 story-editor:idb: 键）
  const lsKeys = Object.keys(_ls).filter(k => k.indexOf('story-editor:idb:') === 0);
  console.log('localStorage 中的 idb 回退键数(应为0):', lsKeys.length);

  // 再存一个 GLB 大文件验证 item 库
  const glb = 'data:model/gltf-binary;base64,' + 'B'.repeat(3 * 1024 * 1024);
  await Storage.saveAsset('item', { name: '宝箱', glb });
  const items = await Storage.getAllAssets('item');
  console.log('item 素材数:', items.length, '| 名称:', items[0] && items[0].name);

  console.log(all.length === 1 && items.length === 1 && lsKeys.length === 0
    ? '\n✅ 通过：file:// 下大素材经 IndexedDB 正常存取，不再走 localStorage、不再 quota 报错'
    : '\n❌ 失败');
  process.exit(0);
})().catch(e => { console.error('报错:', e); process.exit(1); });
