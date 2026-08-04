// js/storage.js — 数据持久化
// 素材二进制（图片/音频/GLB）存 IndexedDB；剧情结构与素材元数据存 localStorage。
// 这样即使素材很大也不会撑爆 localStorage 的 ~5MB 上限。
// 项目隔离：每个项目拥有独立命名空间（IndexedDB key 前缀 + localStorage key 后缀），互不可见。

const LIBS = ['background', 'item', 'overlay', 'music', 'sound'];

// 项目注册表 / 当前项目
const LS_PROJECTS = 'story-editor:projects';
const LS_CURRENT = 'story-editor:current';
const PROJECT_NS_SEP = '::';

// 单项目版剧情 key（带项目 id 后缀）
const LS_STORY = 'story-editor:story';        // 节点数组
const LS_STORY_TEXT = 'story-editor:story-text'; // 原始文本
const LS_META = 'story-editor:meta';          // 标题等
const LS_VARS = 'story-editor:vars';          // 变量库（名字/类型/初值）

// 剧情块系统：主剧情 + 其它剧情块。结构 { main: 文本, blocks: { 名称: 文本 } }
// 主剧情(__MAIN__) 始终存在、置顶、不可删除、游戏默认从它开始。
const LS_BLOCKS = 'story-editor:blocks';       // 剧情块集合（带项目 id 后缀）
const MAIN_BLOCK = '__MAIN__';                 // 主剧情内部名（界面显示「主剧情」）

// 旧（无项目）全局 key，用于迁移
const LS_LEGACY_STORY = 'story-editor:story';
const LS_LEGACY_STORY_TEXT = 'story-editor:story-text';
const LS_LEGACY_META = 'story-editor:meta';

const DB_NAME = 'story-editor';
const STORE_ASSETS = 'assets';
const STORE_META = 'meta';

let _projectId = null; // 当前项目 id；null 表示尚未进入任何项目

function _storyKey() { return _projectId ? (LS_STORY + ':' + _projectId) : LS_STORY; }
function _storyTextKey() { return _projectId ? (LS_STORY_TEXT + ':' + _projectId) : LS_STORY_TEXT; }
function _metaKey() { return _projectId ? (LS_META + ':' + _projectId) : LS_META; }
function _blocksKey() { return _projectId ? (LS_BLOCKS + ':' + _projectId) : LS_BLOCKS; }
function _varsKey() { return _projectId ? (LS_VARS + ':' + _projectId) : LS_VARS; }

let _dbPromise = null;
// 纯前端存储：素材二进制一律存 IndexedDB。现代浏览器（Chrome/Edge）在 file:// 协议下同样支持 IndexedDB，
// 容量远大于 localStorage，双击本地 index.html 即可正常使用，纯前端运行。
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// （已移除 localStorage 回退：纯 IndexedDB，file:// 下原生支持，纯前端运行）

// assetKey 形如 `项目id::background:bg1`（无项目时为 `background:bg1`）
function _assetKey(lib, id) {
  return _projectId ? (_projectId + PROJECT_NS_SEP + lib + ':' + id) : (lib + ':' + id);
}

// 从 asset key 推导 lib / id，兼容旧版记录缺失这两个字段的情况。
// key 可能是 `ns::background:bg1` 或 `background:bg1`。
function _libFromKey(key) {
  if (!key) return null;
  let k = key;
  const idx = k.indexOf(PROJECT_NS_SEP);
  if (idx !== -1) k = k.slice(idx + PROJECT_NS_SEP.length);
  const c = k.indexOf(':');
  return c === -1 ? null : k.slice(0, c);
}
function _idFromKey(key) {
  if (!key) return null;
  let k = key;
  const idx = k.indexOf(PROJECT_NS_SEP);
  if (idx !== -1) k = k.slice(idx + PROJECT_NS_SEP.length);
  const c = k.indexOf(':');
  return c === -1 ? k : k.slice(c + 1);
}

