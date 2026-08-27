const assert = require('node:assert/strict');
const Converter = require('../js/project-converter.js');

assert.equal(Converter.nextConvertedName('迷雾村', []), '迷雾村（可视化版）');
assert.equal(Converter.nextConvertedName('迷雾村', [
  { name: '迷雾村（可视化版）' },
  { name: '迷雾村（可视化版 3）' },
]), '迷雾村（可视化版 2）');

const snapshot = {
  id: 'old-project',
  blocks: {
    main: '<选项:"购买钥匙",商店,条件:金币>=10,变化:金币-10>\n<变量:钥匙=true>',
    blocks: { 支线: '<选项:"开门",结局,条件:钥匙,变化:金币+1>' }
  },
  vars: [{ name: '金币', type: 'number', value: 0 }, { name: '钥匙', type: 'boolean', value: false }],
  assets: [{ lib: 'item', id: 'key' }]
};
const analysis = Converter.analyzeProjectSnapshot(snapshot);
assert.deepEqual(analysis.counts, { options: 2, stateChanges: 1, effects: 2 });
assert.deepEqual(analysis.issues, []);

const report = Converter.buildConversionReport(snapshot, analysis);
assert.deepEqual(report.counts, { options: 2, stateChanges: 1, effects: 2 });
assert.equal(report.lostContentCount, 0);
assert.deepEqual(report.issues, []);

const malformed = Converter.analyzeProjectSnapshot({
  id: 'broken', blocks: { main: '<选项:"坏选项",目标,条件:金币>', blocks: {} }, vars: []
});
assert.deepEqual(malformed.issues.map(x => [x.block, x.line]), [['__MAIN__', 1]]);

function makeAdapter(source, failure) {
  const registry = [{ id: source.id, name: '迷雾村', mode: 'game' }];
  const temporary = new Map();
  return {
    registry, temporary,
    async readProjectSnapshot(id) { assert.equal(id, source.id); return structuredClone(source); },
    async writeTemporaryProject(data, id) { if (failure === 'write') throw new Error('asset write failed'); temporary.set(id, structuredClone(data)); },
    async validateTemporaryProject(id) { if (failure === 'validate') throw new Error('validation failed'); assert.ok(temporary.has(id)); },
    async registerTemporaryProject(id, name, metadata) { if (failure === 'register') throw new Error('register failed'); registry.push({ id, name, mode: 'game', ...metadata }); },
    async cleanupTemporaryProject(id) { temporary.delete(id); },
    createId() { return 'new-project'; },
    listProjects() { return registry; }
  };
}

async function assertFailedCopy(failure) {
  const original = structuredClone(snapshot);
  const adapter = makeAdapter(original, failure);
  await assert.rejects(() => Converter.copyProjectForVisual(original.id, '迷雾村（可视化版）', adapter));
  assert.deepEqual(adapter.registry, [{ id: original.id, name: '迷雾村', mode: 'game' }]);
  assert.equal(adapter.temporary.size, 0);
  assert.deepEqual(original, snapshot);
}

(async () => {
  await assertFailedCopy('write');
  await assertFailedCopy('validate');
  const adapter = makeAdapter(snapshot);
  const result = await Converter.copyProjectForVisual(snapshot.id, '迷雾村（可视化版）', adapter);
  assert.equal(result.projectId, 'new-project');
  assert.equal(adapter.temporary.size, 1);
  assert.deepEqual(adapter.registry[1], {
    id: 'new-project', name: '迷雾村（可视化版）', mode: 'game', visualEditorVersion: 1, convertedFrom: 'old-project'
  });
  assert.deepEqual(snapshot, {
    id: 'old-project',
    blocks: { main: '<选项:"购买钥匙",商店,条件:金币>=10,变化:金币-10>\n<变量:钥匙=true>', blocks: { 支线: '<选项:"开门",结局,条件:钥匙,变化:金币+1>' } },
    vars: [{ name: '金币', type: 'number', value: 0 }, { name: '钥匙', type: 'boolean', value: false }], assets: [{ lib: 'item', id: 'key' }]
  });
  console.log('project-converter.test.js passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
