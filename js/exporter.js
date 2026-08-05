// js/exporter.js — 导出运行成品（单 HTML / 标准结构 zip）
// 复用「3D交互制作器」的 GLB 独立查看器源码（embed 模式 + glb-scene-exit 协议），
// 召唤物品时以全屏 iframe 呈现 3D 界面，点结束物体 → 发消息 → 关闭并继续剧情。

// ============ 物品查看器源码（来自 3D交互制作器 exporter.js，embed 模式） ============
// 占位符：__MODEL_NAME__ __MODEL_BLOB__ __SCENE_BG__ __INTERACTIONS__ __SOUNDS__
//         __DEFAULT_VIEW__ __EMBED__ __EXIT_MESHES__ __MODEL_ID__ __CHAINS__
const ITEM_VIEWER_SOURCE = String.raw`import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_NAME = __MODEL_NAME__;
const MODEL_BLOB = __MODEL_BLOB__;
const DEFAULT_VIEW = __DEFAULT_VIEW__;
const LOCK_ROTATION = __LOCK_ROTATION__; // 关闭手动旋转：true 时禁止轨道旋转，固定在默认视角
const EMBED = __EMBED__;
const EXIT_MESHES = __EXIT_MESHES__;
const MODEL_ID = __MODEL_ID__;

const scene = new THREE.Scene();
scene.background = __SCENE_BG__;

const container = document.getElementById('viewer');
const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 5000);
camera.position.set(3, 2, 5);

const PIXEL_SIZE = 2;
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
renderer.domElement.style.imageRendering = 'pixelated';

function resizeView() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(Math.max(1, Math.floor(w / PIXEL_SIZE)), Math.max(1, Math.floor(h / PIXEL_SIZE)), false);
}
resizeView();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.1;
controls.maxDistance = 1000;
// 关闭手动旋转：锁定后禁用轨道旋转，但保留缩放/平移，并固定在默认视角
if (LOCK_ROTATION) controls.enableRotate = false;

const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.5);
fillLight.position.set(-6, 3, -4);
scene.add(fillLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 0.5));

let currentModel = null;
let blobUrl = null;
let mixer = null;
let animActions = [];
let animPrevTime = 0;
let raycaster = null;
let pointer = new THREE.Vector2();
let interactions = __INTERACTIONS__;
let SOUNDS = __SOUNDS__;
let soundCache = {};
let actionByName = {};
let actionByUuid = {};
let actionState = {};
let downX = 0, downY = 0;
let popObj = null, popBase = null, popActive = false;
let deleteFlag = {};
let triggerObj = {};
// 交互链 + 仅响应一次（成品运行时门禁）
let chains = __CHAINS__;             // [{ id, name, order:[meshName] }]
let _triggered = {};                 // meshName -> true：已被触发过（链推进与 once 限制）
function chainToast(msg) {
  if (typeof window.toast === 'function') { window.toast(msg, 'warn'); return; }
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);background:rgba(20,24,33,.92);color:#ffd479;padding:8px 14px;border-radius:8px;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;z-index:9999;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 1400);
}
// 链门禁：不在任何链上→允许；在链上且非链首→需前一个已触发
function _chainUnlocked(meshName) {
  if (!chains || !chains.length) return true;
  for (let ci = 0; ci < chains.length; ci++) {
    const ch = chains[ci]; if (!ch || !ch.order) continue;
    const idx = ch.order.indexOf(meshName);
    if (idx > 0 && !_triggered[ch.order[idx - 1]]) return false;
  }
  return true;
}

function notifyExit(meshName) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'glb-scene-exit', id: MODEL_ID, mesh: meshName }, '*');
    }
  } catch (e) {}
}
function dataUrlToBlobUrl(dataUrl) {
  const byteString = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'model/gltf-binary' });
  return URL.createObjectURL(blob);
}
function disposeModel(model) {
  model.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && typeof v === 'object' && 'minFilter' in v) v.dispose?.();
        }
        m.dispose();
      }
    }
  });
}
function loadModel() {
  blobUrl = dataUrlToBlobUrl(MODEL_BLOB);
  const loader = new GLTFLoader();
  loader.load(blobUrl, (gltf) => {
    currentModel = gltf.scene;
    scene.add(currentModel);
    if (gltf.animations && gltf.animations.length > 0) {
      mixer = new THREE.AnimationMixer(currentModel);
      animActions = gltf.animations.map(clip => {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        return action;
      });
    } else { mixer = null; animActions = []; }
    buildActionIndex();
    initInteraction();
    const box = new THREE.Box3().setFromObject(currentModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    currentModel.position.sub(center);
    const fov = camera.fov * (Math.PI / 180);
    let dist = Math.abs(maxDim / 2 / Math.tan(fov / 2));
    dist *= 1.8;
    camera.position.set(maxDim * 0.7, maxDim * 0.5, dist);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.minDistance = maxDim * 0.05;
    controls.maxDistance = maxDim * 20;
    controls.update();
    if (DEFAULT_VIEW && DEFAULT_VIEW.pos && DEFAULT_VIEW.target) {
      camera.position.fromArray(DEFAULT_VIEW.pos);
      controls.target.fromArray(DEFAULT_VIEW.target);
      camera.lookAt(controls.target);
      controls.update();
    }
    // 关闭手动旋转：锁定后确保旋转被禁用（默认视角即固定视角）
    if (LOCK_ROTATION) controls.enableRotate = false;
  }, undefined, (err) => { console.error('加载模型失败:', err); });
}
function buildActionIndex() {
  actionByName = {}; actionByUuid = {}; actionState = {};
  if (mixer) { animActions.forEach(function(a){ const n=a.getClip().name; if(n) actionByName[n]=a; actionByUuid[a.uuid]=a; actionState[a.uuid]='idle'; }); }
}
function playSound(id) {
  if (!id || !SOUNDS[id]) return false;
  try { let audio = soundCache[id]; if (!audio) { audio = new Audio(SOUNDS[id]); soundCache[id] = audio; } audio.currentTime = 0; const p = audio.play(); if (p && p.catch) p.catch(function(){}); return true; } catch (e) { return false; }
}
function triggerMeshInteraction(meshName, hitObj) {
  const entry = interactions[meshName];
  if (!entry) return false;
  const clipName = (typeof entry === 'string') ? entry : (entry.clip || '');
  const soundId = (typeof entry === 'string') ? '' : (entry.sound || '');
  const respond = (typeof entry === 'string') ? true : (entry.respond !== false);
  if (respond === false) return false;
  // 交互链门禁：同链上后一个部位需前一个已触发（成品运行时生效，便于做顺序解谜）
  if (!_chainUnlocked(meshName)) { return false; } // 链未解锁：静默拦截，不出戏（不再弹提示）
  // 仅响应一次：默认只响应一次点击；勾选「允许多次点击」(once===false) 才允许重复
  const once = (typeof entry === 'string') ? true : (entry.once !== false);
  if (once && _triggered[meshName]) { return false; } // 已触发过且 once：静默拦截，不出戏
  doPop(hitObj);
  _triggered[meshName] = true; // 标记已触发（推进链 / 限制 once）
  let did = false;
  const ping = (typeof entry === 'object') && (!!entry.pingpong);
  const auto = (typeof entry === 'object') && (!!entry.autoReturn);
  const del = (typeof entry === 'object') && (!!entry.deleteAfter);
  if (clipName) {
    if (clipName.indexOf('preset:') === 0) { playPreset(clipName.slice(7), hitObj, del); did = true; }
    else if (mixer) { const action = actionByName[clipName]; if (action) { triggerObj[action.uuid] = hitObj; deleteFlag[action.uuid] = del; toggleAction(action, ping, auto); did = true; } }
  }
  if (soundId) { if (playSound(soundId)) did = true; }
  return true;
}
function doPop(obj) {
  if (!obj) return;
  if (popObj) popObj.scale.copy(popBase);
  popBase = obj.scale.clone(); obj.scale.multiplyScalar(1.02); popObj = obj; popActive = true;
}
function toggleAction(action, pingpong, autoReturn) {
  const st = actionState[action.uuid] || 'idle';
  if (autoReturn) { if (st === 'idle') { action.reset(); action.setLoop(THREE.LoopOnce, 1); action.timeScale = 1; action.play(); actionState[action.uuid] = 'auto-fwd'; } return; }
  if (pingpong) {
    if (st === 'idle' || st === 'ping-reverse') { action.reset(); action.setLoop(THREE.LoopOnce, 1); action.timeScale = 1; action.play(); actionState[action.uuid] = 'ping-forward'; }
    else if (st === 'ping-forward') { action.stop(); action.time = action.getClip().duration; action.timeScale = -1; action.play(); actionState[action.uuid] = 'ping-reverse'; }
    return;
  }
  if (st === 'idle' || st === 'forward') { action.reset(); action.setLoop(THREE.LoopOnce, 1); action.timeScale = 1; action.play(); actionState[action.uuid] = 'forward'; }
}
function maybeDeleteAfter(uid) {
  if (deleteFlag[uid]) { const obj = triggerObj[uid]; if (obj && obj.parent) obj.parent.remove(obj); deleteFlag[uid] = false; triggerObj[uid] = null; }
}
function initInteraction() {
  raycaster = new THREE.Raycaster();
  const el = renderer.domElement;
  el.addEventListener('pointerdown', function(e){ downX = e.clientX; downY = e.clientY; });
  el.addEventListener('pointerup', function(e){
    if (!currentModel) return;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.hypot(dx, dy) > 5) return;
    const rect = el.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(currentModel, true);
    if (hits.length === 0) return;
    const hit = hits[0].object;
    const meshName = hit.name;
    // 先走交互链门禁（结束物体也是触发部位，顺序未满足则拦下，不提前结束场景）
    const triggered = triggerMeshInteraction(meshName, hit);
    if (EMBED && meshName && EXIT_MESHES.indexOf(meshName) >= 0 && triggered) notifyExit(meshName);
  });
}
window.addEventListener('resize', () => {
  const w = container.clientWidth, h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h; camera.updateProjectionMatrix(); resizeView();
});

// ============ 内置简易动画 ============
var PRESET_ANIMS = {
  'jump':  { label: '向上跳一下', dur: 0.55, amp: function(d){ return d * 0.4; },          apply: function(o,t,b,a){ o.position.y = b.y + a * Math.sin(Math.PI * t); } },
  'shake': { label: '原地摇晃',   dur: 0.60, amp: function(){ return 0.13; },               apply: function(o,t,b,a){ o.rotation.z = b.rz + a * Math.sin(4 * Math.PI * t); } },
  'spin':  { label: '旋转一圈',   dur: 1.00, amp: function(){ return Math.PI * 2; },        apply: function(o,t,b,a){ o.rotation.y = b.ry + a * t; } },
  'nod':   { label: '点头',       dur: 0.60, amp: function(){ return 0.28; },               apply: function(o,t,b,a){ o.rotation.x = b.rx + a * Math.sin(Math.PI * t); } },
};
var activePresets = [];

function animate(time) {
  requestAnimationFrame(animate);
  const now = time || performance.now();
  const delta = animPrevTime ? (now - animPrevTime) / 1000 : 0.016;
  animPrevTime = now;
  if (popObj) { if (popActive) popActive = false; else { popObj.scale.copy(popBase); popObj = null; popBase = null; } }
  if (mixer) {
    mixer.update(delta);
    for (const uid in actionState) {
      const act = actionByUuid[uid]; if (!act) continue;
      const st = actionState[uid];
      if (st === 'auto-fwd') { if (act.time >= act.getClip().duration - 0.03) { act.stop(); act.time = act.getClip().duration; act.timeScale = -1; act.play(); actionState[uid] = 'auto-bwd'; } }
      else if (st === 'auto-bwd') { if (act.time <= 0.03) { act.stop(); actionState[uid] = 'idle'; maybeDeleteAfter(uid); } }
      else if (st === 'ping-forward') {}
      else if (st === 'ping-reverse') { if (act.time <= 0.03) { act.stop(); actionState[uid] = 'idle'; maybeDeleteAfter(uid); } }
      else if (st === 'forward') { if (act.time >= act.getClip().duration - 0.03) { actionState[uid] = 'idle'; maybeDeleteAfter(uid); } }
    }
  }
  for (let i = activePresets.length - 1; i >= 0; i--) {
    const p = activePresets[i];
    p.t += delta / p.dur;
    const t = Math.min(p.t, 1);
    PRESET_ANIMS[p.name].apply(p.obj, t, p.base, p.amp);
    if (p.t >= 1) { p.obj.position.y = p.base.y; p.obj.rotation.x = p.base.rx; p.obj.rotation.y = p.base.ry; p.obj.rotation.z = p.base.rz; activePresets.splice(i, 1); if (p.del && p.obj.parent) p.obj.parent.remove(p.obj); }
  }
  controls.update(); renderer.render(scene, camera);
}
animate();

function playPreset(name, obj, del) {
  if (!obj || !PRESET_ANIMS[name]) return;
  for (let i = activePresets.length - 1; i >= 0; i--) { if (activePresets[i].obj === obj) activePresets.splice(i, 1); }
  const def = PRESET_ANIMS[name];
  const box = new THREE.Box3().setFromObject(obj);
  const s = new THREE.Vector3(); box.getSize(s);
  const maxDim = Math.max(s.x, s.y, s.z) || 1;
  activePresets.push({ name: name, obj: obj, t: 0, dur: def.dur, del: !!del, base: { y: obj.position.y, rx: obj.rotation.x, ry: obj.rotation.y, rz: obj.rotation.z }, amp: def.amp(maxDim) });
}
if (EMBED) { const _tb = document.getElementById('toolbar'); if (_tb) _tb.style.display = 'none'; }
loadModel();
`;

// ============ 物品查看器外壳 ============
// 占位符：__VIEWER_SCRIPT__ __MODEL_NAME_ESC__ __BODY_BG__
const ITEM_VIEWER_WRAP = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>物品 - __MODEL_NAME_ESC__</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; tap-highlight-color: transparent; -webkit-touch-callout: none; }
  body { margin: 0; overflow: hidden; background: __BODY_BG__; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e6e9ef; user-select: none; -webkit-user-select: none; }
  #viewer { position: absolute; inset: 0; }
  canvas { width: 100% !important; height: 100% !important; display: block; image-rendering: pixelated; }