// 以下均为纯 IndexedDB 操作；失败时直接 reject，由调用方（编辑器）捕获并提示，不再静默降级到 localStorage。
async function idbPut(store, value) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(store, key) {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(tx.error);
  });
}
async function idbDelete(store, key) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetAll(store) {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(tx.error);
  });
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// ============ 项目 ============
function listProjects() {
  try { const a = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]'); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function _readProjects() { return listProjects(); }
function _writeProjects(arr) { localStorage.setItem(LS_PROJECTS, JSON.stringify(arr)); }

function createProject(name, mode) {
  const projects = _readProjects();
  const id = uid('proj');
  const safeName = (name && String(name).trim()) || ('项目 ' + (projects.length + 1));
  const m = mode === 'article' ? 'article' : 'game';
  projects.push({ id, name: safeName, mode: m, createdAt: Date.now() });
  _writeProjects(projects);
  return id;
}
function getProjectMode(id) {
  const p = _readProjects().find(x => x.id === id);
  // 旧项目无 mode 字段 → 默认剧情游戏
  return (p && p.mode === 'article') ? 'article' : 'game';
}
function renameProject(id, name) {
  const projects = _readProjects();
  const p = projects.find(x => x.id === id);
  if (p) { p.name = (name && String(name).trim()) || p.name; _writeProjects(projects); }
}
function getProjectName(id) {
  const p = _readProjects().find(x => x.id === id);
  return p ? p.name : '未知项目';
}
function getCurrentProjectId() { return localStorage.getItem(LS_CURRENT) || null; }
function setCurrentProject(id) {
  localStorage.setItem(LS_CURRENT, id);
  _projectId = id;
}
async function deleteProject(id) {
  const projects = _readProjects().filter(p => p.id !== id);
  _writeProjects(projects);
  // 删除该项目剧情
  localStorage.removeItem(LS_STORY + ':' + id);
  localStorage.removeItem(LS_STORY_TEXT + ':' + id);
  localStorage.removeItem(LS_META + ':' + id);
  localStorage.removeItem(LS_BLOCKS + ':' + id);
  localStorage.removeItem(LS_VARS + ':' + id);
  // 删除该项目素材
  try {
    const all = await idbGetAll(STORE_ASSETS);
    const prefix = id + PROJECT_NS_SEP;
    for (const r of all) {
      if (r.key && r.key.indexOf(prefix) === 0) await idbDelete(STORE_ASSETS, r.key);
    }
  } catch (e) { console.error('删除项目素材失败', e); }
}
async function getProjectStats(id) {
  let assetCount = 0;
  let lineCount = 0;
  try {
    const all = await idbGetAll(STORE_ASSETS);
    const prefix = id + PROJECT_NS_SEP;
    assetCount = all.filter(r => r.key && r.key.indexOf(prefix) === 0).length;
  } catch (e) {}
  const t = localStorage.getItem(LS_STORY_TEXT + ':' + id) || localStorage.getItem(LS_STORY + ':' + id) || '';
  if (t) lineCount = t.split('\n').length;
  return { assetCount, lineCount };
}

// 首次启动：把旧版无项目数据收进「默认项目」，并确保项目注册表存在
async function migrateLegacyIfNeeded() {
  let projects = _readProjects();
  let defaultId;
  if (projects.length) {
    defaultId = projects[0].id;
  } else {
    defaultId = uid('proj');
    projects = [{ id: defaultId, name: '默认项目', createdAt: Date.now() }];
    _writeProjects(projects);
    localStorage.setItem(LS_CURRENT, defaultId);
  }
  // 归并残留的旧全局数据（不带命名空间的）到默认项目
  _projectId = defaultId;
  // 旧剧情（仅当默认项目尚无自己的剧情时才覆盖，避免清掉已有进度）
  const oldStory = localStorage.getItem(LS_LEGACY_STORY);
  if (oldStory != null && localStorage.getItem(_storyKey()) == null) {
    localStorage.setItem(_storyKey(), oldStory);
    localStorage.removeItem(LS_LEGACY_STORY);
  }
  const oldText = localStorage.getItem(LS_LEGACY_STORY_TEXT);
  if (oldText != null && localStorage.getItem(_storyTextKey()) == null) {
    localStorage.setItem(_storyTextKey(), oldText);
    localStorage.removeItem(LS_LEGACY_STORY_TEXT);
  }
  const oldMeta = localStorage.getItem(LS_LEGACY_META);
  if (oldMeta != null && localStorage.getItem(_metaKey()) == null) {
    localStorage.setItem(_metaKey(), oldMeta);
    localStorage.removeItem(LS_LEGACY_META);
  }
  // 旧素材（key 不含命名空间分隔符的）重命名为默认项目命名空间；
  // 同时兼容旧版记录缺失 lib / id 字段（从 key 推导补全），否则按库过滤读取与删除会失效。
  try {
    const all = await idbGetAll(STORE_ASSETS);
    for (const r of all) {
      let rec = r;
      let changed = false;
      let newKey = r.key;
      if (r.key && r.key.indexOf(PROJECT_NS_SEP) === -1) {
        newKey = defaultId + PROJECT_NS_SEP + r.key;
        rec = Object.assign({}, r, { key: newKey });
        changed = true;
      }
      if (rec.lib == null) { rec = Object.assign({}, rec, { lib: _libFromKey(rec.key) }); changed = true; }
      if (rec.id == null) { rec = Object.assign({}, rec, { id: _idFromKey(rec.key) }); changed = true; }
      if (changed) {
        await idbPut(STORE_ASSETS, rec);
        if (newKey !== r.key) await idbDelete(STORE_ASSETS, r.key);
      }
    }
  } catch (e) { console.error('素材迁移失败', e); }
}

// ============ 素材 ============
// asset 结构（按库不同字段不同）：
//   background: { id, name, kind:'image'|'gradient'|'noise', src(dataURL), original?, edit?, derived? }
//   item:       { id, name, glb(dataURL), exitMesh, interactions, sounds, defaultView, bg }
//   music:      { id, name, src(dataURL), original?, edit?, derived? }
//   sound:      { id, name, src(dataURL), original?, edit?, derived? }
// 再编辑字段（图片/音频素材专有）：
//   original: 首次再编辑时归档的「原始源」dataURL（永远不被覆盖，恢复用）；未再编辑时为 null
//   derived:  true 表示当前 src 是经再编辑派生的版本；恢复原始后清回 false
//   edit:     最近一次再编辑配方 { tool:'image'|'audio', editedAt }（仅作记录，不影响运行）

async function saveAsset(lib, asset) {
  if (!LIBS.includes(lib)) throw new Error('未知素材库: ' + lib);
  if (!asset.id) asset.id = uid(lib.slice(0, 3));
  const key = _assetKey(lib, asset.id);
  // 多项目架构迁移兜底：覆盖写入前，清理「同 lib+id 但 key 不同」的残留记录
  // （典型是早期无命名空间前缀的旧记录 key=lib:id）。否则新记录(p1::lib:id)写入后，
  // 旧记录残留，getAllAssets 的兼容过滤会把两条都显示 → 素材库出现重复卡片，
  // 且渲染可能仍显示旧版（再编辑看起来「没保存/没替换」）。
  try {
    const all = await idbGetAll(STORE_ASSETS);
    for (const r of all) {
      if (r.key === key) continue;
      const rlib = (r.lib != null) ? r.lib : _libFromKey(r.key);
      const rid = (r.id != null) ? r.id : _idFromKey(r.key);
      if (rlib === lib && rid === asset.id) await idbDelete(STORE_ASSETS, r.key);
    }
  } catch (e) { /* 清理失败不影响主写入 */ }
  await idbPut(STORE_ASSETS, Object.assign({ key, lib }, asset));
  return asset.id;
}

async function getAsset(lib, id) {
  const k = await _findAssetKey(lib, id);
  if (!k) return null;
  const rec = await idbGet(STORE_ASSETS, k);
  if (!rec) return null;
  const { key, lib: l, ...rest } = rec;
  return rest;
}

async function getAllAssets(lib) {
  const all = await idbGetAll(STORE_ASSETS);
  const prefix = _projectId ? (_projectId + PROJECT_NS_SEP) : '';
  return all
    .filter(r => {
      const rlib = (r.lib != null) ? r.lib : _libFromKey(r.key);
      if (rlib !== lib) return false;
      // 当前项目命名空间前缀匹配
      if (prefix && r.key && r.key.indexOf(prefix) === 0) return true;
      // 兼容旧版无项目记录的素材（key 不含命名空间分隔符）：归属当前项目显示，
      // 解决「多项目架构」前写入的素材在打开项目后被 projectId 前缀过滤掉而整库为空的问题。
      if (r.key && r.key.indexOf(PROJECT_NS_SEP) === -1) return true;
      // 未进入任何项目时不限制前缀
      if (!prefix) return true;
      return false;
    })
    .map(r => {
      const { key, lib: l, ...rest } = r;
      // 兼容旧版记录缺失 lib / id：从 key 推导补全，确保卡片渲染与删除可用
      if (rest.id == null) rest.id = _idFromKey(key);
      if (rest.lib == null) rest.lib = (l != null) ? l : _libFromKey(key);
      return rest;
    });
}

// 按 lib+id 在 store 中定位真实 key（兼容旧版无命名空间前缀的记录）
async function _findAssetKey(lib, id) {
  const all = await idbGetAll(STORE_ASSETS);
  const prefix = _projectId ? (_projectId + PROJECT_NS_SEP) : '';
  const exact = prefix + lib + ':' + id;
  let found = all.find(r => r.key === exact);
  if (found) return found.key;
  // 旧记录兜底：lib+id 匹配（key 可能无前缀或前缀不一致）
  found = all.find(r => {
    const rlib = (r.lib != null) ? r.lib : _libFromKey(r.key);
    const rid = (r.id != null) ? r.id : _idFromKey(r.key);
    return rlib === lib && rid === id;
  });
  return found ? found.key : null;
}

async function deleteAsset(lib, id) {
  const k = await _findAssetKey(lib, id);
  if (k) await idbDelete(STORE_ASSETS, k);
}

async function renameAsset(lib, id, newName) {
  const k = await _findAssetKey(lib, id);
  if (!k) throw new Error('素材不存在');
  const rec = await idbGet(STORE_ASSETS, k);
  if (!rec) throw new Error('素材不存在');
  const updated = Object.assign({}, rec, { name: newName });
  await idbPut(STORE_ASSETS, updated);
  return updated;
}

// 导入 GLB 场景包（来自 3D交互制作器导出）：把每个模型拆成「一个可召唤物品」
async function importSceneBundle(json) {
  if (!json || json.schema !== 'glb-scene-bundle') {
    throw new Error('文件格式不对：不是 glb-scene-bundle 场景包');
  }
  const models = json.models || [];
  const imported = [];
  for (const m of models) {
    const id = m.id || uid('itm');
    const item = {
      id,
      name: m.name || '未命名物品',
      glb: m.glb || '',
      exitMesh: m.exitMesh || (m.exitMeshes && m.exitMeshes[0]) || null,
      exitMeshes: m.exitMeshes || (m.exitMesh ? [m.exitMesh] : []),
      interactions: m.interactions || {},
      chains: m.chains || [],
      exitBindings: m.exitBindings || {},
      sounds: m.sounds || {},
      defaultView: m.defaultView || null,
      lockRotation: !!m.lockRotation,
      bg: m.bg || null,
    };
    await saveAsset('item', item);
    imported.push(item);
  }
  return imported;
}

// 裸二进制 → data URL（用于把 .jgl 工程包里的 glb/音效还原为可存储的 base64）
function bytesToDataUrl(bytes, mime) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:' + (mime || 'application/octet-stream') + ';base64,' + btoa(binary);
}

