const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'exporter.js'), 'utf8');

assert.match(source, /--gal-panel-image/);
assert.match(source, /--gal-panel-slice/);
assert.match(source, /border-image-source:\s*var\(--gal-panel-image/);
assert.match(source, /border-image-slice:\s*var\(--gal-panel-slice\) fill/);
assert.match(source, /function applyGalPanelAppearance\(/);
assert.match(source, /function clearGalPanelImage\(/);
assert.match(source, /new Image\(\)/);
assert.match(source, /APPEAR\.galPanel/);
assert.match(source, /image\.naturalWidth/);
assert.match(source, /image\.naturalHeight/);
assert.match(source, /image\.naturalWidth !== width \|\| image\.naturalHeight !== height/);
assert.match(source, /clearGalPanelImage\(\);\s*return;/);

// Exported projects must contain the applied snapshot; the runtime must not
// need to consult an editor-local preset id or database.
assert.match(source, /appearance:\s*meta\.appearance \|\| null/);
assert.match(source, /\.replace\('__APPEARANCE__', safe\(\(data\.global && data\.global\.appearance\) \|\| null\)\)/);
assert.doesNotMatch(source, /getAllDialoguePresets|dialogue-preset:/);

console.log('galgame dialogue runtime contracts passed');
