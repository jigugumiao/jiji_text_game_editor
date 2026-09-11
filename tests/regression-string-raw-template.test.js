// 防回归断言：dist-test/index.html 中 String.raw 模板未被 build_inline 破坏
const fs = require('fs');
const html = fs.readFileSync('dist-test/index.html', 'utf8');

// 逐行统计代码里的模板插值（跳过 // 注释行，避免注释字面量干扰）
const interpRe = /\$\{'<\/scr' \+ 'ipt>'\}/g;
let interp = 0;
html.split('\n').forEach(line => {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*')) return; // 注释行
  const m = line.match(interpRe);
  if (m) interp += m.length;
});
console.log('代码中模板插值 ${</scr + ipt>} 数量:', interp, '(期望 3)');
if (interp !== 3) process.exit(1);

// String.raw 模板内不应存在字面 <\/script>（被 build_inline 替换坏的特征）
const badRe = /String\.raw`[^`]*?<\\\/script>/g;
const bad = html.match(badRe);
console.log('被破坏的 String.raw 模板:', bad ? bad.length : 0, '(期望 0)');
if (bad) process.exit(1);

// 构建产物里的运行时模板应生成含真 </script> 的 HTML（模拟导出）
const vm = require('vm');
const i2 = html.indexOf('/* inlined from js/exporter.js */');
const scriptStart = html.lastIndexOf('<script>', i2);
const scriptEnd = html.indexOf('</script>', i2);
const inlineExporter = html.slice(scriptStart + '<script>'.length, scriptEnd);
const sandbox = {
  window: {}, document: { getElementById: () => null }, console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  Blob: function () {}, URL: { createObjectURL: () => '' },
  setTimeout, clearTimeout, fetch: async () => ({ ok: false }),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(inlineExporter, sandbox, { filename: 'exporter.js' });
const Exporter = sandbox.Exporter;
const out = Exporter.buildRuntimeHTML({
  title: 't', blocks: { __MAIN__: [{ type: 'text', content: 'hi' }] },
  start: '__MAIN__', assets: {}, global: {}, variables: {}, __files: [],
}, 'single');
const closes = (out.match(/<\/script>/g) || []).length;
console.log('模拟导出 HTML 真 </script> 数量:', closes, '(期望 ≥1)');
if (closes < 1) process.exit(1);
console.log('\n防回归断言全部通过 ✓');