// 导入场景包文件：自动识别 .json（内联旧格式）或 .jgl/.zip（工程包，glb/音效裸二进制外挂）
async function importSceneBundleFile(file) {
  if (!file) throw new Error('未选择文件');
  const name = file.name || '';
  const isZip = /\.(jgl|zip)$/i.test(name) || (file.type && /zip/.test(file.type));
  if (!isZip) {
    const text = await file.text();
    const json = JSON.parse(text);
    return await importSceneBundle(json);
  }
  if (typeof parseZipBlob !== 'function') throw new Error('zip 解压功能不可用');
  const files = await parseZipBlob(file);
  const sceneText = files['scene.json'];
  if (!sceneText) throw new Error('工程包缺少 scene.json');
  const json = JSON.parse(new TextDecoder().decode(sceneText));
  if (!json || json.schema !== 'glb-scene-bundle') throw new Error('不是 glb-scene-bundle 场景包');
  for (const m of (json.models || [])) {
    if (m.glbFile && files[m.glbFile]) {
      m.glb = bytesToDataUrl(files[m.glbFile], 'model/gltf-binary');
      delete m.glbFile;
    }
    if (m.soundRefs) {
      const sounds = {};
      for (const sid in m.soundRefs) {
        const ref = m.soundRefs[sid];
        if (ref && ref.file && files[ref.file]) {
          sounds[sid] = bytesToDataUrl(files[ref.file], ref.mime || 'audio/mpeg');
        }
      }
      m.sounds = sounds;
      delete m.soundRefs;
    }
  }
  return await importSceneBundle(json);
}

