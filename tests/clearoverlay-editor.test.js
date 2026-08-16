const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');

assert.match(source, /else if \(t === '<清除叠层>'\)\s*\{\s*flush\(\);\s*story\.push\(\{ type: 'clearoverlay' \}\);\s*\}/);
assert.match(source, /else if \(n\.type === 'clearoverlay'\) out\.push\('<清除叠层>'\);/);
assert.match(source, /else if \(t === '<清除叠层>'\)\s*\{\s*html \+=/);
assert.match(source, /else if \(t === '<清除叠层>'\)\s*\{\s*\/\/ 清除叠层：合法/);

console.log('clearoverlay editor support test passed');