</style>
</head>
<body>
<div id="viewer"></div>
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }
</script>
<script type="module">
__VIEWER_SCRIPT__
</script>
</body>
</html>
`;

// ============ 运行时模板（玩家看到的成品页） ============
// 占位符：__SRC__ __WRAP__ __STORY_DATA__ __STORY_SCRIPT_TAG__ __TITLE__
const RUNTIME_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>__TITLE__</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; tap-highlight-color: transparent; -webkit-touch-callout: none; }
  /* __FONT_FACE__ */
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; overscroll-behavior: none; background: #0a0c12; }
  html { position: fixed; inset: 0; }
  body { position: fixed; inset: 0; font-family: __FONT_FAMILY__; background: #0a0c12; color: #f0f3fa; user-select: none; -webkit-user-select: none; overflow: hidden; overscroll-behavior: none; touch-action: manipulation; }
  #stage { position: fixed; inset: 0; z-index: 2; display: flex; flex-direction: column; cursor: pointer; }
  #bg-layer-a, #bg-layer-b { position: fixed; inset: 0; background-size: auto 100%; background-position: center; background-repeat: no-repeat; transition: opacity 0.5s ease; pointer-events: none; image-rendering: pixelated; }
  #bg-layer-a { opacity: 1; z-index: 0; }
  #bg-layer-b { opacity: 0; z-index: 1; }
  #bg-overlay { position: fixed; inset: 0; z-index: 1; pointer-events: none; background: rgba(255,255,255,0.45); opacity: 0; transition: opacity .28s ease; }
  /* 叠层：显示于背景层之上、文字层(#stage z2)之下；召唤透明 PNG 角色 / 物件用 */
  /* 尺寸：纵向显示总大小的 60%（高 60vh 的居中带，contain 保证任意宽高比都不超过 60% 高） */
  #overlay-layer { position: fixed; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 60vh; z-index: 1; pointer-events: none; display: none;
    background-repeat: no-repeat; background-position: center; background-size: contain; }
  #message-list { flex: 1; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 18vh 0 14vh; scroll-behavior: smooth; scrollbar-width: none; -ms-overflow-style: none; }
  #message-list::-webkit-scrollbar { width: 0; height: 0; }
  .message { max-width: 780px; width: 88%; margin: 0 auto 12px; padding: 16px 24px; background: none; border: 0; border-radius: 0; font-size: 20px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; opacity: 0; animation: msgIn 0.3s ease forwards; }
  @keyframes msgIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .message.typing { opacity: 1; }
  .message b, .message strong { color: #fff; font-weight: 700; }
  .message i { font-style: italic; }
  .message u { text-decoration: underline; }
  .message s { text-decoration: line-through; }
  /* 自动对比色：亮背景→黑字，暗背景→白字（整行一个颜色，由运行时按背景亮度动态切换） */
  /* 不再给每段文字加独立背板，统一靠全屏白色半透明蒙版保证可读，剧情更连续 */
  .message.auto-dark { color: #14181f; }
  .message.auto-dark b, .message.auto-dark strong { color: #14181f; }
  .message.auto-light { color: #f5f7fb; }
  .message.auto-light b, .message.auto-light strong { color: #f5f7fb; }
  /* 长按 1 秒：隐藏文字与白色蒙版，还原背景原图，便于欣赏背景；松手恢复 */
  body.reveal-bg #message-list { opacity: 0; transition: opacity .28s ease; pointer-events: none; }
  body.reveal-bg #options-bar { opacity: 0; transition: opacity .28s ease; pointer-events: none; }
  body.reveal-bg #hint { opacity: 0 !important; transition: opacity .28s ease; }
  body.reveal-bg #bg-overlay { opacity: 0 !important; transition: opacity .28s ease; }
  body.reveal-bg { user-select: none; -webkit-user-select: none; }

  /* ===== galgame 模式：文字固定在画面底部对齐的黑色文本框内，每次只显示一段 ===== */
  /* 文本框自带足够对比度，因此不给背景加明暗蒙版，背景原图完整呈现 */
  body.galgame #bg-overlay { opacity: 0 !important; }
  body.galgame #message-list {
    flex: none; position: fixed; left: 0; right: 0; bottom: 0; top: auto;
    height: 32vh; min-height: 160px; max-height: 42vh;
    padding: 20px 0 30px;
    background: rgba(6,8,14,0.84);
    border-top: 1px solid rgba(150,180,255,0.30);
    box-shadow: 0 -10px 34px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    scroll-behavior: auto;
  }
  /* 字号由运行时按框高动态计算（目标 3 行，见 fitGalgameFont），CSS 变量兜底 20px */
  body.galgame .message { width: 92%; max-width: 900px; margin: 0 auto 10px; padding: 0 26px; font-size: var(--gal-font-size, 20px); }
  /* 黑框内统一白字：屏蔽自动对比色（auto-dark 会变成黑字，在黑框上不可读） */
  body.galgame .message,
  body.galgame .message.auto-dark,
  body.galgame .message.auto-light { color: #f2f6ff; }
  body.galgame .message b, body.galgame .message strong,
  body.galgame .message.auto-dark b, body.galgame .message.auto-dark strong,
  body.galgame .message.auto-light b, body.galgame .message.auto-light strong { color: #ffffff; }
  body.galgame .message.divider { margin: 10px auto; }
  /* 继续提示挪到文本框右下角（galgame 习惯位置），选项条抬到文本框上方避免被遮挡 */
  body.galgame #hint { bottom: 10px; left: auto; right: 26px; transform: none; }
  body.galgame #options-bar { bottom: calc(32vh + 18px); }
  @media (max-width: 640px) {
    body.galgame #message-list { height: 36vh; padding: 16px 0 26px; }
    body.galgame .message { padding: 0 18px; }
    body.galgame #options-bar { bottom: calc(36vh + 14px); }
  }

  /* ===== 文字历史面板：顶部菜单唤出，滚动回看已读文本（两种模式通用） ===== */
  #history-panel { position: fixed; inset: 0; z-index: 12; display: none; flex-direction: column;
    background: rgba(6,9,16,0.94); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    opacity: 0; transition: opacity 0.2s ease; }
  #history-panel.open { display: flex; opacity: 1; }
  #history-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 12px 18px;
    border-bottom: 1px solid rgba(120,160,255,0.22); background: rgba(15,19,29,0.85); }
  #history-head .hp-title { font-size: 15px; font-weight: 700; color: #dfe8ff; letter-spacing: 2px; display: flex; align-items: center; gap: 8px; }
  #history-head .hp-title::before { content: '✶'; color: #6fa8ff; font-size: 15px; }
  #history-close { margin-left: auto; padding: 7px 18px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.06); color: #cfe0ff; cursor: pointer; font-size: 13px; transition: 0.16s; }
  #history-close:hover { background: rgba(255,255,255,0.16); }
  #history-body { flex: 1; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 22px 0 32px; }
  #history-body .hp-item { max-width: 780px; width: 88%; margin: 0 auto 14px; padding: 4px 24px;
    font-size: 19px; line-height: 1.65; color: #e9eef8; white-space: pre-wrap; word-break: break-word; }
  #history-body .hp-item b, #history-body .hp-item strong { color: #fff; font-weight: 700; }
  #history-body .hp-item i { font-style: italic; }
  #history-body .hp-item u { text-decoration: underline; }
  #history-body .hp-item s { text-decoration: line-through; }
  #history-body .hp-item.divider { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 18px auto; }
  #history-body .hp-item.divider .divider-line { flex: 1; max-width: 42%; height: 1px; background: rgba(160,178,210,0.4); }
  #history-body .hp-item.divider .divider-text { color: rgba(190,205,228,0.9); font-size: 15px; letter-spacing: 3px; white-space: nowrap; }
  #history-empty { text-align: center; color: #7c879b; font-size: 14px; padding: 40px 20px; }
  @media (max-width: 640px) {
    #history-body .hp-item { width: 92%; padding: 4px 16px; font-size: 17px; }
  }
  /* 分割线：横线 + 居中备注文字（备注留空则为普通横线）；显示后停顿等点击继续 */
  .message.divider { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 18px auto; opacity: 1; padding: 8px 24px; }
  .message.divider .divider-line { flex: 1; max-width: 42%; height: 1px; background: rgba(160,178,210,0.4); }
  .message.divider .divider-text { color: rgba(190,205,228,0.9); font-size: 15px; letter-spacing: 3px; white-space: nowrap; }
  #hint { position: fixed; bottom: 5vh; left: 50%; transform: translateX(-50%); color: #9fb0c8; font-size: 14px; letter-spacing: 2px; animation: pulse 1.4s infinite; display: none; pointer-events: none; z-index: 3; }
  @keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }
  /* 分支选项：游戏底部排列的按钮 */
  #options-bar { position: fixed; left: 0; right: 0; bottom: 4vh; z-index: 8; display: none; flex-direction: column; align-items: center; gap: 12px; padding: 0 16px; pointer-events: none; }
  #options-bar.show { display: flex; }
  #options-bar .opt-btn {
    pointer-events: auto;
    max-width: 86%; width: auto; min-width: 180px;
    padding: 13px 28px; font-size: 18px; line-height: 1.4; text-align: center;
    border-radius: 12px; cursor: pointer;
    color: #eaf1ff; background: rgba(28,38,58,0.92);
    border: 1px solid rgba(120,160,255,0.45);
    box-shadow: 0 10px 30px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    transition: transform 0.14s ease, background 0.18s ease, border-color 0.18s ease;
    animation: optIn 0.28s ease backwards;
  }
  #options-bar .opt-btn:hover { background: rgba(58,134,255,0.34); border-color: #5a9bff; transform: translateY(-2px); }
  #options-bar .opt-btn:active { transform: translateY(0); }
  /* 条件不满足的选项已在 presentOptions 直接隐藏（不渲染），不再需要置灰样式 */
  @keyframes optIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  #item-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.3); backdrop-filter: blur(2px); z-index: 50; opacity: 0; pointer-events: none; transition: opacity 0.3s ease-out; }
  #item-overlay.open { opacity: 1; pointer-events: auto; }
  #item-frame { width: 100%; height: 100%; border: 0; transform: scale(0.3); opacity: 0; transition: transform 0.3s ease-out, opacity 0.3s ease-out; }
  #item-overlay.open #item-frame { transform: scale(1); opacity: 1; }
  #end-card { display: none; align-items: center; color: #9fb0c8; margin-top: 18px; padding-bottom: 4vh; }
  #start-screen { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; }
  #start-screen.hidden { display: none; }
  /* 开场背景图案：垂直铺满画面（高=100%，宽按比例），居中，无图时回退默认深色 */
  #opening-bg { position: absolute; inset: 0; background-size: auto 100%; background-position: center; background-repeat: no-repeat; z-index: 0; image-rendering: pixelated; }
  #start-screen.has-opening { background: transparent; }
  #start-icon, #start-heading, #start-title, #start-subtitle, #start-author, #start-btns { position: relative; z-index: 1; }
  #start-heading { display: flex; flex-direction: column; align-items: center; gap: 6px; background: rgba(0,0,0,0.45); border-radius: 14px; padding: 18px 32px; max-width: 90vw; box-shadow: 0 6px 30px rgba(0,0,0,0.4); }
  #start-title { font-size: 36px; font-weight: 700; color: #fff; text-align: center; text-shadow: 0 2px 18px rgba(0,0,0,0.65); line-height: 1.25; }
  #start-subtitle { font-size: 16px; font-weight: 400; color: #c4ccd8; text-align: center; margin-top: 4px; letter-spacing: 1px; text-shadow: 0 1px 10px rgba(0,0,0,0.5); }
  #start-icon { width: 100%; height: auto; object-fit: contain; margin-bottom: 8px; display: none; }
  /* 横屏：固定宽度 800px，高度按比例自适应，避免把开始按钮顶掉 */
  @media (orientation: landscape) {
    #start-icon { width: 800px; height: auto; }
  }
  #start-btns { display: flex; gap: 16px; }
  #start-btns button { padding: 12px 32px; font-size: 16px; border-radius: 10px; cursor: pointer; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.1); color: #fff; transition: 0.2s; }
  #start-btns button:hover { background: rgba(255,255,255,0.2); }
  #start-btns button.primary { background: rgba(58,134,255,0.3); border-color: #3a86ff; }
  #start-btns button.primary:hover { background: rgba(58,134,255,0.5); }
  #start-author { font-size: 13px; color: rgba(255,255,255,0.55); text-align: center; letter-spacing: 1px; margin-top: 4px; }
  /* 极简加载进度条：一条短短的硬朗横线 + 很小的字（字在横线之上） */
  #loading { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 10px; z-index: 3; background: #000; }
  #loading.show { display: flex; }
  .load-text { font-size: 10px; letter-spacing: 1px; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .load-bar { width: 200px; height: 2px; background: rgba(255,255,255,0.16); overflow: hidden; }
  .load-fill { height: 100%; width: 0; background: #ffffff; transition: width 0.15s linear; }
  .load-log { margin-top: 8px; max-height: 150px; overflow-y: auto; width: min(80vw, 340px); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; line-height: 1.5; color: rgba(255,255,255,0.5); text-align: left; }
  .load-log-row { display: flex; gap: 8px; padding: 1px 0; }
  .load-log-type { width: 36px; flex-shrink: 0; color: rgba(255,255,255,0.35); }
  .load-log-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .load-log-status { width: 34px; flex-shrink: 0; text-align: right; }
  .load-log-status.ok { color: #4ade80; }
  .load-log-status.err { color: #f87171; }
  .load-log-status.wait { color: rgba(255,255,255,0.35); }
  #load-skip { display: none; margin-top: 12px; padding: 6px 14px; font-size: 11px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7); cursor: pointer; }
  #load-skip.show { display: block; }
  #watermark { position: fixed; z-index: 5; font-size: 13px; color: rgba(255,255,255,0.6); pointer-events: none; display: none; }
  #title-overlay { position: fixed; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center; pointer-events: none; opacity: 0; transition: opacity 0.3s; background: rgba(0,0,0,0.62); backdrop-filter: blur(1.5px); }
  #title-overlay.show { opacity: 1; }
  #title-overlay.clickable { pointer-events: auto; cursor: pointer; }
  #title-text { font-size: 48px; font-weight: 700; color: #fff; text-shadow: 0 0 40px rgba(0,0,0,0.7); text-align: center; padding: 0 40px; white-space: nowrap; max-width: 96vw; }
  /* 物品提示文字：画面中下方 */
  #item-hint { position: fixed; left: 50%; bottom: 9%; transform: translateX(-50%); max-width: 80vw; text-align: center; font-size: 18px; line-height: 1.6; color: #fff; background: rgba(0,0,0,0.55); padding: 10px 22px; border-radius: 12px; z-index: 51; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
  #item-hint.show { opacity: 1; }
  /* 顶部浮动横栏：存档 / 读档 + 音乐 / 音效 静音开关（四按钮等宽并排） */
  #topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 7; height: 46px; display: flex; align-items: stretch; gap: 8px; padding: 6px 10px; background: rgba(15,19,29,0.82); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(120,160,255,0.22); box-shadow: 0 4px 18px rgba(0,0,0,0.35); }
  #topbar button { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 5px; font-size: 13px; line-height: 1; color: #fff; cursor: pointer; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); border-radius: 9px; padding: 0 6px; transition: 0.16s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #topbar button:hover { background: rgba(255,255,255,0.16); }
  #topbar #tb-save, #topbar #tb-load { border-color: rgba(58,134,255,0.5); background: rgba(58,134,255,0.22); color: #cfe0ff; }
  #topbar #tb-save:hover, #topbar #tb-load:hover { background: rgba(58,134,255,0.42); }
  #topbar .tb-toggle { color: #cfe6ff; }
  /* 静音开关：开启（出声）为蓝色调，关闭（静音）为红色调 + 斜杠图标，状态区分明显 */
  #topbar .tb-toggle.muted { border-color: rgba(255,110,110,0.7); background: rgba(255,80,80,0.22); color: #ffb3b3; box-shadow: inset 0 0 0 1px rgba(255,120,120,0.35); }
  #topbar .tb-toggle .ic { font-size: 16px; line-height: 1; }
  #topbar #tb-autoplay.active { border-color: rgba(120,230,160,0.85); background: rgba(60,200,120,0.28); color: #b6ffd2; box-shadow: inset 0 0 0 1px rgba(120,230,160,0.35); }
  /* 存档 / 读档 弹层（共用样式，两个独立界面）：左右贴边 + 横向扁条 */
  .tb-menu { position: fixed; top: 50px; left: 0; right: 0; z-index: 7; width: auto; background: linear-gradient(180deg, rgba(28,34,50,0.97), rgba(15,19,29,0.97)); border-top: 1px solid rgba(120,160,255,0.22); border-bottom: 1px solid rgba(120,160,255,0.22); border-left: none; border-right: none; border-radius: 0; padding: 8px 14px; display: none; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px 14px; box-shadow: 0 14px 34px rgba(0,0,0,0.5); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); transform: translateY(-8px); opacity: 0; transition: opacity 0.2s ease, transform 0.2s ease; }
  .tb-menu.open { display: flex; opacity: 1; transform: translateY(0); }
  /* 竖屏 / 窄屏：四按钮保持等宽并排，缩小间距与字号避免重叠 */
  @media (orientation: portrait), (max-width: 560px) {
    #topbar { gap: 5px; padding: 5px 6px; }
    #topbar button { font-size: 12px; padding: 0 4px; }
    #topbar .tb-toggle .ic { font-size: 15px; }
  }
  .tb-menu .sm-title { font-size: 14px; font-weight: 700; color: #dfe8ff; letter-spacing: 2px; display: flex; align-items: center; gap: 8px; flex: 0 0 auto; white-space: nowrap; }
  .tb-menu .sm-title::before { content: '✶'; color: #6fa8ff; font-size: 15px; }
  .tb-menu .sm-slots { flex: 1 1 auto; display: flex; gap: 8px 12px; flex-wrap: wrap; align-items: center; min-width: 0; }
  .tb-menu .sm-row { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); transition: background 0.18s, border-color 0.18s; flex: 1 1 180px; min-width: 0; }
  .tb-menu .sm-row:hover { background: rgba(110,160,255,0.10); border-color: rgba(120,160,255,0.28); }
  .tb-menu .sm-badge { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #cfe0ff; background: rgba(58,134,255,0.18); border: 1px solid rgba(108,160,255,0.42); }
  .tb-menu .sm-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .tb-menu .sm-slot { color: #e9eef7; font-size: 13px; font-weight: 600; }
  .tb-menu .sm-time { font-size: 11px; color: #7c879b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tb-menu .sm-time.empty { color: #586180; font-style: italic; }
  .tb-menu .sm-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .tb-menu .sm-time { margin-left: 0; font-size: 11px; color: #7c879b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tb-menu .sm-line { display: block; font-size: 11px; color: #7c879b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .tb-menu .sm-line.empty { color: #586180; font-style: italic; }

  .tb-menu .sm-acts { display: flex; gap: 6px; flex: 0 0 auto; }
  .tb-menu .sm-acts button { padding: 6px 11px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: #fff; cursor: pointer; font-size: 12px; transition: 0.16s; }
  .tb-menu .sm-acts button:hover { background: rgba(255,255,255,0.16); transform: translateY(-1px); }
  .tb-menu .sm-acts button[data-act="save"] { border-color: rgba(58,134,255,0.5); background: rgba(58,134,255,0.22); color: #cfe0ff; }
  .tb-menu .sm-acts button[data-act="save"]:hover { background: rgba(58,134,255,0.42); }
  .tb-menu .sm-acts button[data-act="load"] { border-color: rgba(120,200,140,0.5); background: rgba(120,200,140,0.20); color: #d6ffe0; }
  .tb-menu .sm-acts button[data-act="load"]:hover { background: rgba(120,200,140,0.40); }
  .tb-menu .sm-acts button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
  .tb-menu .sm-close { margin: 0 0 0 auto; padding: 7px 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.10); background: transparent; color: #9fb0c8; cursor: pointer; font-size: 13px; transition: 0.16s; flex: 0 0 auto; white-space: nowrap; }
  .tb-menu .sm-close:hover { background: rgba(255,255,255,0.06); color: #cfe0ff; }
  /* 窄屏：槽位组占满整行、关闭回到行末，避免标题/槽位/关闭被拆散 */
  @media (orientation: portrait), (max-width: 560px) {
    .tb-menu { gap: 6px 10px; padding: 8px 12px; }
    .tb-menu .sm-slots { flex-basis: 100%; }
    .tb-menu .sm-row { flex-basis: 100%; }
    .tb-menu .sm-close { margin-left: 0; }
  }
  /* 完结界面 */
  #end-card { flex-direction: column; gap: 22px; cursor: default; }
  #end-card .end-title { font-size: 44px; letter-spacing: 12px; }
  #end-card .end-author { font-size: 14px; color: #8b96a8; letter-spacing: 1px; }
  #end-card .end-btns { display: flex; gap: 16px; }
  #end-card .end-btns button { padding: 11px 26px; font-size: 15px; border-radius: 10px; cursor: pointer; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.1); color: #fff; transition: 0.2s; }
  #end-card .end-btns button:hover { background: rgba(255,255,255,0.2); }
  #end-card .end-btns button.primary { background: rgba(58,134,255,0.3); border-color: #3a86ff; }
  #end-card .end-btns button.primary:hover { background: rgba(58,134,255,0.5); }
  /* 读档/存档提示 */
  #toast { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 20; background: rgba(20,25,35,0.95); color: #fff; padding: 14px 28px; border-radius: 12px; font-size: 16px; border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 10px 30px rgba(0,0,0,0.5); opacity: 0; pointer-events: none; transition: opacity 0.25s; }
  #toast.show { opacity: 1; }
  /* 黑屏转场（读档 / 重新开始） */
  #black-fade { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; transition: opacity 0.35s ease; z-index: 9999; }
  #black-fade.show { opacity: 1; pointer-events: auto; }
  /* 非 B站环境提示（开场显示在下方） */
  #env-hint { display: none; position: fixed; left: 0; right: 0; bottom: 14px; text-align: center; font-size: 13px; color: #ffb4b4; opacity: 0.9; padding: 0 16px; z-index: 5; pointer-events: none; }
</style>
</head>
<body>
<div id="black-fade"></div>
<div id="bg-layer-a"></div>
<div id="bg-layer-b"></div>
<div id="bg-overlay"></div>
<div id="overlay-layer"></div>
<div id="stage">
  <div id="message-list"></div>
  <div id="hint">▼ 点击继续</div>
  <div id="options-bar"></div>
  <div id="item-overlay"><iframe id="item-frame" sandbox="allow-scripts" allow="autoplay"></iframe></div>
  <div id="item-hint"></div>
  <div id="end-card">
    <div class="end-title">完</div>
    <div class="end-author">作者：<span id="end-author"></span></div>
    <div class="end-btns">
      <button class="primary" id="end-restart">🔄 重新开始</button>
      <button id="end-load">📂 读取存档</button>
    </div>
  </div>
  <div id="topbar">
    <button id="tb-save" type="button" title="存档">💾 存档</button>
    <button id="tb-load" type="button" title="读取存档">📂 读档</button>
    <button id="tb-music" class="tb-toggle" type="button" title="点击静音 / 恢复游戏音乐"><span class="ic">🎵</span></button>
    <button id="tb-sfx" class="tb-toggle" type="button" title="点击静音 / 恢复游戏音效"><span class="ic">🔊</span></button>
    <button id="tb-autoplay" class="tb-toggle" type="button" title="自动播放：开启后，每次停顿 2.5 秒自动继续"><span class="ic">▶</span></button>
    <button id="tb-history" type="button" title="文字历史：回看已读过的全部文本">📜 历史</button>
  </div>
  <!-- 文字历史面板：暂时唤出已读文本（滚动回看，样式接近长文模式） -->
  <div id="history-panel">
    <div id="history-head">
      <span class="hp-title">文字历史</span>
      <button id="history-close" type="button">关闭</button>
    </div>
    <div id="history-body"><div id="history-empty">还没有已读文本</div></div>
  </div>
  <!-- 存档界面（独立） -->
  <div id="save-menu" class="tb-menu">
    <div class="sm-title">💾 存档</div>
    <div class="sm-slots">
      <div class="sm-row" data-slot="1">
        <div class="sm-badge">1</div>
        <div class="sm-info">
          <div class="sm-head">
            <span class="sm-slot">存档位 1</span>
            <span class="sm-time" id="sm-time-1"></span>
          </div>
          <span class="sm-line empty" id="sm-line-1">空槽位</span>
        </div>
        <div class="sm-acts">
          <button data-act="save">存入</button>
        </div>
      </div>
      <div class="sm-row" data-slot="2">
        <div class="sm-badge">2</div>
        <div class="sm-info">
          <div class="sm-head">
            <span class="sm-slot">存档位 2</span>
            <span class="sm-time" id="sm-time-2"></span>
          </div>
          <span class="sm-line empty" id="sm-line-2">空槽位</span>
        </div>
        <div class="sm-acts">
          <button data-act="save">存入</button>
        </div>
      </div>
      <div class="sm-row" data-slot="3">
        <div class="sm-badge">3</div>
        <div class="sm-info">
          <div class="sm-head">
            <span class="sm-slot">存档位 3</span>
            <span class="sm-time" id="sm-time-3"></span>
          </div>
          <span class="sm-line empty" id="sm-line-3">空槽位</span>
        </div>
        <div class="sm-acts">
          <button data-act="save">存入</button>
        </div>
      </div>
    </div>
    <button class="sm-close" id="sm-close">关闭</button>
  </div>
  <!-- 读档界面（独立） -->
  <div id="load-menu" class="tb-menu">
    <div class="sm-title">📂 读取存档</div>
    <div class="sm-slots">
      <div class="sm-row" data-slot="1">
        <div class="sm-badge">1</div>
        <div class="sm-info">
          <div class="sm-head">
            <span class="sm-slot">存档位 1</span>
            <span class="sm-time" id="lm-time-1"></span>
          </div>
          <span class="sm-line empty" id="lm-line-1">空槽位</span>
        </div>
        <div class="sm-acts">
          <button data-act="load">读取</button>
        </div>
      </div>
      <div class="sm-row" data-slot="2">
        <div class="sm-badge">2</div>
        <div class="sm-info">
          <div class="sm-head">
            <span class="sm-slot">存档位 2</span>
            <span class="sm-time" id="lm-time-2"></span>
          </div>
          <span class="sm-line empty" id="lm-line-2">空槽位</span>
        </div>
        <div class="sm-acts">
          <button data-act="load">读取</button>
        </div>
      </div>
      <div class="sm-row" data-slot="3">
        <div class="sm-badge">3</div>
        <div class="sm-info">
          <div class="sm-head">
            <span class="sm-slot">存档位 3</span>
            <span class="sm-time" id="lm-time-3"></span>
          </div>
          <span class="sm-line empty" id="lm-line-3">空槽位</span>
        </div>
        <div class="sm-acts">
          <button data-act="load">读取</button>
        </div>
      </div>
    </div>
    <button class="sm-close" id="lm-close">关闭</button>
  </div>
  <div id="start-screen">
    <div id="opening-bg"></div>
    <div id="loading" class="show">
      <div class="load-text" id="load-text">加载：0.00 / 0.00 MB</div>
      <div class="load-bar"><div class="load-fill" id="load-fill"></div></div>
      <div class="load-log" id="load-log"></div>
      <button id="load-skip" type="button">强制跳过加载</button>
    </div>
    <img id="start-icon" alt="">
    <div id="start-heading">
      <div id="start-title"></div>
      <div id="start-subtitle"></div>
    </div>
    <div id="start-btns">
      <button class="primary" id="btn-start-game">▶ 开始游戏</button>
    </div>
    <div id="start-author"></div>
    <div id="env-hint"></div>
  </div>
  <div id="watermark"></div>
  <div id="title-overlay"><div id="title-text"></div></div>
  <div id="toast"></div>
</div>
__STORY_SCRIPT_TAG__
<script>
const ITEM_VIEWER_SOURCE = __SRC__;
const ITEM_VIEWER_WRAP = __WRAP__;
__STORY_DATA__

(function () {
  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function bbcodeToHtml(s){
    if (s == null) return '';
    let t = escapeHtml(s);
    t = t.replace(/\n/g, '[br]');
    t = t.replace(/\[color=([^\]]+)\]((?:[^[]|\[(?!color=))*)\[\/color\]/g, function(m,c,i){ return '<span style="color:'+c+'">'+i+'</span>'; });
    t = t.replace(/\[size=(\d+)\]((?:[^[]|\[(?!size=))*)\[\/size\]/g, function(m,n,i){ return '<span style="font-size:'+n+'px">'+i+'</span>'; });
    t = t.replace(/\[left\]((?:[^[]|\[(?!left))*)\[\/left\]/g, function(m,i){ return '<div style="text-align:left">'+i+'</div>'; });
    t = t.replace(/\[center\]((?:[^[]|\[(?!center))*)\[\/center\]/g, function(m,i){ return '<div style="text-align:center">'+i+'</div>'; });
    t = t.replace(/\[right\]((?:[^[]|\[(?!right))*)\[\/right\]/g, function(m,i){ return '<div style="text-align:right">'+i+'</div>'; });
    t = t.replace(/\[b\]((?:[^[]|\[(?!b]))*)\[\/b\]/g, '<b>$1</b>');
    t = t.replace(/\[i\]((?:[^[]|\[(?!i]))*)\[\/i\]/g, '<i>$1</i>');
    t = t.replace(/\[u\]((?:[^[]|\[(?!u]))*)\[\/u\]/g, '<u>$1</u>');
    t = t.replace(/\[s\]((?:[^[]|\[(?!s]))*)\[\/s\]/g, '<s>$1</s>');
    t = t.replace(/\[br\]/g, '<br>');
    t = t.replace(/\[shadow=([^\]]+)\]((?:[^[]|\[(?!shadow=))*)\[\/shadow\]/g, function(m,c,i){ return '<span style="text-shadow:2px 2px 4px '+c+'">'+i+'</span>'; });
    t = t.replace(/\[glow=([^\]]+)\]((?:[^[]|\[(?!glow=))*)\[\/glow\]/g, function(m,c,i){ return '<span style="text-shadow:0 0 8px '+c+',0 0 16px '+c+',0 0 24px '+c+'">'+i+'</span>'; });
    t = t.replace(/\[highlight=([^\]]+)\]((?:[^[]|\[(?!highlight=))*)\[\/highlight\]/g, function(m,c,i){ return '<mark style="background:'+c+';color:#000;padding:0 4px;border-radius:3px">'+i+'</mark>'; });
    // 正文内嵌图片：@image#1:图片名（来自图片库）
    t = t.replace(/@image#\d+:([^\s<]+)/g, function(m, name){
      const src = resolveInlineImage(name);
      if (!src) return '<span style="color:#ff6b6b">[图片未找到: ' + escapeHtml(name) + ']</span>';
      return '<img class="inline-img" src="' + src + '" alt="' + escapeHtml(name) + '" style="max-width:100%;height:auto;display:block;margin:8px auto;border-radius:8px" onerror="this.style.display=\'none\'">';
    });
    // 瞬显：包裹的文字在游戏中「直接整段出现」而非逐字打字；运行时 revealHtml 据此整块揭示
    t = t.replace(/\[瞬显\]((?:[^[]|\[(?!瞬显))*)\[\/瞬显\]/g, '<span class="instant">$1</span>');
    return t;
  }
  function bbcodeTextLength(s){ const d = document.createElement('div'); d.innerHTML = bbcodeToHtml(s || ''); return (d.textContent || '').length; }
  // 逐字揭示：保留前 n 个文本字符（标签结构保留）。
  // 支持 [瞬显] 区块：其内部文字在打字指针到达该区块时「整块一次性」出现（不逐字、不提前、不延后）。
  function revealHtml(html, n){
    const root = document.createElement('div'); root.innerHTML = html;
    // 第一遍：给每个文本字符分配「显示阈值」d；instant 区块所有字符共享 d = 区块起始序号
    let order = 0;
    (function annotate(el){
      for (let i = 0; i < el.childNodes.length; i++){
        const c = el.childNodes[i];
        if (c.nodeType === 3){
          c.__d = order + 1;            // 该文本节点整段连续的起始序号
          order += c.nodeValue.length;
        } else if (c.nodeType === 1){
          if (c.classList && c.classList.contains('instant')){
            const len = (c.textContent || '').length;
            c.__instant = true;
            c.__d = order + 1;          // 整块共享同一起始序号
            order += len;               // 仍占据 len 个位置，使后续文字 d 正确顺延
          } else {
            annotate(c);
          }
        }
      }
    })(root);
    // 第二遍：移除 d > n 的节点（instant 区块要么整块保留，要么整块移除）
    (function prune(el){
      const toRemove = [];
      for (let i = 0; i < el.childNodes.length; i++){
        const c = el.childNodes[i];
        if (c.nodeType === 3){
          if (c.__d === undefined){ toRemove.push(c); continue; }
          const len = c.nodeValue.length;
          const dEnd = c.__d + len - 1;
          if (dEnd <= n) { /* 全保留 */ }
          else if (c.__d > n) { toRemove.push(c); }
          else { c.nodeValue = c.nodeValue.slice(0, n - c.__d + 1); }
        } else if (c.nodeType === 1){
          if (c.__instant){
            if (c.__d > n) toRemove.push(c);   // 否则整块保留（含嵌套子标签）
          } else {
            prune(c);
            // 保留无子节点的 void 元素（<br>/<img>），仅移除因裁剪而变空的包裹标签（span/div/b/i…）
            const tag = (c.tagName || '').toUpperCase();
            if (c.childNodes.length === 0 && tag !== 'BR' && tag !== 'IMG') toRemove.push(c);
          }
        }
      }
      for (let i = toRemove.length - 1; i >= 0; i--) el.removeChild(toRemove[i]);
    })(root);
    return root.innerHTML;
  }
  function bgCodeFromCSS(css){
    if (!css) return 'new THREE.Color(0x0a0c12)';
    if (css.indexOf('data:') === 0 || css.indexOf('http') === 0){
      return '(function(){var t=new THREE.TextureLoader().load(' + JSON.stringify(css) + '); if(THREE.SRGBColorSpace) t.colorSpace=THREE.SRGBColorSpace; return t;})()';
    }
    if (css[0] === '#') return 'new THREE.Color(0x' + css.replace('#','') + ')';
    const colors = css.match(/#[0-9a-fA-F]{6}/g) || css.match(/#[0-9a-fA-F]{3}/g) || [];
    if (colors.length < 2) return 'new THREE.Color(0x0a0c12)';
    let dir = 'vertical';
    if (css.indexOf('to right') >= 0) dir = 'horizontal';
    else if (css.indexOf('to bottom right') >= 0) dir = 'diagonal';
    else if (css.indexOf('radial') >= 0) dir = 'radial';
    let code = '(function(){var c=document.createElement("canvas");c.width=1024;c.height=1024;var ctx=c.getContext("2d");';
    if (dir === 'horizontal') code += 'var g=ctx.createLinearGradient(0,0,1024,0);';
    else if (dir === 'diagonal') code += 'var g=ctx.createLinearGradient(0,0,1024,1024);';
    else if (dir === 'radial') code += 'var g=ctx.createRadialGradient(512,512,0,512,512,720);';
    else code += 'var g=ctx.createLinearGradient(0,0,0,1024);';
    code += 'g.addColorStop(0,"' + colors[0] + '");g.addColorStop(1,"' + colors[1] + '");';
    code += 'ctx.fillStyle=g;ctx.fillRect(0,0,1024,1024);return new THREE.CanvasTexture(c);})()';
    return code;
  }
  function bodyBgFromCSS(css){ if (!css) return '#0a0c12'; if (css[0] === '#' || css.indexOf('gradient') >= 0) return css; return css; }
    function buildItemViewerHTML(model){
      const bgCode = 'null'; // embed 模式：scene 背景透明
      const bodyBg = 'transparent'; // embed 模式：body 背景透明
      function rep(s, find, val) { return s.split(find).join(val); }
      let viewer = ITEM_VIEWER_SOURCE;
      viewer = rep(viewer, '__MODEL_NAME__', JSON.stringify(model.name || 'item'));
      viewer = rep(viewer, '__MODEL_BLOB__', JSON.stringify(model.glb || ''));
      viewer = rep(viewer, '__SCENE_BG__', bgCode);
      viewer = rep(viewer, '__INTERACTIONS__', JSON.stringify(model.interactions || {}).replace(/</g, '\\u003c'));
      viewer = rep(viewer, '__CHAINS__', JSON.stringify(model.chains || []).replace(/</g, '\\u003c'));
      viewer = rep(viewer, '__SOUNDS__', JSON.stringify(model.sounds || {}).replace(/</g, '\\u003c'));
      viewer = rep(viewer, '__DEFAULT_VIEW__', JSON.stringify(model.defaultView || null));
      viewer = rep(viewer, '__LOCK_ROTATION__', model.lockRotation ? 'true' : 'false');
      viewer = rep(viewer, '__EMBED__', 'true');
      viewer = rep(viewer, '__EXIT_MESHES__', JSON.stringify(model.exitMeshes || (model.exitMesh ? [model.exitMesh] : [])).replace(/</g, '\\u003c'));
      viewer = rep(viewer, '__MODEL_ID__', JSON.stringify(model.id || ''));
      let wrap = ITEM_VIEWER_WRAP;
      wrap = rep(wrap, '__VIEWER_SCRIPT__', viewer);
      wrap = rep(wrap, '__MODEL_NAME_ESC__', escapeHtml(model.name || 'item'));
      wrap = rep(wrap, '__BODY_BG__', bodyBg);
      return wrap;
    }

  const RAW = window.STORY_DATA || {};
  let openingAudio = null;   // 开场标题界面音乐（独立于游戏内 bgMusic，开始游戏后停止）

  // ===== 静音开关状态（顶部浮动横栏的「音乐 / 音效」开关）=====
  // musicMuted / sfxMuted 为 true 时，对应音量归零；点击开关在「静音」与「出声」间切换。
  let musicMuted = false, sfxMuted = false;
  const MUSIC_VOL = 0.6, SFX_VOL = 1.0;
  function applyMusicMute(){ const v = musicMuted ? 0 : MUSIC_VOL; if (bgMusic) bgMusic.volume = v; if (openingAudio) openingAudio.volume = v; }
  function updateMuteButtons(){
    const mb = document.getElementById('tb-music'), sb = document.getElementById('tb-sfx');
    if (mb){ mb.classList.toggle('muted', musicMuted); mb.querySelector('.ic').textContent = musicMuted ? '🔇' : '🎵'; }
    if (sb){ sb.classList.toggle('muted', sfxMuted); sb.querySelector('.ic').textContent = sfxMuted ? '🔇' : '🔊'; }
  }
  const DATA = {
    assets: RAW.assets || { background:{}, item:{}, music:{}, sound:{} },
    global: RAW.global || {},
    title: RAW.title || '互动剧情',
    // 新格式：blocks 为 { 块名: 节点数组 }，start 为起始块名（默认主剧情 __MAIN__）
    // 旧格式兜底：仅有 story 时视其为主剧情块
    blocks: RAW.blocks || (RAW.story ? { [RAW.start || '__MAIN__']: RAW.story } : {}),
    start: RAW.start || (RAW.blocks ? Object.keys(RAW.blocks)[0] : '__MAIN__'),
    // 变量库默认值：collectRuntimeData 已把变量库初值注入 STORY_DATA.variables，
    // 必须显式透传到 DATA，否则运行时 vars 初始为空、{名} 读取不到默认值（只有 <变量:名=值> 赋值才生效）。
    variables: RAW.variables || {},
    // 预览「从光标开始」起点：data.__previewFrom 已正确设置，但 DATA 是重建对象，
    // 必须显式透传，否则运行时读不到 —— 会导致标题屏照常出现、从头开始。
    __previewFrom: RAW.__previewFrom || null,
  };
  // 初始化水印
  (function(){
    const g = DATA.global || {};
    const wm = g.watermark;
    if (!wm || !wm.text) return;
    const el = document.getElementById('watermark');
    el.style.display = 'block';
    el.style.opacity = (wm.opacity || 40) / 100;
    el.textContent = wm.text;
    const posMap = { '左上':'top:12px;left:16px', '右上':'top:12px;right:16px', '左下':'bottom:12px;left:16px', '右下':'bottom:12px;right:16px' };
    el.style.cssText += ';' + (posMap[wm.pos] || posMap['右下']);
  })();

    // 解析开场背景：支持「背景库素材名」（按名解析 src / 纯色）与旧版直链（data:/http(s)）
    function resolveOpeningBg(val) {
      if (!val) return { src: '', color: '' };
      if (typeof val === 'string' && (val.indexOf('data:') === 0 || val.indexOf('http') === 0)) {
        return { src: val, color: '' };
      }
      const a = findAsset('background', { name: val });
      if (a) {
        if (a.src) return { src: a.src, color: '' };
        if (a.kind === 'solid' && a.color) return { src: '', color: a.color };
      }
      return { src: '', color: '' };
    }
    // 解析图标：支持「图片库素材名」（按名解析 src）与旧版直链（data:/http(s)）
    function resolveIcon(val) {
      if (!val) return '';
      if (typeof val === 'string' && (val.indexOf('data:') === 0 || val.indexOf('http') === 0)) return val;
      const a = findAsset('background', { name: val });
      if (a && a.src) return a.src;
      return '';
    }
    // 解析正文内嵌图片（@image#1:Name）：按图片库名称找 src，找不到返回空
    function resolveInlineImage(name) {
      if (!name) return '';
      if (typeof name === 'string' && (name.indexOf('data:') === 0 || name.indexOf('http') === 0)) return name;
      const a = findAsset('background', { name: name });
      if (a && a.src) return a.src;
      return '';
    }

  // 初始化开始界面
  (function(){
    const g = DATA.global || {};
    const title = g.gameName || '';
    document.getElementById('start-title').textContent = title;
    const subEl = document.getElementById('start-subtitle');
    if (subEl) subEl.textContent = g.subtitle || '';
    // 开场背景图案：有图则显示并让 start-screen 透明，无图保持默认深色。
    // openingBg 现为「背景库素材名」（与开场音乐一致）；旧版 data:/http(s) 直链仍兼容。
    const obg = resolveOpeningBg(g.openingBg);
    if (obg.src || obg.color) {
      const obgEl = document.getElementById('opening-bg');
      if (obgEl) {
        if (obg.src) obgEl.style.backgroundImage = 'url("' + obg.src + '")';
        if (obg.color) obgEl.style.backgroundColor = obg.color;
      }
      document.getElementById('start-screen').classList.add('has-opening');
    }
    if (g.icon) {
      const iconSrc = resolveIcon(g.icon);
      if (iconSrc) {
        const iconEl = document.getElementById('start-icon');
        iconEl.src = iconSrc;
        iconEl.style.display = 'block';
      }
    }
    // 开场标题界面音乐：循环播放，直到点「开始游戏」时停止
    function startOpeningMusic() {
      if (openingAudio) return;
      const name = (g.openingMusic || '').trim();
      if (!name) return;
      const a = findAsset('music', { name: name });
      if (a && a.src) {
        const m = new Audio(a.src);
        m.loop = true; m.volume = musicMuted ? 0 : MUSIC_VOL;
        const p = m.play();
        if (p && typeof p.then === 'function') {
          // 自动播放可能被浏览器拦截：成功才标记 openingAudio，失败则交给首次手势兜底
          p.then(function() { openingAudio = m; }).catch(function() {});
        } else {
          openingAudio = m;
        }
      }
    }
    function stopOpeningMusic() {
      if (!openingAudio) return;
      const au = openingAudio; openingAudio = null;
      if (typeof fadeOutMusic === 'function') fadeOutMusic(au); else { try { au.pause(); } catch (e) {} }
      if (onFirstGesture) { try { document.removeEventListener('pointerdown', onFirstGesture, true); } catch (e) {} }
    }
    // 浏览器自动播放策略：页面加载时直接 play 常被拦截；用户首次交互（点任意处）后再起播
    let onFirstGesture = function(e) {
      if (e && e.target && e.target.id === 'btn-start-game') return; // 直接点「开始游戏」时不起播（避免起播即停的杂音）
      const ss = document.getElementById('start-screen');
      if (ss && ss.classList.contains('hidden')) return; // 已开始游戏，不再起播
      if (openingAudio) return;
      startOpeningMusic();
    };
    // 先尝试直接起播（部分宿主环境允许），失败则等首次交互
    startOpeningMusic();
    if (!openingAudio) document.addEventListener('pointerdown', onFirstGesture, true);
    // 作者信息：仅以文字展示在开始游戏下方（不再提供跳转个人空间的按钮）
    const authorId = (g.authorId || '').trim();
    if (authorId) {
      const aEl = document.getElementById('start-author');
      if (aEl) aEl.textContent = '作者：' + authorId;
    }
    // 估算 dataURL 解码后的字节数（用于加载进度 MB 显示）；外置相对路径无法估算返回 0
    function b64Bytes(url){
      if (!url || url.indexOf('data:') !== 0) return 0;
      const c = url.indexOf(',');
      const b = c >= 0 ? url.slice(c + 1) : url;
      return Math.max(0, Math.floor(b.length * 3 / 4));
    }
    // 预加载：遍历所有内联资源（开场图/背景/音乐/音效/字体），累加已加载字节更新进度条，全部完成（或超时）后回调；带加载日志和强制跳过
    function preloadAll(done){
      const logEl = document.getElementById('load-log');
      const skipBtn = document.getElementById('load-skip');
      const txt = document.getElementById('load-text');
      function logConsole(msg){ try { console.log('[preload] ' + msg); } catch (e) {} }
      function setStatus(el, status){
        if (!el) return;
        el.textContent = status;
        el.className = 'load-log-status ' + (status === '完成' ? 'ok' : (status === '失败' || status === '超时' ? 'err' : 'wait'));
      }
      function logRow(id, type, name, status){
        if (!logEl) return;
        let row = document.getElementById(id);
        if (!row){
          row = document.createElement('div');
          row.id = id;
          row.className = 'load-log-row';
          row.innerHTML = '<span class="load-log-type">' + type + '</span><span class="load-log-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span><span class="load-log-status wait">' + status + '</span>';
          logEl.appendChild(row);
        } else {
          const st = row.querySelector('.load-log-status');
          if (st) setStatus(st, status);
        }
      }
      function complete(finishedRef, items, done){
        if (finishedRef.v) return; finishedRef.v = true;
        if (skipBtn) skipBtn.classList.remove('show');
        logConsole('complete items=' + items.length);
        if (done) { try { done(); } catch (e) { logConsole('done callback error: ' + e); } }
      }
      try {
        const assets = DATA.assets || {};
        const gg = DATA.global || {};
        const items = [];
        const obgPre = resolveOpeningBg(gg.openingBg);
        if (obgPre.src) items.push({ type: 'img', url: obgPre.src, name: '开场背景' });
        const bg = assets.background || {};
        for (const id in bg){ const s = bg[id] && bg[id].src; if (s) items.push({ type: 'img', url: s, name: id }); }
        ['music','sound'].forEach(function(lib){
          const m = assets[lib] || {};
          for (const id in m){ const s = m[id] && m[id].src; if (s) items.push({ type: 'audio', url: s, name: id }); }
        });
        if (gg.font && gg.font.src) items.push({ type: 'font', url: gg.font.src, name: '自定义字体' });
        const MB = 1024 * 1024;
        let total = 0; items.forEach(function(it){ total += b64Bytes(it.url); });
        let loaded = 0, count = 0;
        const finishedRef = { v: false };
        const fill = document.getElementById('load-fill');
        function paint(){
          const p = total ? Math.min(1, loaded / total) : 1;
          if (fill) fill.style.width = (p * 100) + '%';
          if (txt) {
            if (loaded === 0 && count === 0) txt.textContent = '加载中… (' + items.length + ' 项)';
            else txt.textContent = '加载：' + (loaded / MB).toFixed(2) + ' / ' + (total / MB).toFixed(2) + ' MB (' + count + '/' + items.length + ')';
          }
        }
        paint();
        logConsole('start items=' + items.length + ' totalBytes=' + total);
        if (!items.length){ setTimeout(function(){ complete(finishedRef, items, done); }, 0); return; }
        if (skipBtn){
          skipBtn.addEventListener('click', function(){ logConsole('user skip'); complete(finishedRef, items, done); });
          setTimeout(function(){ if (!finishedRef.v && skipBtn) skipBtn.classList.add('show'); }, 6000);
        }
        items.forEach(function(it, idx){
          const rowId = 'load-row-' + idx;
          const shortName = String(it.name || '').slice(0, 40) || String(it.url || '').slice(0, 40);
          logRow(rowId, it.type, shortName, '等待');
          let itemDone = false;
          function onok(status){
            if (itemDone) return;
            itemDone = true;
            loaded += b64Bytes(it.url);
            count++;
            logRow(rowId, it.type, shortName, status || '完成');
            logConsole((status || 'ok') + ' ' + it.type + ' ' + shortName);
            paint();
            if (count >= items.length) complete(finishedRef, items, done);
          }
          const failSafe = setTimeout(function(){ onok('超时'); }, 4000); // 单个资源 4s 兜底
          if (it.type === 'audio'){
            const au = new Audio(); au.preload = 'auto'; au.src = it.url;
            function onAudioOk(){ clearTimeout(failSafe); onok('完成'); }
            au.addEventListener('loadeddata', onAudioOk);
            au.addEventListener('canplaythrough', onAudioOk);
            au.addEventListener('error', function(){ clearTimeout(failSafe); onok('失败'); });
            try { au.load(); } catch (e) { clearTimeout(failSafe); onok('失败'); }
          } else if (it.type === 'font'){
            if (document.fonts && document.fonts.add){
              try {
                const ff = new FontFace('StoryCustomFont', it.url); document.fonts.add(ff);
                ff.load().then(function(){ clearTimeout(failSafe); onok('完成'); }, function(){ clearTimeout(failSafe); onok('失败'); });
              } catch (e) { clearTimeout(failSafe); onok('失败'); }
            } else { clearTimeout(failSafe); onok('完成'); }
          } else {
            const im = new Image();
            im.onload = function(){ clearTimeout(failSafe); onok('完成'); };
            im.onerror = function(){ clearTimeout(failSafe); onok('失败'); };
            im.src = it.url;
          }
        });
        setTimeout(function(){ complete(finishedRef, items, done); }, 5000); // 全局 5s 兜底：再卡也不阻塞进游戏
      } catch (e) {
        logConsole('fatal error: ' + e);
        if (txt) txt.textContent = '加载出错：' + (e && e.message ? e.message : String(e));
        if (skipBtn){
          skipBtn.classList.add('show');
          skipBtn.addEventListener('click', function(){ complete({ v: false }, [], done); });
        }
      }
    }
    // ===== 打开即预加载：不再等点击「开始游戏」才开始加载资源 =====
    let assetsReady = false;
    const _readyWaiters = [];
    function whenAssetsReady(cb){ if (assetsReady) cb(); else _readyWaiters.push(cb); }
    function markAssetsReady(){
      if (assetsReady) return;
      assetsReady = true;
      _readyWaiters.forEach(function(f){ f(); });
      _readyWaiters.length = 0;
    }
    const _loadingEl = document.getElementById('loading');
    if (_loadingEl) _loadingEl.classList.add('show');
    preloadAll(function(){
      if (_loadingEl) _loadingEl.classList.remove('show');
      markAssetsReady();
      // 「从光标开始」试玩：资源就绪后直接跳过标题屏开播
      if (DATA.__previewFrom) {
        const ss = document.getElementById('start-screen');
        const titleEl = document.getElementById('start-title');
        const iconEl = document.getElementById('start-icon');
        const btnsEl = document.getElementById('start-btns');
        if (titleEl) titleEl.style.display = 'none';
        if (iconEl) iconEl.style.display = 'none';
        if (btnsEl) btnsEl.style.display = 'none';
        if (ss) ss.classList.add('hidden');
        startGame();
        scheduleContrast();
      }
    });

    document.getElementById('btn-start-game').addEventListener('click', function(e){
      e.stopPropagation();   // 关键：阻止冒泡到 #stage 的全局点击监听，否则开局会把本次点击误判为「跳过第一段打字」
      stopOpeningMusic();    // 停止开场标题界面音乐
      // 资源已在打开时预加载完成；若极快点击而尚未就绪，则等就绪后再进游戏
      whenAssetsReady(function(){
        const ss = document.getElementById('start-screen');
        const titleEl = document.getElementById('start-title');
        const iconEl = document.getElementById('start-icon');
        const btnsEl = document.getElementById('start-btns');
        if (titleEl) titleEl.style.display = 'none';
        if (iconEl) iconEl.style.display = 'none';
        if (btnsEl) btnsEl.style.display = 'none';
        if (ss) ss.classList.add('hidden');
        startGame();
        scheduleContrast();
      });
    });
  })();
  // 开场环境检测：非 B站客户端环境（无 toy 或云存档能力不可用），
  // 在下方提示「建议使用哔哩哔哩客户端游玩，否则存档可能丢失」。
  (function(){
    function showEnvHint(){
      const el = document.getElementById('env-hint');
      if (el){ el.textContent = '建议使用哔哩哔哩客户端游玩，否则存档可能丢失'; el.style.display = 'block'; }
    }
    ensureToy(function(toy){
      if (!toy || typeof toy.isSupport !== 'function'){ showEnvHint(); return; }
      try {
        Promise.resolve(toy.isSupport('setCloudStorage')).then(function(ok){ if (!ok) showEnvHint(); }).catch(function(){ showEnvHint(); });
      } catch (e){ showEnvHint(); }
    });
  })();
  const msgList = document.getElementById('message-list');
  const hint = document.getElementById('hint');
  const overlay = document.getElementById('item-overlay');
  const frame = document.getElementById('item-frame');
  const endCard = document.getElementById('end-card');
  const itemHint = document.getElementById('item-hint');
  const titleOverlay = document.getElementById('title-overlay');
  const titleText = document.getElementById('title-text');
  const toastEl = document.getElementById('toast');
  const bgA = document.getElementById('bg-layer-a');
  const bgB = document.getElementById('bg-layer-b');
  const bgOverlay = document.getElementById('bg-overlay');
  const overlayLayer = document.getElementById('overlay-layer');
  let activeBg = bgA; // 当前显示的背景层
  let altBg = bgB;    // 备用层（用于叠化）
  let bgFadeTimer = null; // 当前未完成的背景叠化定时器（快速切换时取消上一个）

  // ===== 文字历史 & galgame 分段 =====
  // historyItems 记录全程已呈现的文字/分割线（两种模式都记），供顶部菜单「历史」回看。
  // galgame 模式下 msgList 只保留「当前一段」，历史全靠 historyItems 兜底，所以清屏不会丢内容。
  const historyItems = [];
  let historyOpen = false;
  // galSegmentEnded：上一段已在「停顿 / 分割线 / 标题」处收尾，下次出现文字前应清空文本框。
  // 只在段落收尾处置位（而非在停顿被消费处），这样点击继续 / 定时继续 / 自动播放三条路径行为一致。
  let galSegmentEnded = false;
  const historyPanel = document.getElementById('history-panel');
  const historyBody = document.getElementById('history-body');
  function pushHistory(html, isDivider){
    historyItems.push({ html: html || '', divider: !!isDivider });
    if (historyOpen) renderHistory(); // 面板开着时（自动播放中）同步追加
  }
  function resetHistory(){ historyItems.length = 0; galSegmentEnded = false; if (historyOpen) renderHistory(); }
  // 清空文本框内容（保留「完」卡：它可能挂在 msgList 下，整体 innerHTML='' 会把它删掉导致后续引用失效）
  function clearStageMessages(){
    Array.from(msgList.children).forEach(function(c){ if (c !== endCard) msgList.removeChild(c); });
    msgList.scrollTop = 0; userScrolledUp = false; currentMsg = null;
  }
  // galgame：新一段开始前清屏（长文模式不清，保持累积长卷）
  function beginSegmentIfNeeded(){
    if (!GALGAME || !galSegmentEnded) return;
    galSegmentEnded = false;
    clearStageMessages();
  }
  // 段落收尾标记：停顿 / 分割线 / 标题之后即为一段结束
  function markSegmentEnd(){ if (GALGAME) galSegmentEnded = true; }

  const FADE_MS = 3000;
  const BG_CROSSFADE_MS = 500;

  // ===== 存档 / 读档（3 个槽位，localStorage）=====
  const GAME_KEY = 'storysave_' + (DATA.title || 'game');
  const saveMenu = document.getElementById('save-menu');
  const loadMenu = document.getElementById('load-menu');
  const tbSave = document.getElementById('tb-save');
  const tbLoad = document.getElementById('tb-load');
  const tbMusic = document.getElementById('tb-music');
  const tbSfx = document.getElementById('tb-sfx');
  const tbAutoplay = document.getElementById('tb-autoplay');
  const tbHistory = document.getElementById('tb-history');
  const historyCloseBtn = document.getElementById('history-close');
  function fmtTime(t){ if (!t) return ''; const d = new Date(t); const p = function(n){ return (n<10?'0':'')+n; }; return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
  // 刷新存档位时间，并同步两个独立界面（存档界面 sm-time-N / 读档界面 lm-time-N）；空槽位禁用「读取」
  function refreshSlotTimes(){
    for (let s = 1; s <= 3; s++){
      const raw = localStorage.getItem(GAME_KEY + '_' + s);
      const se = document.getElementById('sm-time-' + s);
      const le = document.getElementById('lm-time-' + s);
      const sline = document.getElementById('sm-line-' + s);
      const lline = document.getElementById('lm-line-' + s);
      const lbtn = loadMenu.querySelector('.sm-row[data-slot="' + s + '"] button[data-act="load"]');
      const has = !!raw;
      let timeTxt = '', lineTxt = '空槽位';
      if (has){ try { const st = JSON.parse(raw); timeTxt = fmtTime(st.t); lineTxt = (typeof st.lineText === 'string' && st.lineText) ? st.lineText : ''; } catch(e){ timeTxt = fmtTime(Date.now()); lineTxt = ''; } }
      [se, le].forEach(function(el){ if (!el) return; el.textContent = timeTxt; el.style.display = has ? '' : 'none'; });
      [sline, lline].forEach(function(el){ if (!el) return; el.textContent = lineTxt; el.classList.toggle('empty', !has); });
      if (lbtn) lbtn.disabled = !has;
    }
  }
  function openSaveMenu(){ refreshSlotTimes(); saveMenu.classList.add('open'); loadMenu.classList.remove('open'); }
  function openLoadMenu(){ refreshSlotTimes(); loadMenu.classList.add('open'); saveMenu.classList.remove('open'); }
  function closeMenus(){ saveMenu.classList.remove('open'); loadMenu.classList.remove('open'); }
  let toastTimer = null;
  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 1800);
  }
  // 黑屏转场：淡入黑屏 → 执行 midFn（清屏/读档/重开）→ 淡出黑屏
  function blackTransition(midFn){
    const f = document.getElementById('black-fade');
    if (!f){ try { midFn(); } catch(e){} return; }
    f.classList.add('show');                 // 淡入黑屏
    setTimeout(function(){
      try { midFn(); } finally {
        // 等两帧确保中间状态已渲染，再淡出黑屏
        requestAnimationFrame(function(){
          requestAnimationFrame(function(){ f.classList.remove('show'); });
        });
      }
    }, 350);                               // 与 CSS 过渡时长一致
  }
  function gotoNode(i){
    clearInterval(typingTimer); typing = false; awaitingClick = false; hint.style.display = 'none';
    endCard.style.display = 'none'; // 离开完结界面（重新开始）时隐藏完结卡
    if (itemOpen){ itemHint.classList.remove('show'); overlay.classList.remove('open'); frame.srcdoc = ''; itemOpen = false; }
    if (titleOverlay.classList.contains('show')){ titleOverlay.classList.remove('show', 'clickable'); }
    msgList.innerHTML = ''; msgList.scrollTop = 0; userScrolledUp = false; currentMsg = null;
    // 重新开始：清空文字历史与段状态，新一局从空开始累积
    historyItems.length = 0; galSegmentEnded = false; if (historyOpen) renderHistory();
    hideOptions();
    stopAllMusic();
    startGame();   // 从起始块（主剧情）重新开始
    scheduleContrast();
  }
  // 立即设置背景（无叠化动画），用于读档还原。spec: {src} | {color} | null
  function restoreBackground(spec){
    if (bgFadeTimer){ clearTimeout(bgFadeTimer); bgFadeTimer = null; }
    currentBgSrc = (spec && spec.src) || '';
    currentBgColor = (spec && spec.color) || '';
    _paintLayer(bgA, spec);
    bgA.style.opacity = '1';
    _paintLayer(bgB, null);
    bgB.style.opacity = '0';
    activeBg = bgA; altBg = bgB;
    _rebuildBgSample();
  }
  // ===== 懒加载 Toy SDK（关键：绝不阻塞游戏开局）=====
  // srcdoc iframe 的基地址是 about:srcdoc，<head> 里放阻塞式 <script src> 会让整页渲染卡住导致黑屏。
  // 故改为：需要时才动态注入 async 脚本；window.toy 已存在（B站客户端注入）则直接回调。
  var _toyP = null;
  function ensureToy(cb){
    if (window.toy){ cb(window.toy); return; }
    if (_toyP){ _toyP.then(cb); return; }
    let resolveP; _toyP = new Promise(function(r){ resolveP = r; });
    _toyP.then(cb);
    const finish = function(t){ try { resolveP(t || null); } catch(e){} };
    try {
      const s = document.createElement('script');
      s.src = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';
      s.async = true;
      s.onload = function(){ finish(window.toy || null); };
      s.onerror = function(){ finish(null); };
      document.head.appendChild(s);
      setTimeout(function(){ if (!window.toy) finish(null); }, 2500); // 超时回退
    } catch(e){ finish(null); }
  }
  // ===== 存档 / 读档（基于「节点重放」）=====
  // 设计：存当前精确位置 { block: 当前块, idx: 当前节点下标, choices: 选项序列, music, t }（极小，云存档也够用）。
  // 读档时不恢复文字「内容」，而是从开头「重放」到 (block, idx)：沿途所有文字/背景/音乐状态重新生成，
  // 从而既保留存档点【之上】的全部文字，又无需把整段历史写进存档（云存档 1024 字节不超标）。
  // choices 仅用于在「选项」节点决定走哪条分支；block+idx 精确定位存档点（线性剧情 / 段落中途存档也能正确还原，不再从头）。
  async function saveTo(slot){
    const messages = [];
    for (const el of msgList.children){ if (el === currentMsg) continue; messages.push(el.innerHTML); }
    const lineNo = messages.length; // 已完成文字行数
    const _curLineEl = currentMsg || msgList.lastElementChild;
    const lineText = _curLineEl ? (_curLineEl.textContent || '').trim().slice(0, 200) : '';
    const compact = { choices: recordedChoices.slice(), block: curBlock, idx: curIdx, line: lineNo, lineText: lineText, music: currentMusicName, t: Date.now() };
    // 本地兜底（同步、必成功）
    try { localStorage.setItem(GAME_KEY + '_' + slot, JSON.stringify(compact)); } catch(e){}
    // 云存档（B站账号隔离、跨设备持久化）：懒加载 SDK 后尝试，失败不影响本地
    ensureToy(async function(toy){
      if (!toy || typeof toy.isSupport !== 'function') return;
      try {
        if (await toy.isSupport('setCloudStorage')){ await toy.setCloudStorage({ ['save' + slot]: JSON.stringify(compact) }); }
      } catch(e){ /* 云失败，本地已在 */ }
    });
    refreshSlotTimes();
    toast('已存档到槽位 ' + slot);
    closeMenus();
  }
  async function loadFrom(slot){
    closeMenus();
    // 本地优先：同步读取，立即可靠（不依赖 Toy SDK / 网络，普通浏览器与本地导出都能用）
    let raw = null;
    try { raw = localStorage.getItem(GAME_KEY + '_' + slot); } catch(e){}
    if (raw){
      let st = null; try { st = JSON.parse(raw); } catch(e){}
      if (st && (Array.isArray(st.choices) || typeof st.idx === 'number')){
        blackTransition(function(){ replayTo(st); });
        toast('读档成功');
        refreshSlotTimes();
        return;
      }
    }
    // 本地无存档 → 尝试云存档（B站客户端内跨设备）。加 3s 超时，避免外部 SDK 卡死导致读档无响应
    ensureToy(async function(toy){
      if (!toy || typeof toy.isSupport !== 'function'){ toast('该槽位没有存档'); return; }
      try {
        if (await toy.isSupport('getCloudStorage')){
          const res = await Promise.race([
            toy.getCloudStorage(['save' + slot]),
            new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('cloud-timeout')); }, 3000); })
          ]);
          const c = res && res['save' + slot];
          if (c){ let st = null; try { st = JSON.parse(c); } catch(e){} if (st && (Array.isArray(st.choices) || typeof st.idx === 'number')){ blackTransition(function(){ replayTo(st); }); toast('读档成功'); refreshSlotTimes(); return; } }
        }
      } catch(e){ /* 云读取异常/超时，按无存档处理 */ }
      toast('该槽位没有存档');
    });
  }
  // 从起始块开始，按已记录的选项序列快进到存档点：重建文字/背景/音乐，不打字、不等待点击。
  // 快进结束后从存档点继续正常播放（文本按原样重新出现/执行）。
  function replayTo(save){
    // 清空对话流，但保留「完」卡（它是 msgList 的子节点，innerHTML='' 会把它一并移除，导致下方 getElementById 失效）
    Array.from(msgList.children).forEach(function(c){ if (c !== endCard) msgList.removeChild(c); });
    msgList.scrollTop = 0; userScrolledUp = false;
    typing = false; currentMsg = null; awaitingClick = false; hint.style.display = 'none';
    // 读档：清空文字历史与段状态，由 fastReplay 沿重放路径重新构造历史 + 段边界
    historyItems.length = 0; galSegmentEnded = false; if (historyOpen) renderHistory();
    endCard.style.display = 'none'; // 从完结界面读取存档时隐藏完结卡
    if (itemOpen){ itemHint.classList.remove('show'); overlay.classList.remove('open'); frame.srcdoc = ''; itemOpen = false; }
    if (titleOverlay.classList.contains('show')){ titleOverlay.classList.remove('show', 'clickable'); }
    stopAllMusic();
    hideOptions();
    curBlock = DATA.start || '__MAIN__'; curIdx = 0; stack = [];
    recordedChoices = (save.choices && save.choices.slice) ? save.choices.slice() : [];
    // 精确存档点：块名 + 节点下标。旧存档无此字段时 targetIdx 为 null，退化为「从头重放」旧行为
    const targetBlock = (typeof save.block === 'string' && save.block) ? save.block : (DATA.start || '__MAIN__');
    const targetIdx = (typeof save.idx === 'number') ? save.idx : null;
    scrollToBottom();
    scheduleContrast();
    // 读档重建变量：先从变量库默认值重置，再由 fastReplay 沿重放路径精确应用一次 <变量> 操作。
    // 否则 vars 会叠加在「当前运行时值」之上，导致多次读档时变量变动被重复累加。
    vars = Object.assign({}, (DATA.variables) || {});
    fastReplay(recordedChoices.slice(), targetBlock, targetIdx);
  }
  if (tbSave) tbSave.addEventListener('click', function(e){ e.stopPropagation(); saveMenu.classList.contains('open') ? closeMenus() : openSaveMenu(); });
  if (tbLoad) tbLoad.addEventListener('click', function(e){ e.stopPropagation(); loadMenu.classList.contains('open') ? closeMenus() : openLoadMenu(); });

  // 文字历史：把全程已读文本（两种模式都记）暂时唤出供玩家滚动回看；不影响 stage 推进逻辑
  function renderHistory(){
    if (!historyBody) return;
    if (!historyItems.length){
      historyBody.innerHTML = '<div id="history-empty">还没有已读文本</div>';
      return;
    }
    // 直接拼接每条 hp-item；divider 项自带 hp-item.divider 标记，CSS 用相同样式
    const html = historyItems.map(function(it){ return '<div class="hp-item-wrap">' + it.html + '</div>'; }).join('');
    historyBody.innerHTML = html;
    // 滚到最底，便于看到最新一段
    historyBody.scrollTop = historyBody.scrollHeight;
  }
  function openHistory(){
    if (!historyPanel) return;
    historyOpen = true;
    closeMenus(); // 与存档/读档菜单互斥
    renderHistory();
    historyPanel.classList.add('open');
    if (tbHistory) tbHistory.classList.add('active');
  }
  function closeHistory(){
    if (!historyPanel) return;
    historyOpen = false;
    historyPanel.classList.remove('open');
    if (tbHistory) tbHistory.classList.remove('active');
  }
  if (tbHistory) tbHistory.addEventListener('click', function(e){ e.stopPropagation(); historyOpen ? closeHistory() : openHistory(); });
  if (historyCloseBtn) historyCloseBtn.addEventListener('click', function(e){ e.stopPropagation(); closeHistory(); });
  // 面板内点击（除关闭按钮外）不冒泡到 stage，避免误推进剧情；点击遮罩空白处关闭
  if (historyPanel) historyPanel.addEventListener('click', function(e){
    if (e.target === historyPanel) closeHistory();
    else e.stopPropagation();
  });
  // 音乐 / 音效 静音开关：点击在「静音（音量归零）」与「出声」之间切换
  if (tbMusic) tbMusic.addEventListener('click', function(e){ e.stopPropagation(); musicMuted = !musicMuted; applyMusicMute(); updateMuteButtons(); });
  if (tbSfx) tbSfx.addEventListener('click', function(e){ e.stopPropagation(); sfxMuted = !sfxMuted; updateMuteButtons(); });
  // 自动播放开关：开启后每次停顿（awaitingClick / 标题）2.5 秒自动继续；选项不自动选
  if (tbAutoplay) tbAutoplay.addEventListener('click', function(e){
    e.stopPropagation();
    autoPlay = !autoPlay;
    updateAutoPlayButton();
    if (autoPlay){
      if (awaitingClick) scheduleAutoPlay();
      else if (titleOverlay.classList.contains('show')){ clearAutoPlayTimer(); autoPlayTimer = setTimeout(function(){ autoPlayTimer = null; if (titleOverlay.classList.contains('show')){ titleOverlay.classList.remove('show', 'clickable'); if (_titleOnClick) titleOverlay.removeEventListener('click', _titleOnClick); advance(); } }, 2500); }
    } else {
      clearAutoPlayTimer();
    }
  });
  updateMuteButtons();
  if (saveMenu) saveMenu.addEventListener('click', function(e){ e.stopPropagation(); });
  if (loadMenu) loadMenu.addEventListener('click', function(e){ e.stopPropagation(); });
  document.getElementById('sm-close').addEventListener('click', function(e){ e.stopPropagation(); closeMenus(); });
  document.getElementById('lm-close').addEventListener('click', function(e){ e.stopPropagation(); closeMenus(); });
  // 点击横栏 / 弹层以外的区域时关闭弹层
  document.addEventListener('click', function(e){
    if (!saveMenu.classList.contains('open') && !loadMenu.classList.contains('open')) return;
    if (saveMenu.contains(e.target) || loadMenu.contains(e.target)) return;
    if (e.target === tbSave || e.target === tbLoad || (e.target.parentNode && (e.target.parentNode === tbMusic || e.target.parentNode === tbSfx))) return;
    closeMenus();
  });
  [saveMenu, loadMenu].forEach(function(menu){
    menu.querySelectorAll('.sm-row').forEach(function(row){
      const slot = row.getAttribute('data-slot');
      row.querySelectorAll('button').forEach(function(b){
        b.addEventListener('click', function(e){
          e.stopPropagation();
          if (b.getAttribute('data-act') === 'save') saveTo(slot); else loadFrom(slot);
        });
      });
    });
  });
  // 完结界面：作者 + 重新开始 + 读取存档
  document.getElementById('end-author').textContent = (DATA.global && DATA.global.authorId) || '—';
  document.getElementById('end-restart').addEventListener('click', function(e){ e.stopPropagation(); blackTransition(function(){ gotoNode(0); }); });
  document.getElementById('end-load').addEventListener('click', function(e){ e.stopPropagation(); openLoadMenu(); });

  // 分支引擎状态：当前块 / 当前节点下标 / 调用栈 / 选项记录（存档用）/ 重放标志
  let curBlock = DATA.start || '__MAIN__';
  let curIdx = 0;
  let lastTextContent = '';       // 最近一次显示的文字节点原文（供编辑器「审阅」取当前上下文）
  let stack = [];                 // 调用栈：[{ block, idx }]
  let lastOptions = null;         // 最近一次选项所在位置 { block, idx }（跳回重选用）
  let recordedChoices = [];       // 沿路选项选择序列（读档重放用）
  let replaying = false;
  let typing = false, currentHtml = '', fullLen = 0, revealed = 0, awaitingClick = false, itemOpen = false, bgMusic = null, fadingMusics = [], typingTimer = null, currentMsg = null;
  let currentBgSrc = '', currentBgColor = '', currentMusicName = null;
  const soundCache = {}; // 音效播放实例缓存（模板内使用，避免 stopAllMusic 引用未定义而崩溃）
  let vars = {}; // 变量运行时状态（由 startGame 从 DATA.variables 初始化）
  let autoPlay = false;       // 自动播放开关
  let autoPlayTimer = null;   // 停顿后自动继续的计时器
  let _titleOnClick = null;   // 当前标题点击处理器（供自动播放开关在标题显示中开启时复用）

  // 自动滚动到底部（除非用户主动上翻）
  let userScrolledUp = false;
  msgList.addEventListener('scroll', function(){
    const atBottom = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 40;
    userScrolledUp = !atBottom;
    scheduleContrast();   // 滚动时实时按背景亮度调整文字颜色
  });
  function scrollToBottom(){ if (!userScrolledUp) msgList.scrollTo({ top: msgList.scrollHeight, behavior: 'auto' }); }

  // ===== 文字自动对比色（根据背景亮度实时调整）=====
  // 背景对比度处理（文字对比度保护）：
  //   - 自动按「整张背景的平均亮度」决定用黑字还是白字；
  //   - 然后对整个背景层做 brightness() 调暗/调亮，把对比度拉到 WCAG AA（4.5:1）以上，
  //     这样无需给每段文字加底板，避免底板跳闪。
  //   - 额外提供「长按 1 秒隐藏文字看背景原图」功能（见 reveal-bg）。
  // TEXT_CONTRAST: 'off' 关闭 | 'auto' 选字色 + 调暗/调亮背景（默认）
  const TEXT_CONTRAST = '__TEXT_CONTRAST__';
  // PLAY_MODE: 'longform' 长文模式（文字累积滚动）| 'galgame' galgame模式（底部黑色文本框，逐段显示）
  // galgame 模式下文本框自带对比度，不再给背景加明暗蒙版（updateAllContrast 与 CSS 双重保证）
  const PLAY_MODE = '__PLAY_MODE__';
  const GALGAME = PLAY_MODE === 'galgame';
  if (GALGAME) document.body.classList.add('galgame');
  const _bgCanvas = document.createElement('canvas');
  const _bgCtx = _bgCanvas.getContext('2d', { willReadFrequently: true });
  let _bgData = null, _bgReady = false;
  let _bgDx = 0, _bgDy = 0, _bgDw = 0, _bgDh = 0; // 背景图在屏幕上的渲染矩形（用于识别黑边）
  let _bgContrastRes = null; // 缓存的对比方案 { textLight }，仅在背景变化/尺寸变化时重算
  const _BODY_LUM = 0.023; // 黑边（body 背景 #0a0c12）的相对亮度近似值
  function _rebuildBgSample(){
    const w = window.innerWidth, h = window.innerHeight;
    _bgData = null; _bgReady = false; _bgContrastRes = null;
    if (!w || !h){ updateAllContrast(); return; }
    _bgCanvas.width = w; _bgCanvas.height = h;
    const color = currentBgColor;
    if (color){
      // 纯色背景：直接把整块画布填成该颜色，供对比度算法采样
      _bgCtx.clearRect(0, 0, w, h);
      _bgCtx.fillStyle = color;
      _bgCtx.fillRect(0, 0, w, h);
      _bgData = _bgCtx.getImageData(0, 0, w, h);
      _bgReady = true;
      _bgDx = 0; _bgDy = 0; _bgDw = w; _bgDh = h;
      _recomputeContrast();
      return;
    }
    const src = currentBgSrc;
    if (!src){ updateAllContrast(); return; }
    const img = new Image();
    img.onload = function(){
      try {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        const scale = h / ih;   // 垂直铺满：高度=视口高，宽度按比例（与 background-size: auto 100% 一致）
        const dw = iw * scale, dh = ih * scale;
        const dx = (w - dw) / 2, dy = (h - dh) / 2;
        _bgDx = dx; _bgDy = dy; _bgDw = dw; _bgDh = dh;
        _bgCtx.clearRect(0, 0, w, h);
        _bgCtx.drawImage(img, dx, dy, dw, dh);
        _bgData = _bgCtx.getImageData(0, 0, w, h);
        _bgReady = true;
        _recomputeContrast();
      } catch(e){ _bgData = null; _bgReady = false; _bgDx = _bgDy = _bgDw = _bgDh = 0; } // 跨域图片会污染 canvas → 退化默认白字
    };
    img.onerror = function(){ _bgData = null; _bgReady = false; _bgDx = _bgDy = _bgDw = _bgDh = 0; };
    img.src = src;
  }
  // sRGB 相对亮度（0~1）
  function _relLum(r, g, b){
    const f = function(c){ c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  // 对比度（WCAG），l1、l2 为相对亮度
  function _contrast(l1, l2){ const a = Math.max(l1, l2) + 0.05, b = Math.min(l1, l2) + 0.05; return a / b; }
  // 取屏幕坐标 (x,y) 处背景的相对亮度；落在黑边区返回 body 亮度近似值
  function _sampleLum(x, y){
    if (!_bgReady || !_bgData) return null;
    x = x | 0; y = y | 0;
    if (x < _bgDx || x > _bgDx + _bgDw || y < _bgDy || y > _bgDy + _bgDh) return _BODY_LUM; // 黑边
    x = Math.max(0, Math.min(_bgCanvas.width - 1, x));
    y = Math.max(0, Math.min(_bgCanvas.height - 1, y));
    const i = (y * _bgCanvas.width + x) * 4, d = _bgData.data;
    return _relLum(d[i], d[i + 1], d[i + 2]);
  }
  // 计算整张背景的对比度调整方案：决定全局字色（黑/白）+ 背景亮度调整因子。
  // 返回 { textLight } 或 null（关闭 / 无背景）。
  function _computeBgContrast(){
    if (TEXT_CONTRAST === 'off') return null;
    if (!_bgReady || !_bgData) return null;
    const d = _bgData.data, W = _bgCanvas.width, H = _bgCanvas.height;
    // 仅采样背景图实际可见区域：横图（auto 100% 时 dw > 屏宽）_bgDx 为负、竖图有黑边，
    // 必须把采样矩形 clamp 到画布内，否则会读到 d[负数] = undefined → NaN，把 avg 污染成 NaN，
    // 进而 NaN<0.5 恒为 false → 误判为亮背景、给暗图配上黑字。
    const x0 = Math.max(0, _bgDx | 0), x1 = Math.min(W, (_bgDx + _bgDw) | 0);
    const y0 = Math.max(0, _bgDy | 0), y1 = Math.min(H, (_bgDy + _bgDh) | 0);
    let n = 0, sum = 0, minL = 1, maxL = 0, valid = false;
    const vs = []; // HSV Value（max channel）采样集合，用于判断人眼感知的整体明暗
    const step = 4; // 隔点采样，足够刻画亮度分布
    for (let y = y0; y < y1; y += step){
      const row = y * W;
      for (let x = x0; x < x1; x += step){
        const i = (row + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const L = _relLum(r, g, b);
        if (!(L >= 0)) continue; // 跳过 NaN / 异常像素
        valid = true;
        sum += L; n++;
        const V = Math.max(r, g, b) / 255;
        vs.push(V);
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
      }
    }
    if (!valid || n === 0) return null;
    vs.sort(function (a, b) { return a - b; });
    const medianV = vs[Math.floor(vs.length / 2)];
    const avg = sum / n;
    // 用人眼感知的亮度（HSV Value 中位数）判定整体明暗，而非 sRGB 相对亮度。
    // 亮像素图里常有深蓝/深绿或深色轮廓，sRGB 亮度会被拉低；示例截图 avg≈0.45
    // 但视觉上很亮，medianV 通常 > 0.5，正确识别为亮背景 → 黑字。
    const textLight = medianV < 0.5; // 感知偏暗 → 白字；偏亮 → 黑字
    return { textLight: textLight };
  }
  function _updateContrastFor(msg, textLight){
    if (!msg.classList.contains('message') || msg.classList.contains('divider')) return;
    msg.classList.remove('auto-dark', 'auto-light');
    if (textLight === null || textLight === undefined) return;
    msg.classList.add(textLight ? 'auto-light' : 'auto-dark');
  }
  // 背景（图片/纯色）变化或窗口尺寸变化时调用：重算一次对比方案并应用到所有消息
  function _recomputeContrast(){
    _bgContrastRes = _computeBgContrast();
    updateAllContrast();
  }
  // 应用已缓存的对比方案（不再每帧重采样整张背景：O(消息数) 而非整屏计算，避免打字卡顿）
  function updateAllContrast(){
    const res = _bgContrastRes;
    // galgame 模式：文字在黑色文本框内（CSS 已固定为白字），背景保持原图不加蒙版
    if (GALGAME){
      if (bgOverlay) bgOverlay.style.opacity = '0';
      for (let i = 0; i < msgList.children.length; i++){ _updateContrastFor(msgList.children[i], null); }
      return;
    }
    if (!res){
      if (bgOverlay) bgOverlay.style.opacity = '0';
      for (let i = 0; i < msgList.children.length; i++){ _updateContrastFor(msgList.children[i], null); }
      return;
    }
    // 亮背景（黑字）时显示半透明白色蒙版，提升黑字在深色区域的 readability；
    // 暗背景（白字）时显示半透明黑色蒙版，避免浅色区域冲掉白字。两者都用 0.45 强度。
    if (!res){
      if (bgOverlay) bgOverlay.style.opacity = '0';
    } else if (res.textLight){
      // 暗背景 + 白字：半透明黑色蒙版
      bgOverlay.style.background = 'rgba(0,0,0,0.45)';
      bgOverlay.style.opacity = '1';
    } else {
      // 亮背景 + 黑字：半透明白色蒙版
      bgOverlay.style.background = 'rgba(255,255,255,0.45)';
      bgOverlay.style.opacity = '1';
    }
    for (let i = 0; i < msgList.children.length; i++){ _updateContrastFor(msgList.children[i], res.textLight); }
  }
  // 兼容旧调用点：对比方案已缓存，这里直接套用即可（不再每帧重采样整张背景）
  function scheduleContrast(){ updateAllContrast(); }

  function nodesOf(b){ return (DATA.blocks && DATA.blocks[b]) || []; }
  function curNode(){ const ns = nodesOf(curBlock); return ns[curIdx]; }
  // 从起始块开始一局新游戏；若预览指定了 __previewFrom，则从光标所在节点开播
  function startGame(){
    clearOverlay();
    if (DATA.__previewFrom && DATA.blocks && DATA.blocks[DATA.__previewFrom.block]) {
      curBlock = DATA.__previewFrom.block;
      const ns = nodesOf(curBlock);
      curIdx = Math.max(0, Math.min(DATA.__previewFrom.idx | 0, ns.length - 1));
    } else {
      curBlock = DATA.start || '__MAIN__';
      curIdx = 0;
    }
    stack = []; lastOptions = null; recordedChoices = []; replaying = false;
    vars = Object.assign({}, (DATA.variables) || {});
    execCur();
  }
  // 在当前块内前进一格；到块尾则按调用栈返回（栈空即结局）
  function advance(){
    clearAutoPlayTimer();
    curIdx++;
    if (curIdx >= nodesOf(curBlock).length) doReturn();
    else execCur();
  }
  // 自动播放：进入「停顿」（awaitingClick）后，2.5 秒自动继续；选项界面不自动选择（避免乱入分支）
  function clearAutoPlayTimer(){ if (autoPlayTimer){ clearTimeout(autoPlayTimer); autoPlayTimer = null; } }
  function scheduleAutoPlay(){
    clearAutoPlayTimer();
    if (!autoPlay) return;
    autoPlayTimer = setTimeout(function(){
      autoPlayTimer = null;
      if (awaitingClick){ awaitingClick = false; hint.style.display = 'none'; advance(); }
    }, 2500);
  }
  function updateAutoPlayButton(){
    const b = document.getElementById('tb-autoplay');
    if (!b) return;
    b.classList.toggle('active', autoPlay);
    const ic = b.querySelector('.ic');
    if (ic) ic.textContent = autoPlay ? '⏸' : '▶';
  }
  // 进入剧情块：压栈（返回地址=当前节点下一格），跳转至该块开头
  function callBlock(name){
    stack.push({ block: curBlock, idx: curIdx + 1 });
    curBlock = name; curIdx = 0;
  }
  // 返回上一层；栈空则结局
  function doReturn(){
    if (stack.length){ const r = stack.pop(); curBlock = r.block; curIdx = r.idx; }
    execCur();
  }
  // 跳回重选：回到最近一次选项所在处，重新展示选项让玩家再做一次选择
  function doReturnRechoose(){
    if (lastOptions){ curBlock = lastOptions.block; curIdx = lastOptions.idx; execCur(); }
    else if (stack.length){ doReturn(); }   // 没有历史选项则退化为普通跳回
    else { finish(); }
  }
  // 选项 UI：底部排列按钮（最多 6 个）；条件不满足的选项直接隐藏（不渲染），仅保留满足条件的
  function presentOptions(n){
    awaitingClick = false; hint.style.display = 'none';
    hideOptions();
    lastOptions = { block: curBlock, idx: curIdx }; // 记录位置，供 <跳回重选> 回到此处重选
    const bar = document.getElementById('options-bar');
    if (!bar) return;
    const opts = (n.options || []).slice(0, 6);
    let anyEnabled = false;
    let shown = 0;
    opts.forEach(function(opt, ci){
      // 条件不满足：直接隐藏该选项（不渲染按钮），对玩家完全不可见
      if (opt.condition && !evalCond(opt.condition)) return;
      anyEnabled = true;
      const btn = document.createElement('button');
      btn.className = 'opt-btn';
      btn.textContent = opt.text || ('选项' + (shown + 1));
      btn.style.animationDelay = (shown * 0.05) + 's';
      shown++;
      // 注意：ci 是原始选项下标，用于 recordedChoices 存档 / 读档重放还原选择路径
      btn.addEventListener('click', function(e){
        e.stopPropagation();   // 同「开始游戏」按钮：阻止冒泡到 #stage 的全局点击监听，否则本次点击会被误判为「跳过新块第一段打字」
        userScrolledUp = false; // 选项点击同样强制滚到底
        hideOptions();
        recordedChoices.push(ci);
        // galgame 模式：点击选项即视为进入新场景/新段，标记段已结束；
        // 下一次 typeText / showDivider 登场前 beginSegmentIfNeeded() 会清空旧文字，进入新对话框
        markSegmentEnd();
        if (opt.block){ callBlock(opt.block); execCur(); }
        else { curIdx++; execCur(); }
      });
      bar.appendChild(btn);
    });
    // 同行所有选项条件都不满足：本行自动跳过，继续推进（避免卡死）
    if (!anyEnabled) {
      hideOptions();
      curIdx++;
      if (curIdx >= nodesOf(curBlock).length) doReturn();
      else execCur();
      return;
    }
    bar.classList.add('show');
  }
  function hideOptions(){
    const bar = document.getElementById('options-bar');
    if (bar){ bar.innerHTML = ''; bar.classList.remove('show'); }
  }
  function execCur(){
    const n = curNode();
    if (!n){ finish(); return; }
    if (n.type === 'text') typeText(n.content || '');
    else if (n.type === 'pause') doPause(n.ms || 0);
    else if (n.type === 'title') showTitle(n.text || '');
    else if (n.type === 'summon') doSummon(n);
    else if (n.type === 'stopmusic') stopMusic();
    else if (n.type === 'clearoverlay') clearOverlay();
    else if (n.type === 'divider') showDivider(n.text || '');
    else if (n.type === 'block') { callBlock(n.name); execCur(); }
    else if (n.type === 'return') { doReturn(); }
    else if (n.type === 'returnrechoose') { doReturnRechoose(); }
    else if (n.type === 'varop') { applyVarOps(n.ops); advance(); }
    else if (n.type === 'options') { presentOptions(n); }
    else advance();
  }
  // 读档重放：按已记录的选项序列快进到存档点（不打字、不等待点击）
  // ===== 变量运行时 =====
  // 把 {名} / {名:是|否} 替换为当前变量值；未定义变量保留原样；{{名}} 转义保留
  function interpolateVars(s){
    return String(s).replace(/\{\{?\s*([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(?::\s*([^}\s|]*)\s*\|\s*([^}]*))?\s*\}/g, function(m, name, t, f){
      if (m.charAt(1) === '{') return m; // 双花括号转义
      let val = vars[name];
      if (val === undefined) return m;
      if (t !== undefined && f !== undefined){
        const isTrue = (val === true || val === 'true' || val === 1 || val === '1');
        return isTrue ? t : f;
      }
      if (val === true) return '真';
      if (val === false) return '假';
      return String(val);
    });
  }
  function truthy(v){ return v === true || v === 'true' || v === 1 || v === '1' || v === '是' || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v.length > 0 && v !== 'false' && v !== '否' && v !== '0'); }
  function evalOneCond(e){
    if (e.charAt(0) === '!') { const nm = e.slice(1).trim(); return !truthy(vars[nm]); }
    if (/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(e)) { return truthy(vars[e]); }
    const m = e.match(/^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(>=|<=|==|!=|>|<|=)\s*(.+)$/);
    if (!m) return false;
    const name = m[1], op = m[2], rv = m[3].trim();
    const lv = vars[name];
    let rvv;
    if (rv === 'true') rvv = true; else if (rv === 'false') rvv = false;
    else if (/^-?\d+(\.\d+)?$/.test(rv)) rvv = Number(rv);
    else rvv = rv;
    switch (op){
      case '>': return Number(lv) > Number(rvv);
      case '<': return Number(lv) < Number(rvv);
      case '>=': return Number(lv) >= Number(rvv);
      case '<=': return Number(lv) <= Number(rvv);
      case '==': case '=': return lv == rvv;
      case '!=': return lv != rvv;
    }
    return false;
  }
  function evalCond(expr){
    if (!expr) return true;
    if (expr.indexOf('&&') >= 0) return expr.split('&&').every(function(p){ return evalOneCond(p.trim()); });
    if (expr.indexOf('||') >= 0) return expr.split('||').some(function(p){ return evalOneCond(p.trim()); });
    return evalOneCond(expr.trim());
  }
  function applyVarOps(ops){
    (ops || []).forEach(function(o){
      const cur = vars[o.name];
      if (o.op === '='){
        let v = o.val;
        if (v === 'true') vars[o.name] = true;
        else if (v === 'false') vars[o.name] = false;
        else if (/^-?\d+(\.\d+)?$/.test(v)) vars[o.name] = Number(v);
        else vars[o.name] = v;
      } else if (o.op === '+'){
        const base = (typeof cur === 'number') ? cur : (Number(cur) || 0);
        vars[o.name] = base + (Number(o.val) || 0);
      } else if (o.op === '-'){
        const base = (typeof cur === 'number') ? cur : (Number(cur) || 0);
        vars[o.name] = base - (Number(o.val) || 0);
      }
    });
  }

  function fastReplay(choices, targetBlock, targetIdx){
    replaying = true;
    hideOptions();
    let guard = 0;
    while (guard++ < 200000){
      // 到达存档精确节点：停在此处并继续正常播放（打字 / 展示选项），途中文字已在下方被重建
      if (targetIdx !== null && curBlock === targetBlock && curIdx >= targetIdx){
        replaying = false; execCur(); return;
      }
      // 旧存档（无精确位置）或分支已走到尽头：从当前节点继续播放（线性剧情读档的唯一出口）
      if (!choices.length && targetIdx === null){
        replaying = false; execCur(); return;
      }
      const n = curNode();
      if (!n){ doReturn(); if (!curNode()){ replaying = false; finish(); return; } continue; }
      if (n.type === 'options'){
        if (choices.length){
          const ci = choices.shift();
          const opt = (n.options && n.options[ci]) || (n.options && n.options[0]) || null;
          // 选项跳转等价于「进入新段」：galgame 模式下 fastApply 的下一个 text/divider 会触发 beginSegmentIfNeeded 清屏
          markSegmentEnd();
          if (opt && opt.block){ callBlock(opt.block); }
          else { curIdx++; }
        } else if (targetIdx === null){
          // 无选择记录且未到精确目标：停在选项处让玩家重新选择（兼容旧存档）
          replaying = false; execCur(); return;
        } else {
          curIdx++; // 有精确目标但缺记录：默认继续，避免卡死
        }
        continue;
      }
      if (n.type === 'block'){ callBlock(n.name); continue; }
      if (n.type === 'return'){ doReturn(); continue; }
      if (n.type === 'returnrechoose'){ doReturn(); continue; }   // 重放阶段无 UI，退化为普通跳回
      if (n.type === 'varop'){ applyVarOps(n.ops); curIdx++; continue; }  // 重放阶段必须重建变量状态，否则读档后 {名} 变回字面量
      fastApply(n);   // text / pause / title / divider / summon / stopmusic
      curIdx++;
    }
    replaying = false;
    execCur();
  }
  // 重放阶段对各节点类型的快进应用（仅重建可见状态，不等待）
  function fastApply(n){
    if (n.type === 'text'){
      lastTextContent = n.content || '';
      const html = bbcodeToHtml(interpolateVars(n.content || ''));
      pushHistory(html, false);
      // galgame 读档重放也要「每段换新文字」：与 typeText 行为对齐，按段边界清屏
      beginSegmentIfNeeded();
      const d = document.createElement('div');
      d.className = 'message';
      d.innerHTML = html;
      msgList.appendChild(d);
    } else if (n.type === 'divider'){
      // 历史面板保存格式（与 showDivider 一致：hp-item 包裹）
      let divHtml = '<div class="hp-item divider">';
      const divText = interpolateVars(n.text || '');
      if (n.text){ divHtml += '<span class="divider-line"></span><span class="divider-text">' + bbcodeToHtml(divText) + '</span><span class="divider-line"></span>'; }
      else { divHtml += '<span class="divider-line"></span>'; }
      divHtml += '</div>';
      pushHistory(divHtml, true);
      beginSegmentIfNeeded();
      const d = document.createElement('div'); d.className = 'message divider';
      if (n.text){ const t=document.createElement('span'); t.className='divider-text'; t.innerHTML=bbcodeToHtml(divText); const l1=document.createElement('span'); l1.className='divider-line'; const l2=document.createElement('span'); l2.className='divider-line'; d.appendChild(l1); d.appendChild(t); d.appendChild(l2); }
      else { const l=document.createElement('span'); l.className='divider-line'; d.appendChild(l); }
      msgList.appendChild(d);
      markSegmentEnd(); // 分割线收尾，下一段换屏
    } else if (n.type === 'pause'){
      // 重放阶段按段边界处理：停顿本身不呈现，但标记段已结束，下一条文字清屏
      markSegmentEnd();
    } else if (n.type === 'summon'){
      if (n.kind === 'background'){ const a = findAsset('background', n); restoreBackground(a && a.kind === 'solid' ? { color: a.color || '#000000' } : { src: a && a.src ? a.src : '' }); }
      else if (n.kind === 'music'){ stopAllMusic(); const a = findAsset('music', n); if (a && a.src){ const m = new Audio(a.src); m.loop = true; m.volume = musicMuted ? 0 : MUSIC_VOL; m.play().catch(function(){}); bgMusic = m; currentMusicName = a.name || null; } }
      else if (n.kind === 'overlay'){ const a = findAsset('overlay', n); setOverlay(a && a.src ? a.src : ''); }
      // item / sound 重放阶段不实际呈现
    } else if (n.type === 'stopmusic'){ stopAllMusic(); }
    else if (n.type === 'clearoverlay'){ clearOverlay(); }
    // pause / title 重放阶段跳过（不影响已显示文字）
  }
  function stopMusic(){
    // 3 秒内渐出当前背景音乐
    if (bgMusic){ fadeOutMusic(bgMusic); bgMusic = null; }
    currentMusicName = null;
    advance();
  }
  function typeText(content){
    lastTextContent = content || '';
    // galgame 模式：上一段(停顿/分割线/标题 收尾)结束后，下一条文字登场前清空文本框，确保「每段直接换新文字」
    beginSegmentIfNeeded();
    // 历史在打字开始时就推一条完整 HTML（这样打开历史面板能立刻看到这条，不管打字到没到字）
    const finalHtml = bbcodeToHtml(interpolateVars(content || ''));
    pushHistory(finalHtml, false);
    // 创建一条新消息气泡
    const msg = document.createElement('div');
    msg.className = 'message typing';
    msgList.appendChild(msg);
    currentMsg = msg;
    content = interpolateVars(content);
    currentHtml = bbcodeToHtml(content);
    fullLen = bbcodeTextLength(content);
    revealed = 0; typing = true; hint.style.display = 'none';
    msg.innerHTML = revealHtml(currentHtml, 0);
    _updateContrastFor(msg, _bgContrastRes ? _bgContrastRes.textLight : null); // 新消息按当前背景一次性定字色（打字中背景不变，无需每字重算）
    scrollToBottom();
    const speed = 30;
    clearInterval(typingTimer);
    typingTimer = setInterval(function(){
      revealed++;
      msg.innerHTML = revealHtml(currentHtml, revealed);
      scrollToBottom();
      if (revealed >= fullLen){ clearInterval(typingTimer); typing = false; msg.classList.remove('typing'); currentMsg = null; advance(); }
    }, speed);
  }
  function doPause(ms){
    awaitingClick = true; hint.style.display = 'block';
    if (ms > 0){ setTimeout(function(){ if (awaitingClick){ awaitingClick = false; hint.style.display = 'none'; advance(); } }, ms); }
    scheduleAutoPlay();
    // galgame 模式：停顿本身就是段边界，下一段文字/分割线出现前自动清屏换新文字
    markSegmentEnd();
  }
  function fitTitle(){
    // 缩放到单行宽度内（窄屏自动缩小，不换行）
    let size = 48;
    titleText.style.fontSize = size + 'px';
    const avail = window.innerWidth * 0.96;
    while (titleText.scrollWidth > avail && size > 13){
      size -= 2;
      titleText.style.fontSize = size + 'px';
    }
  }
  function showTitle(text){
    titleText.innerHTML = bbcodeToHtml(text);
    titleOverlay.classList.add('show');
    titleOverlay.classList.remove('clickable');
    fitTitle();
    // 0.8 秒内不可点击
    setTimeout(function(){
      titleOverlay.classList.add('clickable');
    }, 800);
    function dismissTitle(){
      titleOverlay.classList.remove('show', 'clickable');
      titleOverlay.removeEventListener('click', onTitleClick);
      clearAutoPlayTimer();
      advance();
    }
    function onTitleClick(e){
      e.stopPropagation(); // 阻断冒泡到 #stage，否则会被误判为「跳过打字」，导致标题下一行文字无打字机效果
      userScrolledUp = false; // 标题点击也强制滚到底
      dismissTitle();
    }
    titleOverlay.addEventListener('click', onTitleClick);
    _titleOnClick = onTitleClick;
    // 自动播放：标题作为停顿，2.5 秒后自动继续
    if (autoPlay){ clearAutoPlayTimer(); autoPlayTimer = setTimeout(function(){ autoPlayTimer = null; if (titleOverlay.classList.contains('show')) dismissTitle(); }, 2500); }
  }
  // 分割线：在消息流中插入一条分割线（备注文字居中显示于线上；留空为普通横线），
  // 并触发停顿——等待玩家点击继续，使分割线在打字游戏中能被看清。
  function showDivider(text){
    // galgame 模式：分割线登场前先清旧文字，并把分割线收尾标记为段边界
    beginSegmentIfNeeded();
    // 历史面板记录：把分割线（含居中备注）原样保存为 hp-item 结构，便于 #history-body 直接渲染
    let divHtml = '<div class="hp-item divider">';
    if (text){
      divHtml += '<span class="divider-line"></span><span class="divider-text">' + bbcodeToHtml(text) + '</span><span class="divider-line"></span>';
    } else {
      divHtml += '<span class="divider-line"></span>';
    }
    divHtml += '</div>';
    pushHistory(divHtml, true);
    const d = document.createElement('div');
    d.className = 'message divider';
    if (text) {
      const t = document.createElement('span');
      t.className = 'divider-text';
      t.innerHTML = bbcodeToHtml(text);
      const l1 = document.createElement('span'); l1.className = 'divider-line';
      const l2 = document.createElement('span'); l2.className = 'divider-line';
      d.appendChild(l1); d.appendChild(t); d.appendChild(l2);
    } else {
      const l = document.createElement('span');
      l.className = 'divider-line';
      d.appendChild(l);
    }
    msgList.appendChild(d);
    scrollToBottom();
    scheduleContrast();
    awaitingClick = true; hint.style.display = 'block';
    scheduleAutoPlay();
  }
  let _resizeScheduled = false;
  window.addEventListener('resize', function(){
    if (titleOverlay.classList.contains('show')) fitTitle();
    if (_resizeScheduled) return;
    _resizeScheduled = true;
    requestAnimationFrame(function(){ _resizeScheduled = false; _rebuildBgSample(); fitGalgameFont(); });
  });
  // galgame 模式字号自适应：以「对话框能放 3 行文字」为标准，按文本框实际高度计算字号。
  // 公式：可用高度 = 框高 - 上下 padding；单行高 = fontSize * 1.6(行高)；3 行 + 2 处行间距(各10px)。
  function fitGalgameFont(){
    if (!GALGAME || !msgList) return;
    const cs = getComputedStyle(msgList);
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const avail = Math.max(0, msgList.clientHeight - pt - pb);
    let size = (avail - 20) / (3 * 1.6); // 留 20px 给两条消息间 margin
    size = Math.round(Math.max(16, Math.min(44, size)));
    msgList.style.setProperty('--gal-font-size', size + 'px');
  }
  fitGalgameFont();
  function findAsset(lib, node){
    const m = DATA.assets[lib] || {};
    if (node.id && m[node.id]) return m[node.id];
    if (node.name){ for (const k in m){ if (m[k] && m[k].name === node.name) return m[k]; } }
    return null;
  }
  function fadeOutMusic(audio){
    if (!audio) return;
    const startVol = audio.volume || 0;
    const start = performance.now();
    fadingMusics.push(audio);
    function step(){
      const t = (performance.now() - start) / FADE_MS;
      if (t >= 1){ try { audio.pause(); } catch(e){} const i = fadingMusics.indexOf(audio); if (i >= 0) fadingMusics.splice(i, 1); return; }
      audio.volume = Math.max(0, startVol * (1 - t));
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function stopAllMusic(){
    if (bgMusic){ try { bgMusic.pause(); } catch(e){} bgMusic = null; }
    for (const m of fadingMusics){ try { m.pause(); } catch(e){} }
    fadingMusics = [];
    for (const k in soundCache){ try { soundCache[k].pause(); } catch(e){} }
    currentMusicName = null;
  }
  // 预览 iframe 被卸载（关闭预览）时，主动停止所有音频，避免后台继续播放
  window.addEventListener('pagehide', function(){ try { stopAllMusic(); } catch(e){} });
  // 把一个背景规格（{src} 图片 / {color} 纯色 / null 清空）应用到某个背景层
  function _paintLayer(layer, spec){
    layer.style.backgroundImage = '';
    layer.style.backgroundColor = '';
    if (!spec) return;
    if (spec.color){ layer.style.backgroundColor = spec.color; }
    else if (spec.src){
      layer.style.backgroundImage = 'url("' + spec.src + '")';
      layer.style.backgroundSize = 'auto 100%';
      layer.style.backgroundPosition = 'center';
    }
  }
  // 背景叠化：新背景设到备用层 → 淡入 → 0.5s 后清旧层。spec: {src} | {color} | null
  function applyBackground(spec){
    // 取消上一轮未完成的叠化：快速连续切换时，若保留旧定时器，它们会各自翻转
    // active/alt 指针并最终把「正在显示的层」清空，导致背景错乱/闪黑。先结束上一轮动画。
    if (bgFadeTimer){ clearTimeout(bgFadeTimer); bgFadeTimer = null; }
    if (!spec){ currentBgSrc = ''; currentBgColor = ''; _paintLayer(altBg, null); altBg.style.opacity = '1'; activeBg.style.opacity = '0'; _paintLayer(activeBg, null); _rebuildBgSample(); return; }
    currentBgSrc = (spec.src) || '';
    currentBgColor = (spec.color) || '';
    // 若上一次叠化尚未完成，altBg 此刻可能仍可见（opacity=1）。先把它与 activeBg 对调，
    // 保证接下来画新背景的「备用层」是隐藏的那一个，避免直接覆盖正在显示的旧层造成跳变。
    if (altBg.style.opacity === '1'){ const t = activeBg; activeBg = altBg; altBg = t; }
    _paintLayer(altBg, spec);
    // 强制回流后启动叠化
    altBg.offsetHeight;
    altBg.style.opacity = '1';
    activeBg.style.opacity = '0';
    // 叠化结束后清掉旧背景，并交换 active/alt 指针
    bgFadeTimer = setTimeout(function(){
      _paintLayer(activeBg, null);
      // 交换 active/alt 指针
      const tmp = activeBg; activeBg = altBg; altBg = tmp;
      bgFadeTimer = null;
    }, BG_CROSSFADE_MS + 50);
    _rebuildBgSample();
  }
  function setBackground(src){ applyBackground(src ? { src: src } : null); }
  function setSolidBackground(color){ applyBackground(color ? { color: color } : null); }
  // 叠层：显示在背景之上、文字之下的独立图层（透明 PNG 角色 / 物件）。无动画，立即切换。
  function setOverlay(src){
    if (!overlayLayer) return;
    if (src) { overlayLayer.style.backgroundImage = 'url("' + src + '")'; overlayLayer.style.display = 'block'; }
    else { overlayLayer.style.backgroundImage = ''; overlayLayer.style.display = 'none'; }
  }
  function clearOverlay(){ setOverlay(''); }
  function doSummon(node){
    const lib = node.kind;
    const a = findAsset(lib, node);
    if (lib === 'background'){
      if (a && a.kind === 'solid') setSolidBackground(a.color || '#000000');
      else setBackground(a && a.src ? a.src : '');
      advance();
    } else if (lib === 'music'){
      if (bgMusic){ fadeOutMusic(bgMusic); bgMusic = null; }
      if (a && a.src){ const m = new Audio(a.src); m.loop = true; m.volume = musicMuted ? 0 : MUSIC_VOL; m.play().catch(function(){}); bgMusic = m; currentMusicName = a.name || null; }
      advance();
    } else if (lib === 'sound'){
      if (a && a.src){ const s = new Audio(a.src); s.volume = sfxMuted ? 0 : SFX_VOL; s.play().catch(function(){}); }
      advance();
    } else if (lib === 'item'){
      openItem(a, node.hint);
    } else if (lib === 'overlay'){
      clearOverlay(); // 下一个叠层出现时，自动隐藏当前叠层
      setOverlay(a && a.src ? a.src : '');
      advance();
    }
  }
  function openItem(a, hint){
    if (!a){ advance(); return; }
    itemOpen = true;
    frame.srcdoc = buildItemViewerHTML(a);
    // 中下方提示文字（留空不提示）
    if (hint){
      itemHint.textContent = hint;
      itemHint.classList.add('show');
    } else {
      itemHint.classList.remove('show');
    }
    // 等一帧让 iframe 开始渲染，再触发动画
    requestAnimationFrame(function(){
      overlay.classList.add('open');
    });
  }
  function closeItem(){
    // 缩小+淡出
    itemHint.classList.remove('show');
    overlay.classList.remove('open');
    setTimeout(function(){
      frame.srcdoc = ''; itemOpen = false;
      advance();
    }, 300);
  }
  // 结束物体点击：若该结束物体绑定了剧情块则跳转过去，否则按原逻辑关闭并继续
  function handleItemExit(id, mesh){
    const item = (DATA.assets.item && DATA.assets.item[id]) || null;
    const bindings = (item && item.exitBindings) || {};
    if (mesh && bindings[mesh] && DATA.blocks[bindings[mesh]]){
      // 绑定了剧情块：关闭查看器后跳转到该块开头（压栈，原位置可由 <跳回> 返回）
      itemHint.classList.remove('show');
      overlay.classList.remove('open');
      setTimeout(function(){
        frame.srcdoc = ''; itemOpen = false;
        callBlock(bindings[mesh]); execCur();
      }, 300);
    } else {
      closeItem(); // 未绑定：原逻辑，关闭并继续
    }
  }
  window.addEventListener('message', function(ev){
    if (ev.data && ev.data.type === 'glb-scene-exit' && itemOpen) handleItemExit(ev.data.id, ev.data.mesh);
    else if (ev.data && ev.data.type === 'get-review-context') {
      // 编辑器「试玩审阅」：回传当前块名与最近显示的文字，供用户写修改意见
      try { parent.postMessage({ type: 'review-context', block: curBlock, text: lastTextContent }, '*'); } catch (e) {}
    }
  });
  // 兜底：编辑器可直接调用（同源 srcdoc 时可用）
  window.__storyReviewContext = function(){ return { block: curBlock, text: lastTextContent }; };
  function finish(){
    // 游戏结束不自动停止音乐：背景音乐持续播放，直到玩家点「重新开始」(gotoNode) 或「读取存档」(replayTo) 才停
    clearAutoPlayTimer();
    hint.style.display = 'none';
    // 不清除已显示的文字，让玩家可上翻回味整段故事；把「完」+ 按钮追加到文末（随剧情一起滚动）
    if (endCard.parentNode !== msgList) msgList.appendChild(endCard);
    endCard.style.display = 'flex';
    msgList.scrollTop = msgList.scrollHeight; // 滚到文末，露出「完」
  }
  // 长按 1 秒：隐藏文字、还原背景原图（去掉调暗/调亮），便于欣赏背景；松手恢复
  let _pressTimer = null, _revealing = false, _justRevealed = false;
  const LONG_PRESS_MS = 500;
  function _startPress(e){
    if (_revealing) return;
    if (itemOpen) return;
    const t = e.target;
    if (t && t.closest && t.closest('button, a, input, .opt-btn, #options-bar, #end-card, #item-overlay, .save-menu, .load-menu')) return;
    if (titleOverlay.classList.contains('show')) return;
    if (saveMenu.classList.contains('open') || loadMenu.classList.contains('open')) return;
    _pressTimer = setTimeout(function(){
      _revealing = true;
      document.body.classList.add('reveal-bg');
    }, LONG_PRESS_MS);
  }
  function _endPress(){
    if (_pressTimer){ clearTimeout(_pressTimer); _pressTimer = null; }
    if (_revealing){
      _revealing = false;
      _justRevealed = true;
      document.body.classList.remove('reveal-bg');
      setTimeout(function(){ _justRevealed = false; }, 350); // 吞掉松手后紧随的 click（防止误触继续）
    }
  }
  const _stageEl = document.getElementById('stage');
  _stageEl.addEventListener('pointerdown', _startPress);
  window.addEventListener('pointerup', _endPress);
  window.addEventListener('pointercancel', _endPress);
  _stageEl.addEventListener('pointerleave', _endPress);
  _stageEl.addEventListener('contextmenu', function(e){ if (_revealing || _justRevealed) e.preventDefault(); });
  // 点击：跳过打字 / 继续停顿（在 #stage 或 #message-list 上均可）
  _stageEl.addEventListener('click', function(){
    if (_justRevealed) return; // 长按刚结束，吞掉这次点击
    if (saveMenu.classList.contains('open') || loadMenu.classList.contains('open')) { closeMenus(); return; }
    if (historyOpen) return; // 文字历史打开时，stage 点击不推进剧情（面板已自管滚动/关闭）
    if (itemOpen) return;
    // 点击即视为「要看新内容」：解除自动滚动锁定，强制滚到底（避免快速点击时误触发滚动手势把 userScrolledUp 卡死）
    userScrolledUp = false;
    if (typing){ clearInterval(typingTimer); typing = false; currentMsg.innerHTML = currentHtml; currentMsg.classList.remove('typing'); currentMsg = null; advance(); }
    else if (awaitingClick){ awaitingClick = false; hint.style.display = 'none'; advance(); }
    scrollToBottom();
  });
})();
</script>
</body>
</html>
`;