// ============ 剧情 ============
// story: 节点数组。节点类型：
//   { type:'text', content:'...' }                        文字（可含 BBCode）
//   { type:'summon', kind:'background'|'item'|'music'|'sound', id, name }
//   { type:'pause', ms:0 }                                ms=0 表示点击继续；>0 表示自动停顿毫秒
async function saveStory(story) {
  localStorage.setItem(_storyKey(), JSON.stringify(story || []));
}
function loadStory() {
  try {
    const raw = localStorage.getItem(_storyKey());
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// 原始文本（编辑器视图）。与上面的剧情数组并存：数组供导出/预览，文本保证重新打开时格式无损。
function saveStoryText(t) { localStorage.setItem(_storyTextKey(), t == null ? '' : String(t)); }
function loadStoryText() {
  try { const v = localStorage.getItem(_storyTextKey()); return v == null ? null : v; } catch (e) { return null; }
}

// ============ 剧情块（主剧情 + 分支块） ============
// 结构：{ main: 文本, blocks: { 名称: 文本 } }
// 主剧情内部名固定为 MAIN_BLOCK，始终存在、置顶、不可删除，游戏默认从它开始。
function _emptyBlocks() { return { main: '', blocks: {} }; }
function loadBlocks() {
  let raw;
  try { raw = localStorage.getItem(_blocksKey()); } catch (e) { raw = null; }
  if (raw == null) {
    // 迁移：若旧单剧情文本存在，则把它作为主剧情内容；否则返回空结构（由编辑器填入默认文本）
    const oldText = (function () {
      try { const t = localStorage.getItem(_storyTextKey()); return t == null ? null : t; } catch (e) { return null; }
    })();
    const blk = _emptyBlocks();
    blk.main = oldText || '';
    return blk;
  }
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return _emptyBlocks();
    const blk = _emptyBlocks();
    blk.main = typeof obj.main === 'string' ? obj.main : '';
    blk.blocks = (obj.blocks && typeof obj.blocks === 'object') ? obj.blocks : {};
    return blk;
  } catch (e) { return _emptyBlocks(); }
}
function saveBlocks(blocks) {
  localStorage.setItem(_blocksKey(), JSON.stringify(blocks || _emptyBlocks()));
}
function getBlockText(name) {
  const blk = loadBlocks();
  if (name === MAIN_BLOCK) return blk.main || '';
  return (blk.blocks && blk.blocks[name]) || '';
}
function setBlockText(name, text) {
  const blk = loadBlocks();
  if (name === MAIN_BLOCK) blk.main = text == null ? '' : String(text);
  else { blk.blocks = blk.blocks || {}; blk.blocks[name] = text == null ? '' : String(text); }
  saveBlocks(blk);
}
// 新建剧情块，返回内部名（自动处理重名）
function addBlock(suggestName) {
  const blk = loadBlocks();
  blk.blocks = blk.blocks || {};
  let base = (suggestName && String(suggestName).trim()) || '新对话';
  let name = base, n = 2;
  while (name === MAIN_BLOCK || blk.blocks[name] != null) { name = base + ' ' + n; n++; }
  blk.blocks[name] = '';
  saveBlocks(blk);
  return name;
}
// 重命名剧情块（不可重命名主剧情）。同时把其它块及主剧情里对该块的引用一并更新。
function renameBlock(oldName, newName) {
  if (oldName === MAIN_BLOCK) return false;
  newName = (newName && String(newName).trim()) || oldName;
  const blk = loadBlocks();
  blk.blocks = blk.blocks || {};
  if (blk.blocks[oldName] == null) return false;
  let finalName = newName, n = 2;
  while (finalName === MAIN_BLOCK || (blk.blocks[finalName] != null && finalName !== oldName)) { finalName = newName + ' ' + n; n++; }
  blk.blocks[finalName] = blk.blocks[oldName];
  if (finalName !== oldName) delete blk.blocks[oldName];
  // 更新引用：<对话块:旧名> / <剧情块:旧名>（兼容旧写法）与 <选项:"文字",旧名>
  const escOld = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const upd = (t) => {
    if (!t) return t;
    return t
      .replace(new RegExp('<(?:对话块|剧情块):\\s*' + escOld + '\\s*>', 'g'), '<剧情块:' + finalName + '>')
      .replace(new RegExp('<选项:(\\s*"[^"]*"\\s*,\\s*)' + escOld + '(\\s*)>', 'g'), '<选项:$1' + finalName + '$2>');
  };
  blk.main = upd(blk.main);
  for (const k in blk.blocks) blk.blocks[k] = upd(blk.blocks[k]);
  saveBlocks(blk);
  return finalName;
}
function deleteBlock(name) {
  if (name === MAIN_BLOCK) return false; // 主剧情不可删除
  const blk = loadBlocks();
  blk.blocks = blk.blocks || {};
  if (blk.blocks[name] == null) return false;
  delete blk.blocks[name];
  saveBlocks(blk);
  return true;
}
function listBlockNames() {
  const blk = loadBlocks();
  return [MAIN_BLOCK].concat(Object.keys(blk.blocks || {}));
}
function hasBlocksData() {
  try { return localStorage.getItem(_blocksKey()) != null; } catch (e) { return false; }
}

// ============ 元数据（标题等） ============
async function saveMeta(meta) {
  localStorage.setItem(_metaKey(), JSON.stringify(meta || {}));
}
function loadMeta() {
  try { return JSON.parse(localStorage.getItem(_metaKey()) || '{}'); } catch (e) { return {}; }
}

// ============ 变量库 ============
// 结构：[{ name, type:'number'|'text'|'boolean', value }]
// 变量初值在「素材库·变量库」集中定义；正文用 {名} 读取、<变量:名=值> 赋值。
// type 仅用于编辑器提示与编译校验，运行时统一按字符串/数字解析。

// ============ 工程备份 / 恢复 ============
// 把整个项目（剧情块 + 变量 + 元数据[含创作设定/线索/提示词缓存] + 全部素材二进制）
// 打包为一个 JSON，可在另一台设备「导入工程备份」后原样继续编辑。
// 注意：AI 设置（storyeditor:ai:*，含 API Key）刻意不进备份，符合「Key 绝不进导出」原则。
const BACKUP_FORMAT = 'story-editor-project';
const BACKUP_VERSION = 1;

async function exportProject(pid) {
  const realPid = pid || _projectId;
  if (!realPid) throw new Error('没有可备份的项目');
  const out = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    generator: '剧情编辑器',
    projectName: getProjectName(realPid),
    // 直接存原始 localStorage 字符串，最大程度保留结构（含 meta.creation / assetPrompts 等）
    data: {
      blocks: localStorage.getItem(LS_BLOCKS + ':' + realPid) || '',
      vars: localStorage.getItem(LS_VARS + ':' + realPid) || '',
      meta: localStorage.getItem(LS_META + ':' + realPid) || '',
      story: localStorage.getItem(LS_STORY + ':' + realPid) || '',
      storyText: localStorage.getItem(LS_STORY_TEXT + ':' + realPid) || '',
    },
  };
  // 素材二进制（已为 dataURL），随项目命名空间过滤后原样带出
  try {
    const all = await idbGetAll(STORE_ASSETS);
    const prefix = realPid + PROJECT_NS_SEP;
    out.data.assets = all
      .filter(r => r.key && r.key.indexOf(prefix) === 0)
      .map(r => { const { key, ...rest } = r; return rest; });
  } catch (e) { out.data.assets = []; }
  return out;
}

