const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const TimeMachine = require('../js/time-machine.js');

function makeDatabase() {
  const stores = new Map();
  const service = { failure: null, stores, opened: [] };
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: name => stores.set(name, new Map()),
    close() {},
    transaction(name, mode) {
      const records = new Map(structuredClone(Array.from(stores.get(name))));
      let finished = false;
      const tx = {
        error: null,
        abort() {
          if (finished) return;
          finished = true;
          queueMicrotask(() => { if (tx.onabort) tx.onabort(); });
        }
      };
      function request(result) {
        const req = {};
        queueMicrotask(() => {
          if (finished) return;
          if (service.failure === 'read:' + name) {
            req.error = tx.error = new Error('injected read failure');
            if (req.onerror) req.onerror();
            if (tx.onerror) tx.onerror();
            tx.abort(); return;
          }
          req.result = structuredClone(result);
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      }
      tx.objectStore = () => ({
        get: key => request(records.get(key)),
        getAll: () => request(Array.from(records.values())),
        put(value) { records.set(value.key, structuredClone(value)); },
        delete(key) { records.delete(key); }
      });
      setImmediate(() => {
        if (finished) return;
        if (mode === 'readwrite' && service.failure === name) {
          tx.error = new Error('injected ' + name + ' transaction failure');
          if (tx.onerror) tx.onerror();
          tx.abort();
        } else {
          finished = true;
          if (mode === 'readwrite') stores.set(name, records);
          if (tx.oncomplete) tx.oncomplete();
        }
      });
      return tx;
    }
  };
  service.open = (name, version) => {
    service.opened.push([name, version]);
    const req = { result: db };
    queueMicrotask(() => { if (req.onupgradeneeded) req.onupgradeneeded(); if (req.onsuccess) req.onsuccess(); });
    return req;
  };
  return service;
}

function makeStorage(database, namespace, local) {
  const source = fs.readFileSync(path.join(__dirname, '../js/storage.js'), 'utf8');
  const sandbox = {
    window: { STORY_EDITOR_NS: namespace }, indexedDB: database,
    localStorage: local, console, Date, Math, Promise, module: { exports: {} }
  };
  vm.runInNewContext(source, sandbox);
  return sandbox.module.exports;
}

async function storageChecks() {
  const values = new Map();
  let failKey = null;
  const local = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) { if (key === failKey) { failKey = null; throw new Error('quota failure'); } values.set(key, String(value)); },
    removeItem: key => values.delete(key)
  };
  const database = makeDatabase();
  const S = makeStorage(database, 'test', local);
  const pid = S.createProject('完整项目', 'article');
  S.setCurrentProject(pid);
  S.setBlockText('__MAIN__', '旧主剧情');
  S.setBlockText('结局', '<选项:"二周目",__MAIN__>');
  S.saveVars([{ name: '金币', type: 'number', value: 10 }]);
  await S.saveMeta({ creation: { world: '世界设定' }, appearance: { galPanel: { imageSrc: 'data:image/png;base64,old' } } });
  await S.saveAsset('background', { id: 'bg1', name: '背景', src: 'data:image/png;base64,old' });
  const original = JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid)));
  const first = await S.createTimeMachineBackup(pid, 'manual');
  const focused = await S.createTimeMachineBackup(pid, 'auto', { block: '__MAIN__', text: '正在输入的草稿' });
  assert.equal(JSON.parse(database.stores.get('backups').get('snapshot:' + pid + ':' + focused.id).snapshot.data.blocks).main, '正在输入的草稿');
  assert.deepEqual(JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid))), original, '草稿快照不能改写实时项目');
  S.setBlockText('__MAIN__', '新主剧情');
  S.setBlockText('新增', '新增块');
  await S.saveAsset('background', { id: 'bg1', name: '背景', src: 'data:image/png;base64,new' });
  await S.saveAsset('sound', { id: 'new', name: '新音效', src: 'data:audio/wav;base64,new' });
  S.saveVars([]); await S.saveMeta({ changed: true });
  S.renameProject(pid, '现在的项目');
  const current = JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid)));
  const otherId = S.createProject('其他项目', 'game');
  S.setCurrentProject(otherId); S.setBlockText('__MAIN__', '不能被恢复影响');
  await S.restoreTimeMachineBackup(pid, first.id);
  assert.equal(S.getCurrentProjectId(), otherId, '存储恢复不能偷偷切换项目');
  assert.equal(S.getBlockText('__MAIN__'), '不能被恢复影响');
  assert.deepEqual(JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid))), original, '恢复覆盖全部块、设置、变量与素材，并移除新增内容');
  assert.equal(S.getProjectName(pid), '完整项目');
  assert.equal(S.getProjectMode(pid), 'article');
  const history = await S.listTimeMachineBackups(pid);
  assert.equal(history[0].reason, 'before-restore');
  await S.restoreTimeMachineBackup(pid, history[0].id);
  assert.deepEqual(JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid))), current, '恢复前备份能找回恢复前的完整内容');

  database.failure = 'assets';
  await assert.rejects(() => S.restoreTimeMachineBackup(pid, first.id), /transaction failure/);
  database.failure = null;
  assert.deepEqual(JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid))), current, '素材事务失败时 localStorage 和素材都回退');
  assert.equal(S.getProjectName(pid), '现在的项目');
  failKey = 'test:story-editor:meta:' + pid;
  await assert.rejects(() => S.restoreTimeMachineBackup(pid, first.id), /quota failure/);
  assert.deepEqual(JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid))), current, '正文写入失败必须回滚整个恢复');

  const beforeFailedBackup = JSON.parse(JSON.stringify(await S.listTimeMachineBackups(pid)));
  database.failure = 'read:assets';
  await assert.rejects(() => S.createTimeMachineBackup(pid), /读取项目素材失败/);
  database.failure = 'backups';
  await assert.rejects(() => S.createTimeMachineBackup(pid), /transaction failure/);
  await assert.rejects(() => S.restoreTimeMachineBackup(pid, first.id), /transaction failure/);
  database.failure = null;
  assert.deepEqual(JSON.parse(JSON.stringify(await S.listTimeMachineBackups(pid))), beforeFailedBackup);
  assert.deepEqual(JSON.parse(JSON.stringify(await S.readProjectSnapshot(pid))), current, '恢复前备份失败时禁止恢复');
  assert.deepEqual(database.opened, [['test:story-editor', 1], ['test:story-editor:time-machine', 1]], '备份不能升级旧素材数据库或阻塞旧标签页');

  for (let i = 0; i < 35; i++) await S.createTimeMachineBackup(pid);
  const retained = await S.listTimeMachineBackups(pid);
  assert.equal(retained.length, 30);
  const last = retained[29];
  await S.restoreTimeMachineBackup(pid, last.id);
  assert.equal((await S.listTimeMachineBackups(pid)).length, 30, '恢复最旧一条不会被恢复前备份的淘汰影响');
  await assert.rejects(() => S.restoreTimeMachineBackup(pid, first.id), /已过期/);
  assert.equal(Array.from(database.stores.get('backups').values()).filter(x => x.snapshot).length, 30, '旧快照素材也必须一起淘汰');
  const production = makeStorage(makeDatabase(), '', local);
  assert.equal((await production.listTimeMachineBackups(pid)).length, 0, '正式版与测试版隔离');
  await S.deleteProject(pid);
  assert.equal((await S.listTimeMachineBackups(pid)).length, 0);
}

