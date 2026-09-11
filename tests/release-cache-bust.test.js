const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.match(html, /id="app-version">v25\.4\.101/, '界面版本必须标记本次合并');
assert.match(html, /js\/story-vars\.js\?v=20260912-01/, '变量系统共享模块合并后必须带缓存标识');
assert.match(html, /js\/exporter\.js\?v=20260912-01/, '合并变量运行时后必须刷新 exporter.js 缓存标识');
assert.match(html, /js\/editor\.js\?v=20260912-04/, 'Agent 多对话后必须刷新 editor.js 缓存标识');
assert.match(html, /js\/storage\.js\?v=20260912-01/, '合并 NS 隔离后必须刷新 storage.js 缓存标识');
assert.match(html, /css\/style\.css\?v=20260912-03/, 'Agent 多对话侧栏与弱提醒样式后必须刷新 style.css 缓存标识');
assert.match(html, /js\/ai\.js\?v=20260912-01/, 'callDeepseek usage 透出后必须刷新 ai.js 缓存标识');
assert.match(html, /js\/agent\.js\?v=20260912-06/, '回复风格纪律后必须刷新 agent.js 缓存标识');

console.log('release cache-bust test passed');
