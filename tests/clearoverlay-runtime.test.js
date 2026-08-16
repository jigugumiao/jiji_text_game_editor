const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'exporter.js'), 'utf8');

assert.match(
  source,
  /else if \(n\.type === 'clearoverlay'\)\s*\{\s*clearOverlay\(\);\s*advance\(\);\s*\}/,
  '清除叠层指令在移除叠层后必须继续执行下一剧情节点'
);

console.log('clearoverlay runtime progression test passed');