// ============ 数据收集 ============
// 把单块文本解析为节点数组（与编辑器 parseStory 语义一致，含分支指令）。
// 运行时是独立产物，故此处自带解析，不依赖编辑器代码。
function parseStoryForExport(src) {
  const RE_PAUSE = /^<停顿(?::\s*(\d+))?>$/;
  const RE_SUMMON = /^<召唤(背景|物品|音乐|音效|叠层):\s*(.*?)\s*>$/;
  const RE_TITLE = /^<标题:\s*(.*?)\s*>$/;
  const RE_DIVIDER = /^<分割线(?::\s*(.*?)\s*)?>$/;
  const RE_BLOCK = /^<(?:对话块|剧情块):\s*(.*?)\s*>$/;
  const RE_RETURN = /^<跳回>$/;
  const RE_RETURN_RECHOOSE = /^<跳回重选>$/;
  const RE_OPTION = /<选项:\s*"([^"]*)"\s*(?:,\s*([^>]*?))?\s*>/g;
  const CN = { '背景': 'background', '物品': 'item', '叠层': 'overlay', '音乐': 'music', '音效': 'sound' };
  const lines = (src || '').split(/\r?\n/);
  const story = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const merged = buf.join('\n').replace(/^\s+|\s+$/g, '').replace(/<审阅:\d+>/g, '').replace(/<\/审阅>/g, '');
    if (merged) story.push({ type: 'text', content: merged });
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*\/\//.test(line)) continue;
    const t = line.trim();
    let m;
    if ((m = t.match(RE_PAUSE))) { flush(); story.push({ type: 'pause', ms: m[1] != null ? parseInt(m[1], 10) : 0 }); }
    else if ((m = t.match(RE_SUMMON))) {
      flush();
      let sname = m[2], shint = '';
      if (CN[m[1]] === 'item') { const hm = sname.match(/^(.*?),\s*"(.*)"\s*$/); if (hm) { sname = hm[1].trim(); shint = hm[2]; } }
      const snode = { type: 'summon', kind: CN[m[1]], name: sname };
      if (shint) snode.hint = shint;
      story.push(snode);
    }
    else if ((m = t.match(RE_TITLE))) { flush(); story.push({ type: 'title', text: m[1] || '标题' }); }
    else if ((m = t.match(RE_DIVIDER))) { flush(); story.push({ type: 'divider', text: (m[1] || '').trim() }); }
    else if (t === '<停止音乐>') { flush(); story.push({ type: 'stopmusic' }); }
    else if (t === '<清除叠层>') { flush(); story.push({ type: 'clearoverlay' }); }
    else if ((m = t.match(/^<变量:([\s\S]*)>$/))) {
      flush();
      const ops = [];
      m[1].split(';').forEach(function (seg) {
        seg = seg.trim(); if (!seg) return;
        const am = seg.match(/^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*([=+\-])\s*([^\s]+)$/);
        if (am) ops.push({ name: am[1], op: am[2], val: am[3] });
      });
      if (ops.length) story.push({ type: 'varop', ops: ops });
    }
    else if ((m = t.match(RE_BLOCK))) { flush(); story.push({ type: 'block', name: m[1].trim() }); }
    else if (RE_RETURN.test(t)) { flush(); story.push({ type: 'return' }); }
    else if (RE_RETURN_RECHOOSE.test(t)) { flush(); story.push({ type: 'returnrechoose' }); }
    else if (t.indexOf('<选项:') >= 0) {
      flush();
      const options = [];
      let om; RE_OPTION.lastIndex = 0;
      while ((om = RE_OPTION.exec(t)) !== null) {
        const txt = om[1];
        const extra = (om[2] && om[2].trim()) || '';
        let blk = null, cond = null;
        if (extra) {
          const ci = extra.indexOf('条件:');
          if (ci >= 0) {
            blk = extra.slice(0, ci).replace(/,\s*$/, '').trim() || null;
            cond = extra.slice(ci + 3).replace(/,\s*$/, '').trim();
          } else blk = extra;
        }
        options.push({ text: txt, block: blk, condition: cond || null });
      }
      if (options.length) story.push({ type: 'options', options });
    }
    else buf.push(line);
  }
  flush();
  return story;
}

