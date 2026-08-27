const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.match(html, /id="app-version">v25\.4\.79</, '界面版本必须标记本次修复');
assert.match(html, /js\/story-vars\.js\?v=20260826-01/, '新增变量系统共享模块必须带缓存标识');
assert.match(html, /js\/story-options\.js\?v=20260827-03/, '新增选项语法共享模块必须带缓存标识');
assert.match(html, /js\/story-visual-doc\.js\?v=20260827-03/, '新增可视化源码文档模块必须带缓存标识');
assert.match(html, /js\/story-visual-ui\.js\?v=20260827-12/, '可视化编辑器界面模块必须刷新缓存标识');
assert.match(html, /js\/exporter\.js\?v=20260827-03/, '修复运行时后必须刷新 exporter.js 缓存标识');
assert.match(html, /js\/editor\.js\?v=20260827-11/, '预览切换修复必须刷新 editor.js 缓存标识');
assert.match(html, /js\/storage\.js\?v=20260827-08/, '新建可视化项目必须刷新 storage.js 缓存标识');
assert.match(html, /js\/project-converter\.js\?v=20260827-02/, '项目转换模块必须带缓存标识');
assert.match(html, /css\/style\.css\?v=20260827-12/, '选项编辑界面样式必须刷新缓存标识');

console.log('release cache-bust test passed');
