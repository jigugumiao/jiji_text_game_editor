const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.match(html, /id="app-version">v25\.4\.90</, '界面版本必须标记本次修复');
assert.match(html, /js\/exporter\.js\?v=20260819-02/, '修复运行时后必须刷新 exporter.js 缓存标识');
assert.match(html, /js\/editor\.js\?v=20260911-02/, 'Agent 用量/缓存命中显示后必须刷新 editor.js 缓存标识');
assert.match(html, /js\/storage\.js\?v=20260819-02/, '修改 storage.js 后必须刷新 storage.js 缓存标识');
assert.match(html, /css\/style\.css\?v=20260911-02/, '修复 Agent 对话框样式后必须刷新 style.css 缓存标识');
assert.match(html, /js\/ai\.js\?v=20260911-02/, 'callDeepseek 加 usage 透出后必须刷新 ai.js 缓存标识（旧缓存无 onUsage/stream_options）');
assert.match(html, /js\/agent\.js\?v=20260911-01/, 'Agent 模块上线必须刷新 agent.js 缓存标识');

console.log('release cache-bust test passed');
