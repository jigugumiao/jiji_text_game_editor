const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/exporter.js'), 'utf8');
const m = src.match(/const RUNTIME_TEMPLATE = String\.raw`([\s\S]*?)`;/);
const tpl = m[1];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let mm, i = 0, js = null;
while ((mm = re.exec(tpl))) { i++; js = mm[1]; }
// 中和所有占位符（模拟 buildRuntimeHTML 已替换）
// 注意：__STORY_DATA__ 必须替换成「带分号的语句」，否则中和为 "" 后，
// 紧接其后的 IIFE (function(){...})() 会被解析成 ""(function(){...})() 而报 "is not a function"。
js = js.replace(/__STORY_DATA__/g, 'window.STORY_DATA = {};');
js = js.replace(/__[A-Za-z_][A-Za-z0-9_]*__/g, '""');
fs.writeFileSync('/tmp/rt.js', js);

function fakeEl() {
  return {
    style: {}, classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);}, toggle(c,f){ f?this._s.add(c):this._s.delete(c); } },
    children: [], childNodes: [], dataset: {}, textContent: '', innerHTML: '', value: '', src: '', href: '',
    addEventListener(){}, removeEventListener(){}, appendChild(c){ this.children.push(c); return c; },
    setAttribute(){}, getAttribute(){return null;}, focus(){}, setSelectionRange(){},
    getContext(){ return {}; }, querySelector(){return fakeEl();}, querySelectorAll(){return [];},
  };
}
const elCache = {};
const document = {
  getElementById(id){ return elCache[id] || (elCache[id] = fakeEl()); },
  createElement(){ return fakeEl(); }, createTextNode(){ return fakeEl(); },
  addEventListener(){}, removeEventListener(){}, head: fakeEl(), body: fakeEl(),
  querySelector(){ return fakeEl(); }, querySelectorAll(){ return []; },
};
const localStore = {};
const sandbox = {
  window: {}, document,
  localStorage: { getItem(k){return localStore[k]||null;}, setItem(k,v){localStore[k]=v;}, removeItem(k){delete localStore[k];} },
  setTimeout: (fn)=>0, clearTimeout(){}, setInterval: ()=>0, clearInterval(){},
  requestAnimationFrame: (fn)=>0,
  Promise, console, Date, Math, JSON, Array, Object, String, Number, RegExp, parseInt, parseFloat, isNaN, Error,
  Audio: function(){ return { play(){return Promise.resolve();}, pause(){}, loop:false, volume:1 }; },
  getComputedStyle: ()=>({ lineHeight: '22px' }),
};
sandbox.window.document = document;
sandbox.window.addEventListener = ()=>{};
sandbox.window.open = ()=>{};
sandbox.window.toy = undefined; // 纯浏览器预览：最严场景
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'runtime.js' });
  console.log('初始化执行: OK（无开局抛错）');
  const hint = elCache['env-hint'];
  console.log('env-hint 文案:', JSON.stringify(hint ? hint.textContent : '(未建)'));
  console.log('PASS');
} catch (e) {
  console.log('初始化执行: 抛错');
  console.log(e && e.stack ? e.stack.split('\n').slice(0,6).join('\n') : e);
  process.exit(1);
}