async function schedulerChecks() {
  let time = 0, next = 0;
  const timers = new Map(), calls = [], status = [];
  const controller = TimeMachine.createController({
    now: () => time,
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    flush: pid => calls.push(['flush', pid]),
    backup: async (pid, reason) => { calls.push(['backup', pid, reason]); return { id: reason }; },
    onStatus: (error, result) => status.push([error, result])
  });
  assert.equal(TimeMachine.INTERVAL_MS, 180000);
  await controller.start('A');
  assert.deepEqual(calls, [['flush', 'A'], ['backup', 'A', 'open']]);
  time = 179999; await controller.checkDue(); assert.equal(calls.length, 2);
  time = 180000; await controller.checkDue(); assert.deepEqual(calls.slice(-2), [['flush', 'A'], ['backup', 'A', 'auto']]);
  await controller.backupNow(); assert.equal(calls.at(-1)[2], 'manual');
  await controller.start('B'); time = 1000000; await controller.checkDue();
  assert.equal(calls.at(-1)[1], 'B', '后台补备份只处理当前项目');
  await controller.stop(); const count = calls.length;
  time += 180000; await controller.checkDue(); await controller.backupNow();
  assert.equal(calls.length, count, '退出编辑器后停止备份'); assert.equal(timers.size, 0);

  let release, active = 0, maximum = 0;
  const slow = TimeMachine.createController({
    setTimeout: () => 1, clearTimeout() {}, flush() {},
    backup: async pid => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => { release = resolve; }); active--; return { pid }; }
  });
  const opening = slow.start('old');
  const switching = slow.start('new');
  release(); await opening;
  await new Promise(resolve => setImmediate(resolve)); release(); await switching;
  assert.equal(maximum, 1, '切项目时不交叠执行备份'); await slow.stop();
}

(async () => { await storageChecks(); await schedulerChecks(); console.log('time-machine tests passed'); })().catch(error => { console.error(error); process.exitCode = 1; });