// 把光标字符偏移映射到「该块的第几个节点」：用于「从光标开始」试玩。
// 镜像 parseStoryForExport 的分行/指令判定，只追踪每个节点的起始行号。
function computeStartNode(src, charOffset) {
  const lines = (src || '').split(/\r?\n/);
  const cursorLine = (src.slice(0, charOffset).match(/\n/g) || []).length; // 0-based 行号
  const RE_PAUSE = /^<停顿(?::\s*(\d+))?>$/;
  const RE_SUMMON = /^<召唤(背景|物品|音乐|音效|叠层):\s*(.*?)\s*>$/;
  const RE_TITLE = /^<标题:\s*(.*?)\s*>$/;
  const RE_DIVIDER = /^<分割线(?::\s*(.*?)\s*)?>$/;
  const RE_BLOCK = /^<(?:对话块|剧情块):\s*(.*?)\s*>$/;
  const RE_RETURN = /^<跳回>$/;
  const RE_RETURN_RECHOOSE = /^<跳回重选>$/;
  let bufStart = null;
  const nodeStartLines = [];
  const flush = () => { if (bufStart != null) { nodeStartLines.push(bufStart); bufStart = null; } };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*\/\//.test(raw)) continue;            // 注释行
    const t = raw.trim();
    if (t === '') { flush(); continue; }           // 空行结束文本缓冲
    const isCmd =
      RE_PAUSE.test(t) || RE_SUMMON.test(t) || RE_TITLE.test(t) || RE_DIVIDER.test(t) ||
      t === '<停止音乐>' || t === '<清除叠层>' || RE_BLOCK.test(t) || RE_RETURN.test(t) || RE_RETURN_RECHOOSE.test(t) ||
      t.indexOf('<选项:') >= 0 || t.indexOf('<变量:') === 0;
    if (isCmd) { flush(); nodeStartLines.push(i); }
    else { if (bufStart == null) bufStart = i; }
  }
  flush();
  // 选起始行 <= 光标行的最后一个节点
  let idx = 0;
  for (let k = 0; k < nodeStartLines.length; k++) {
    if (nodeStartLines[k] <= cursorLine) idx = k;
    else break;
  }
  return idx;
}

