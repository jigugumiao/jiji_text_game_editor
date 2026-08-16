const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.match(html, /id="app-version">v25\.4\.52</, '界面版本必须标记本次修复');
assert.match(html, /js\/exporter\.js\?v=20260816-07/, '修复运行时后必须刷新 exporter.js 缓存标识');

console.log('release cache-bust test passed');
