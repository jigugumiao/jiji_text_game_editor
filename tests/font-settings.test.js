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

// 3) 外观-正文字体必须作用于编辑器正文（历史 bug：只改设置里的预览小框，编辑器正文不跟随，看起来“选哪个都没变化”）
assert.match(editorSrc, /const apFont = getAppearance\(\)\.bodyFont \|\| '';/, 'applyEditorFont 必须读取外观正文字体');
assert.match(editorSrc, /storyText\.style\.fontFamily = apFont \?/, '外观正文字体必须优先于自定义字体作用于编辑区');
assert.match(editorSrc, /saveAppearance\(\{ bodyFont: this\.value \}\); applyPreview\(\); applyEditorFont\(\);/, '选择正文字体后必须立即刷新编辑区');
assert.match(editorSrc, /try \{ applyEditorFont\(\); \} catch \(e\) \{\}/, '刷新页面后必须立即套用已保存字体');

// 4) 运行时以外观字体覆盖自定义字体，保证编辑器预览与导出游戏表现一致
const data2 = {
  title: '字体覆盖', blocks: {}, start: '__MAIN__', assets: {}, variables: {},
  global: { font: { name: 'x', src: 'data:font/ttf;base64,AA==', ext: 'ttf' }, appearance: { bodyFont: "'SimSun', serif" } },
};
const html2 = Exporter.buildRuntimeHTML(data2, 'single');
assert.ok(html2.includes("if (APPEAR.bodyFont) document.body.style.setProperty('--body-font', APPEAR.bodyFont)"), '运行时外观正文字体必须覆盖兜底值');

// 3) appearance 为 null 时运行时不得崩溃（历史 bug：试玩 iframe 顶层 applyGalPanelAppearance(APPEAR.galPanel) 直接读 null，
// 顶层抛错后整个运行时脚本中断 → 点试玩不出字，并连锁产生 _bgData TDZ / StoryVars 未定义等报错）
assert.match(html, /if \(APPEAR\) applyGalPanelAppearance\(APPEAR\.galPanel\);/, 'APPEAR 为空时必须跳过九宫格外观应用');
assert.ok(!/\n  applyGalPanelAppearance\(APPEAR\.galPanel\);/.test(html), '不得存在无守护的 APPEAR.galPanel 顶层调用');

console.log('font-settings test passed');
