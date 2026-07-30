const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'js/exporter.js'), 'utf8');
const m = src.match(/const RUNTIME_TEMPLATE = String\.raw`([\s\S]*?)`;/);
let tpl = m[1];
const scripts = [...tpl.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(s => s[1]);
const gameScript = scripts.find(s => s.includes('function typeText'));

let code = gameScript
  .replace(/__SRC__/g, "''")
  .replace(/__WRAP__/g, "''")
  .replace(/__STORY_SCRIPT_TAG__/g, '')
  .replace(/__STORY_DATA__/g,
    'window.STORY_DATA = {"title":"测试","story":[{"type":"text","content":"你好世界这是第一段很长的测试文字用于验证打字机效果是否逐字出现"}],"global":{},"assets":{"background":{},"item":{},"music":{},"sound":{}}};');

let html = tpl.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/__STORY_SCRIPT_TAG__/g, '');

const dom = new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.Element.prototype.scrollTo = function () {};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.HTMLCanvasElement.prototype.getContext = function () { return { createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(v) {} }; };
window.location.assign = function () {};
// 隔离无关的 soundCache/SOUNDS 未声明 bug（在模板外声明），避免干扰打字机观察
window.soundCache = {};
window.SOUNDS = {};

try { window.eval(code); } catch (e) { console.log('EVAL ERROR:', e.message); process.exit(1); }

const doc = window.document;
console.log('DIAG: STORY_DATA?', !!window.STORY_DATA, 'storyLen=', window.STORY_DATA && window.STORY_DATA.story.length);
console.log('DIAG: btn-start-game?', !!doc.getElementById('btn-start-game'));
console.log('DIAG: msgList?', !!doc.getElementById('message-list'));

const msgList = doc.getElementById('message-list');
function snap(label) {
  const first = msgList.children[0];
  const len = first ? first.textContent.length : 0;
  console.log(label + ' 首段长度=' + len + '  opacity(computed)=' + (first ? window.getComputedStyle(first).opacity : 'n/a'));
}

doc.getElementById('btn-start-game').click();
console.log('--- 点击开始游戏 ---');
console.log('DIAG sync: msgList.children.length =', doc.getElementById('message-list').children.length);

const seen = [];
let ticks = 0;
const iv = setInterval(() => {
  ticks++;
  const first = msgList.children[0];
  const len = first ? first.textContent.length : 0;
  seen.push(len);
  if (ticks === 2) snap('+60ms');
  if (ticks === 6) snap('+180ms');
  if (ticks === 12) snap('+360ms');
  if (ticks === 25) snap('+750ms');
  if (ticks >= 30) {
    clearInterval(iv);
    snap('结束');
    console.log('\n逐帧长度序列: ' + JSON.stringify(seen));
    const grew = seen[seen.length - 1] > seen[0] && new Set(seen).size > 3;
    console.log(grew ? 'PASS ✅ 首段在逐字增长（打字机逻辑正常）' : 'FAIL ❌ 首段未逐字增长');
    process.exit(grew ? 0 : 1);
  }
}, 30);