async function importProject(json, opts) {
  if (!json || json.format !== BACKUP_FORMAT) throw new Error('文件不是有效的剧情编辑器工程备份');
  const newId = uid('proj');
  const baseName = (json.projectName && String(json.projectName).trim()) || '导入的项目';
  const newName = (opts && opts.name) ? opts.name : baseName;
  const projects = _readProjects();
  projects.push({ id: newId, name: newName, createdAt: Date.now() });
  _writeProjects(projects);
  const d = json.data || {};
  if (d.blocks) localStorage.setItem(LS_BLOCKS + ':' + newId, d.blocks);
  if (d.vars) localStorage.setItem(LS_VARS + ':' + newId, d.vars);
  if (d.meta) localStorage.setItem(LS_META + ':' + newId, d.meta);
  if (d.story) localStorage.setItem(LS_STORY + ':' + newId, d.story);
  if (d.storyText) localStorage.setItem(LS_STORY_TEXT + ':' + newId, d.storyText);
  // 素材：key 重写到新项目命名空间（lib/id 保持不变，避免引用错位）
  const assets = Array.isArray(d.assets) ? d.assets : [];
  for (const a of assets) {
    if (!a || !a.lib || !a.id) continue;
    const rec = Object.assign({}, a, { key: newId + PROJECT_NS_SEP + a.lib + ':' + a.id });
    await idbPut(STORE_ASSETS, rec);
  }
  return newId;
}