// inline=true：所有素材内联为 dataURL（单 HTML）。
// inline=false：图片/音频外置为相对路径文件（标准结构 zip，方便后期修改）；GLB 仍内联（iframe 无法引用本地文件）。
async function collectRuntimeData(inline) {
  const meta = window.Storage.loadMeta() || {};
  const assets = { background: {}, item: {}, overlay: {}, music: {}, sound: {} };
  const files = []; // [{ path, uint8 }]

  function extFromDataUrl(d) {
    const m = (d.split(':')[1] || '').split(';')[0] || 'bin';
    if (m === 'image/png') return 'png';
    if (m === 'image/jpeg') return 'jpg';
    if (m === 'image/webp') return 'webp';
    if (m === 'audio/mpeg') return 'mp3';
    if (m === 'audio/ogg') return 'ogg';
    if (m === 'audio/wav') return 'wav';
    if (m === 'model/gltf-binary') return 'glb';
    return 'bin';
  }
  function dataUrlToU8(d) {
    const b64 = d.split(',')[1] || '';
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  for (const lib of window.Storage.LIBS) {
    const list = await window.Storage.getAllAssets(lib);
    for (const a of list) {
      if (lib === 'item') {
        // GLB 始终内联
        assets.item[a.id] = {
          name: a.name, glb: a.glb || '', exitMesh: a.exitMesh || null,
          interactions: a.interactions || {}, sounds: a.sounds || {},
          defaultView: a.defaultView || null, bg: a.bg || null,
          lockRotation: !!a.lockRotation, chains: a.chains || [],
          exitBindings: a.exitBindings || {},
        };
      } else {
        if (a.kind === 'solid') {
          // 纯色背景：不内联图片，仅带颜色，召唤时铺满背景层
          assets[lib][a.id] = { name: a.name, kind: 'solid', color: a.color || '#000000', src: '' };
        } else if (inline) {
          assets[lib][a.id] = { name: a.name, src: a.src || '' };
        } else {
          const ext = extFromDataUrl(a.src || '');
          const path = 'assets/' + (lib === 'background' ? 'bg' : lib) + '/' + a.id + '.' + ext;
          assets[lib][a.id] = { name: a.name, src: path };
          if (a.src) files.push({ path, uint8: dataUrlToU8(a.src) });
        }
      }
    }
  }
  // 自定义字体（全局设置里上传的字体文件）
  let fontData = null;
  if (meta.font && meta.font.src) {
    const ext = meta.font.ext || 'ttf';
    if (inline) {
      fontData = { name: meta.font.name || 'custom', src: meta.font.src, ext: ext };
    } else {
      const path = 'assets/fonts/gamefont.' + ext;
      fontData = { name: meta.font.name || 'custom', src: path, ext: ext };
      files.push({ path, uint8: dataUrlToU8(meta.font.src) });
    }
  }
  // 安全守卫：AI 设置存于独立 localStorage（storyeditor:ai:*），不在此 meta 内；
  // 即便 meta 误带 ai 相关字段，也绝不写入导出产物（下面逐项赋值，不整体展开 meta）。
  const globalObj = {
    gameName: meta.gameName || '', subtitle: meta.subtitle || '', authorId: meta.authorId || '',
    icon: meta.icon || '', font: fontData, openingBg: meta.openingBg || '', openingMusic: meta.openingMusic || '', textContrast: meta.textContrast || 'auto',
    playMode: (meta.playMode === 'galgame') ? 'galgame' : 'longform', watermark: meta.watermark || null,
  };
  Object.keys(globalObj).forEach(k => { if (/^ai/i.test(k)) delete globalObj[k]; });
  // 变量库：注入运行时初始值（数字→Number，布尔→true/false，文本→字符串）
  const variables = {};
  const varList = (window.Storage.getVars && window.Storage.getVars()) || [];
  (varList || []).forEach(function (vv) {
    if (!vv || !vv.name) return;
    if (vv.type === 'boolean') variables[vv.name] = (vv.value === true || vv.value === 'true');
    else if (vv.type === 'number') variables[vv.name] = (vv.value === '' || vv.value == null) ? 0 : Number(vv.value);
    else variables[vv.name] = (vv.value == null ? '' : String(vv.value));
  });
  // 剧情块：把每个块解析为节点数组；start = 主剧情（置顶、不可删、游戏默认起点）
  const blocks = {};
  let start = window.Storage.MAIN_BLOCK || '__MAIN__';
  const names = window.Storage.listBlockNames();
  for (const nm of names) {
    blocks[nm] = parseStoryForExport(window.Storage.getBlockText(nm) || '');
  }
  // 兜底：至少保证有一个起始块
  if (!blocks[start]) blocks[start] = [];
  return { title: meta.title || '互动剧情', blocks, start, assets, global: globalObj, variables: variables, __files: files };
}

function buildRuntimeHTML(data, mode) {
  // 把 < 转义为 \u003c，避免内联字符串里的 </script> 提前截断外层 script
  const safe = (s) => JSON.stringify(s).replace(/</g, '\\u003c');
  // 自定义字体：单文件导出自带 dataURL；zip 导出引用 assets/fonts/gamefont.<ext>
  const FALLBACK_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  let fontFace = '';
  let fontFamily = FALLBACK_FONT;
  const font = data.global && data.global.font;
  if (font && font.src) {
    const fmtMap = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };
    const fmt = fmtMap[font.ext] || '';
    fontFace = "@font-face{font-family:'StoryCustomFont';src:url('" + font.src + "')" + (fmt ? " format('" + fmt + "')" : "") + ";font-display:swap;}";
    fontFamily = "'StoryCustomFont', " + FALLBACK_FONT;
  }
  let html = RUNTIME_TEMPLATE
    .replace('__FONT_FACE__', fontFace)
    .replace('__FONT_FAMILY__', fontFamily)
    .replace('__SRC__', safe(ITEM_VIEWER_SOURCE))
    .replace('__WRAP__', safe(ITEM_VIEWER_WRAP))
    .replace('__TITLE__', data.title || '互动剧情')
    .replace('__STORY_SCRIPT_TAG__', mode === 'zip' ? '<script src="story.js"></script>' : '')
    .replace('__TEXT_CONTRAST__', (data.global && data.global.textContrast) || 'auto')
    .replace('__PLAY_MODE__', (data.global && data.global.playMode === 'galgame') ? 'galgame' : 'longform');
  if (mode === 'single') {
    html = html.replace('__STORY_DATA__', 'window.STORY_DATA = ' + safe(data) + ';');
  } else {
    html = html.replace('__STORY_DATA__', '');
  }
  return html;
}

