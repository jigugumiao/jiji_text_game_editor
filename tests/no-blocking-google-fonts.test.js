const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

for (const relativePath of ['index.html', 'beta/index.html']) {
  const html = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.doesNotMatch(
    html,
    /https:\/\/fonts\.(?:googleapis|gstatic)\.com/,
    `${relativePath} 不得依赖可能阻塞首屏的 Google Fonts`,
  );
}

console.log('no-blocking-google-fonts.test.js passed');