function loadVars() {
  try {
    const raw = localStorage.getItem(_varsKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveVars(arr) {
  try { localStorage.setItem(_varsKey(), JSON.stringify(arr || [])); } catch (e) { console.error('保存变量失败', e); }
}
function getVars() { return loadVars(); }
function getVarNames() {
  return new Set(loadVars().map(v => (v.name || '').trim()).filter(Boolean));
}

const Storage = {
  LIBS, saveAsset, getAsset, getAllAssets, deleteAsset, renameAsset,
  importSceneBundle, importSceneBundleFile, saveStory, loadStory, saveStoryText, loadStoryText,
  saveMeta, loadMeta, uid,
  // 变量库
  loadVars, saveVars, getVars, getVarNames,
  // 剧情块 API
  MAIN_BLOCK, loadBlocks, saveBlocks, getBlockText, setBlockText, addBlock, renameBlock, deleteBlock, listBlockNames, hasBlocksData,
  // 项目 API
  listProjects, createProject, renameProject, deleteProject, getProjectName, getProjectMode,
  getCurrentProjectId, setCurrentProject, getProjectStats, migrateLegacyIfNeeded,
  // 工程备份 / 恢复（跨设备搬运整个剧本：素材+变量+线索+设定）
  exportProject, importProject,
};

if (typeof window !== 'undefined') window.Storage = Storage;
if (typeof module !== 'undefined' && module.exports) module.exports = Storage;
