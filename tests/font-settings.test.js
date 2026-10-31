const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 1) 移除自定义字体按钮必须使用主题按钮类（.btn-danger-ghost 在亮/暗两种主题下都可见）。
// 历史 bug：内联样式按暗色主题写死（白字+白色半透明边框），亮色设置面板白底上按钮隐形。
const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');
assert.match(editorSrc, /id="gs-font-remove" class="btn btn-danger-ghost btn-sm"/, '移除字体按钮必须使用主题按钮类');
assert.ok(!editorSrc.includes('id="gs-font-remove" style='), '移除字体按钮不得再使用主题写死的内联样式');

// 2) 导出运行时模板中所有 __FONT_FAMILY__ 占位符（body 默认字体 + --body-font/--title-font/--divider-font 兜底共 4 处）
// 必须全部替换。历史 bug：String.replace 只替换第一处，自定义字体只作用于 body，CSS 变量兜底仍是占位符。
const Exporter = require(path.join(__dirname, '..', 'js', 'exporter.js'));
const data = {
  title: '字体测试', blocks: {}, start: '__MAIN__', assets: {}, variables: {},
  global: { font: { name: 'test', src: 'data:font/ttf;base64,AA==', ext: 'ttf' }, appearance: null },
};
const html = Exporter.buildRuntimeHTML(data, 'single');
assert.ok(html.includes("@font-face{font-family:'StoryCustomFont'"), '自定义字体 @font-face 必须注入');
assert.ok(!html.includes('__FONT_FAMILY__'), '不得残留 __FONT_FAMILY__ 占位符');
assert.ok(html.includes("--body-font: 'StoryCustomFont'"), '--body-font 默认值必须为自定义字体');
assert.ok(html.includes("--title-font: 'StoryCustomFont'"), '--title-font 默认值必须为自定义字体');
assert.ok(html.includes("--divider-font: 'StoryCustomFont'"), '--divider-font 默认值必须为自定义字体');

console.log('font-settings test passed');
