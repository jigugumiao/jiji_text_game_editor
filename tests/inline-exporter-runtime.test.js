const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const exporterSource = fs.readFileSync(path.join(root, 'js', 'exporter.js'), 'utf8');

// Mirror build_inline.py: JS source embedded in the editor must hide literal
// closing script tags from the outer HTML parser.
const inlinedSource = exporterSource.replaceAll('</script>', '<\\/script>');
const context = {
  window: {
    StoryVars: require('../js/story-vars.js'),
    StoryOptions: require('../js/story-options.js'),
  },
  module: { exports: {} },
  console,
};
vm.runInNewContext(inlinedSource, context, { filename: 'inlined-exporter.js' });

const html = context.module.exports.buildRuntimeHTML({
  title: '测试',
  assets: { background: {}, item: {}, overlay: {}, music: {}, sound: {} },
  global: {},
  blocks: { __MAIN__: [{ type: 'text', text: '可以开始' }] },
  start: '__MAIN__',
  variables: {},
}, 'single');

assert.match(html, /<script>[\s\S]*<\/script>\s*<\/body>/, 'inline-built exporter must emit a real runtime closing script tag');
const runtimeScript = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
assert.ok(runtimeScript, 'runtime script can be extracted from generated HTML');
assert.doesNotThrow(() => new Function(runtimeScript[1]), 'generated runtime script must parse');

console.log('inline-exporter-runtime.test.js passed');
