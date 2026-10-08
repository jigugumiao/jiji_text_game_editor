const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const storagePath = path.join(__dirname, '..', 'js', 'storage.js');
const source = fs.readFileSync(storagePath, 'utf8');

for (const name of ['saveDialoguePreset', 'getAllDialoguePresets', 'deleteDialoguePreset', 'renameDialoguePreset']) {
  assert.match(source, new RegExp('async function ' + name + '\\('), name + ' must be an async storage API');
}

assert.match(source, /function _editorNamespace\(\)\s*\{[\s\S]*?window\.STORY_EDITOR_NS === 'test'[\s\S]*?return 'test:'[\s\S]*?return '';/, 'test builds need their own dialogue-preset namespace');
assert.match(source, /function _dialoguePresetKey\(id\)\s*\{\s*return _editorNamespace\(\) \+ 'dialogue-preset:' \+ id;\s*\}/, 'preset keys must be global and only editor-namespaced');
assert.match(source, /type:\s*'dialogue-preset'/, 'preset records must be explicitly typed');
assert.match(source, /uid\('gal'\)/, 'new preset IDs must use the gal prefix');
assert.match(source, /localeCompare\([\s\S]*?'zh-CN'\)/, 'preset listing must use Chinese name sorting');

function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function createIndexedDb() {
  const stores = new Map([['assets', new Map()], ['meta', new Map()]]);
  const database = {
    objectStoreNames: { contains(name) { return stores.has(name); } },
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name) {
      const records = stores.get(name);
      const tx = { error: null, oncomplete: null, onerror: null };
      const complete = () => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
      const request = (result) => {
        const r = { result: undefined, onsuccess: null, onerror: null };
        queueMicrotask(() => { r.result = copy(result); if (r.onsuccess) r.onsuccess(); });
        return r;
      };
      tx.objectStore = () => ({
        put(value) { records.set(value.key, copy(value)); complete(); },
        get(key) { return request(records.get(key)); },
        getAll() { return request(Array.from(records.values())); },
        delete(key) { records.delete(key); complete(); },
      });
      return tx;
    },
  };
  return { open() {
    const req = { result: database, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => { if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); });
    return req;
  } };
}

async function main() {
  delete require.cache[require.resolve('../js/storage.js')];
  global.window = {};
  global.indexedDB = createIndexedDb();
  const Storage = require('../js/storage.js');
  for (const name of ['saveDialoguePreset', 'getAllDialoguePresets', 'deleteDialoguePreset', 'renameDialoguePreset']) {
    assert.equal(typeof Storage[name], 'function', name + ' must be exported from CommonJS');
    assert.strictEqual(window.Storage[name], Storage[name], name + ' must be exposed through window.Storage');
  }

  const input = { name: '  乙  ', slices: { left: 12 } };
  const betaId = await Storage.saveDialoguePreset(input);
  assert.match(betaId, /^gal_/, 'a missing id receives a gal id');
  assert.deepEqual(input, { name: '  乙  ', slices: { left: 12 } }, 'saving never mutates the caller preset');
  const alphaId = await Storage.saveDialoguePreset({ id: 'alpha', name: '甲', slices: { right: 8 } });
  assert.equal(alphaId, 'alpha');
  const listed = await Storage.getAllDialoguePresets();
  assert.deepEqual(listed.map(preset => preset.name), ['甲', '乙']);
  listed[0].slices.right = 99;
  assert.equal((await Storage.getAllDialoguePresets())[0].slices.right, 8, 'listed presets are independent copies');

  const renamed = await Storage.renameDialoguePreset('alpha', '   ');
  assert.equal(renamed.name, '甲', 'blank rename preserves the existing name');
  renamed.preset.slices.right = 77;
  assert.equal((await Storage.getAllDialoguePresets())[0].slices.right, 8, 'rename result has no persistent aliases');
  await assert.rejects(() => Storage.renameDialoguePreset('missing', '不存在'), /预设不存在/);

  window.STORY_EDITOR_NS = 'test';
  await Storage.saveDialoguePreset({ id: 'same-id', name: '测试预设' });
  assert.deepEqual((await Storage.getAllDialoguePresets()).map(preset => preset.name), ['测试预设'], 'test namespace does not see production records');
  await Storage.deleteDialoguePreset('same-id');
  delete window.STORY_EDITOR_NS;
  assert.deepEqual((await Storage.getAllDialoguePresets()).map(preset => preset.name), ['甲', '乙'], 'test deletion cannot delete production records');

  delete global.indexedDB;
  delete global.window;
  console.log('dialogue preset storage contract passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
