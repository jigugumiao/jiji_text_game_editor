// jsdom 回归测试：开场音乐在标题界面播放、点「开始游戏」后停止（渐隐 3s，需等足够久）
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = 'C:/CH_ZAWU/vibecoding工具/剧情编辑器';
const Exporter = require(path.join(ROOT, 'js/exporter.js'));

const played = [], paused = [];
function FakeAudio(src) {
  this.src = src; this.loop = false; this.volume = 1;
  this.play = function () { played.push(this); return Promise.resolve(); };
  this.pause = function () { paused.push(this); };
  this.addEventListener = function () {};
  this.removeEventListener = function () {};
  this.load = function () {};
}

const data = {
  title: '测试剧',
  start: '__MAIN__',
  blocks: { '__MAIN__': [] },
  assets: { background: {}, item: {}, music: { m1: { name: '主题曲', src: 'data:audio/wav;base64,UklGRg==' } }, sound: {} },
  global: { gameName: '测试', openingMusic: '主题曲' },
};

const html = Exporter.buildRuntimeHTML(data, 'single');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,   // 提供真实 requestAnimationFrame（渐隐 3s 用）
  beforeParse(window) {
    window.Audio = FakeAudio;
    if (!window.FontFace) window.FontFace = function () {};
    if (!window.document.fonts) window.document.fonts = { add() {}, load() { return Promise.resolve(); } };
  },
});

setTimeout(function () {
  try {
    const win = dom.window, doc = win.document;
    win.addEventListener('error', function (ev) { console.log('WINDOW ERROR:', ev.error && ev.error.message); });
    const startBtn = doc.getElementById('btn-start-game');
    if (!startBtn) { console.log('FAIL: 找不到 btn-start-game'); process.exit(1); }

    // 首次交互（非开始按钮）→ 应起播开场音乐
    doc.dispatchEvent(new win.Event('pointerdown'));
    const beforePlay = played.length;

    // 点「开始游戏」→ 应触发停止（渐隐后 pause）
    startBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    // 渐隐 FADE_MS=3000，等足 3.6s
    setTimeout(function () {
      console.log('标题界面交互后 play 次数 =', beforePlay, '(期望 ≥1)');
      console.log('停止（pause）调用次数 =', paused.length, '(期望 ≥1)');
      const ok = beforePlay >= 1 && paused.length >= 1;
      console.log(ok ? 'PASS ✅ 开场音乐：标题界面起播 + 开始游戏后停止' : 'FAIL ❌');
      process.exit(ok ? 0 : 1);
    }, 3700);
  } catch (e) {
    console.log('ERROR:', e.message, '\n', e.stack);
    process.exit(1);
  }
}, 300);
