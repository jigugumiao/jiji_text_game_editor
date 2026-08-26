const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.match(html, /id="app-version">v25\.4\.66</, '界面版本必须标记本次修复');
assert.match(html, /js\/story-vars\.js\?v=20260826-01/, '新增变量系统共享模块必须带缓存标识');
assert.match(html, /js\/story-options\.js\?v=20260827-02/, '新增选项语法共享模块必须带缓存标识');
assert.match(html, /js\/story-visual-doc\.js\?v=20260827-03/, '新增可视化源码文档模块必须带缓存标识');
assert.match(html, /js\/story-visual-ui\.js\?v=20260827-03/, '新增可视化编辑器界面模块必须带缓存标识');
assert.match(html, /js\/exporter\.js\?v=20260826-01/, '修复运行时后必须刷新 exporter.js 缓存标识');
assert.match(html, /js\/editor\.js\?v=20260827-02/, '修复编辑器校验后必须刷新 editor.js 缓存标识');
assert.match(html, /js\/storage\.js\?v=20260819-02/, '修改 storage.js 后必须刷新 storage.js 缓存标识');
assert.match(html, /css\/style\.css\?v=20260827-04/, '修复样式后必须刷新 style.css 缓存标识');

console.log('release cache-bust test passed');