function strToU8(s) { return new TextEncoder().encode(s); }

function downloadBlob(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function downloadText(text, filename, mime) {
  downloadBlob(new Blob([text], { type: mime || 'text/plain;charset=utf-8' }), filename);
}

// 预览：返回完整内联 HTML 字符串（编辑器用 iframe 打开）
// fromCursor: { block, offset } —— 勾选「从光标开始」时，从光标所在块的对应节点开播
async function buildPreviewHTML(fromCursor) {
  const data = await collectRuntimeData(true);
  if (fromCursor && fromCursor.block && typeof fromCursor.offset === 'number') {
    const src = (window.Storage.getBlockText(fromCursor.block) || '');
    const idx = computeStartNode(src, fromCursor.offset);
    if (data.blocks && data.blocks[fromCursor.block]) {
      data.__previewFrom = { block: fromCursor.block, idx: idx };
    }
  }
  return buildRuntimeHTML(data, 'single');
}

// 导出单 HTML
async function exportSingleHTML() {
  const data = await collectRuntimeData(true);
  const html = buildRuntimeHTML(data, 'single');
  const safe = (data.title || '互动剧情').replace(/[\\/:*?"<>|]/g, '_');
  downloadText(html, safe + '.html', 'text/html;charset=utf-8');
  return { size: html.length };
}

const README_TEXT = [
  '标准结构剧情工程',
  '================',
  '',
  'index.html    —— 播放成品（双击打开即可运行）。',
  'story.js      —— 剧情脚本（window.STORY_DATA），用记事本即可编辑文字、BBCode。',
  'assets/       —— 背景图(bg)、叠层(overlay)、音乐(music)、音效(sound)、字体(fonts) 的文件，可替换后刷新页面生效。',
  '               物品(GLB) 内嵌在 story.js 中，如需替换请在「剧情编辑器」重新导入场景包。',
  '',
  '说明：',
  '  - 剧情是纯文本：一行普通文字 = 一句剧情；整行以指令开头即触发：',
  '      <召唤背景:名称>  <召唤物品:名称>  <召唤音乐:名称>  <召唤音效:名称>  <召唤叠层:名称>',
  '      <清除叠层>（移除当前叠层角色，回到纯背景）',
  '      [停顿]          （点一下继续）   [停顿:2000]（停顿 2 秒自动继续）',
  '  - 文字支持 BBCode：[b][i][u][s][color=#ff0000][size=24][center][br]',
  '  - 音乐自动互斥：召唤新音乐时上一首在 3 秒内慢慢淡出；音效互不干扰，可叠加播放。',
  '  - 修改 story.js 后直接刷新 index.html 即可看到效果（无需重新打包）。',
  '  - 若要改背景/音乐/音效文件，把 assets/ 下同名文件替换掉即可。',
].join('\n');

// 导出标准结构 zip
async function exportZip() {
  const data = await collectRuntimeData(false);
  // 取出打包用的临时二进制字段，绝不能把它序列化进 story.js：
  // Uint8Array 经 JSON.stringify 会被展开成 {索引:值} 对象，1MB 二进制膨胀约 11 倍，
  // 且这些素材已经作为独立文件外置进 zip，等于存了两份 → 体积爆炸。
  const packFiles = data.__files || [];
  delete data.__files;
  const storyJs = 'window.STORY_DATA = ' + JSON.stringify(data) + ';\n';
  const indexHtml = buildRuntimeHTML(data, 'zip');
  const safe = (data.title || '互动剧情').replace(/[\\/:*?"<>|]/g, '_');
  const zipFiles = [
    { name: 'index.html', data: strToU8(indexHtml) },
    { name: 'story.js', data: strToU8(storyJs) },
    { name: 'README.txt', data: strToU8(README_TEXT) },
  ];
  for (const f of packFiles) zipFiles.push({ name: f.path, data: f.uint8 });
  const blob = window.buildZipBlob(zipFiles);
  downloadBlob(blob, safe + '-标准结构.zip');
  return { count: zipFiles.length };
}

const Exporter = { buildRuntimeHTML, buildPreviewHTML, exportSingleHTML, exportZip, collectRuntimeData, computeStartNode };
if (typeof window !== 'undefined') window.Exporter = Exporter;
if (typeof module !== 'undefined' && module.exports) module.exports = Exporter;
