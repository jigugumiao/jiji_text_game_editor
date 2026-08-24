// 条件选项解析回归测试：<选项:"文字",块名,条件:力量>=20>
// 历史 bug：旧正则 /<选项:\s*"([^"]*)"\s*(?:,\s*([^>]*?))?\s*>/g 用 [^>]*? 匹配块名+条件，
// 遇到条件表达式里的第一个 >（如 >=20 的 >）就提前闭合标签，导致：
//   1) 编辑器校验把「战斗块,条件:力量」当块名 → 误报「选项指向的剧情块未找到」；
//   2) 运行时条件被截成「力量」→ 永真 → 条件选项不消失。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');
const exporterSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'exporter.js'), 'utf8');

// 两个文件都必须提供新解析函数，且旧的正则式 RE_OPTION / reOpt 必须移除（避免还有调用方走旧解析）
for (const [tag, src] of [['editor.js', editorSrc], ['exporter.js', exporterSrc]]) {
  assert.match(src, /function extractOptionLine\(line\) \{/, tag + ' 必须包含 extractOptionLine');
  assert.match(src, /function splitOptionExtra\(extra\) \{/, tag + ' 必须包含 splitOptionExtra');
  assert.doesNotMatch(src, /RE_OPTION\s*=\s*\/<选项:/, tag + ' 不应再保留旧正则 RE_OPTION');
}
assert.doesNotMatch(editorSrc, /const reOpt = \/<选项:/, 'editor.js 不应再保留旧正则 reOpt');

// 从 editor.js 原样提取两个纯函数并运行（测试真实源码，不复制实现）
function grab(name) {
  const m = editorSrc.match(new RegExp('function ' + name + '\\s*\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(m, 'source contains ' + name);
  return m[0];
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(grab('extractOptionLine') + '\n' + grab('splitOptionExtra'), ctx);

// —— 用户案例 ——
{
  const o = ctx.extractOptionLine('<选项:"强攻",战斗块,条件:力量>=20>')[0];
  assert.equal(o.ok, true);
  assert.equal(o.text, '强攻');
  assert.equal(o.extra, '战斗块,条件:力量>=20', 'extra 必须完整保留 >=20，不能被第一个 > 截断');
  const sp = ctx.splitOptionExtra(o.extra);
  assert.equal(sp.block, '战斗块');
  assert.equal(sp.condition, '力量>=20');
}

// —— 多选项同行（第二个选项的闭合必须正确）——
{
  const line = '<选项:"A",块A><选项:"B",块B>';
  const opts = ctx.extractOptionLine(line);
  assert.equal(opts.length, 2);
  assert.equal(line.slice(opts[0].index, opts[0].close + 1), '<选项:"A",块A>');
  assert.equal(opts[1].text, 'B');
  assert.equal(line.slice(opts[1].index, opts[1].close + 1), '<选项:"B",块B>');
}

// —— 多条件选项（<= 与 && 与 > 同时出现）——
{
  const o = ctx.extractOptionLine('<选项:"A",块A,条件:金币<=5 && 勇气>0>')[0];
  const sp = ctx.splitOptionExtra(o.extra);
  assert.equal(sp.block, '块A');
  assert.equal(sp.condition, '金币<=5 && 勇气>0');
}

// —— 无块选项（仅推进）——
{
  const o = ctx.extractOptionLine('<选项:"只推进">')[0];
  assert.equal(o.text, '只推进');
  assert.equal(o.extra, '');
  const sp = ctx.splitOptionExtra(o.extra);
  assert.equal(sp.block, null);
  assert.equal(sp.condition, null);
}

// —— 非引号格式：ok=false，交由「选项指令格式不正确」校验 ——
{
  const o = ctx.extractOptionLine('<选项:abc>')[0];
  assert.equal(o.ok, false);
}

// —— 调用契约：extractOptionLine 面向单行输入；多行文本必须外层先 split 成行 ——
{
  // 若直接喂多行文本，后一行（如 <停顿>）的 > 会被误当作上一选项的闭合符，因此调用方（剧情块图谱等）必须按行解析。
  // 这里验证按行解析的正确性（逐行调用，闭合不跨行）：
  const twoLines = '<选项:"A",块A><选项:"B",块B>\n<停顿>\n<选项:"C",块C>';
  const perLine = twoLines.split(/\r?\n/).flatMap(function (l) { return ctx.extractOptionLine(l).filter(function (o) { return o.ok; }); });
  assert.equal(perLine.length, 3);
  assert.equal(ctx.splitOptionExtra(perLine[0].extra).block, '块A');
  assert.equal(ctx.splitOptionExtra(perLine[1].extra).block, '块B');
  assert.equal(ctx.splitOptionExtra(perLine[2].extra).block, '块C');
}

// —— 运行时求值联动（与 exporter.js evalCond/evalOneCond 语义一致）——
{
  const vars = { 力量: 10, 金币: 30 };
  const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === '是' || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v.length > 0 && v !== 'false' && v !== '否' && v !== '0');
  function evalOneCond(e) {
    if (e.charAt(0) === '!') { const nm = e.slice(1).trim(); return !truthy(vars[nm]); }
    if (/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(e)) { return truthy(vars[e]); }
    const m = e.match(/^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(>=|<=|==|!=|>|<|=)\s*(.+)$/);
    if (!m) return false;
    const name = m[1], op = m[2], rv = m[3].trim();
    const lv = vars[name];
    let rvv;
    if (rv === 'true') rvv = true; else if (rv === 'false') rvv = false;
    else if (/^-?\d+(\.\d+)?$/.test(rv)) rvv = Number(rv);
    else rvv = rv;
    switch (op) {
      case '>': return Number(lv) > Number(rvv);
      case '<': return Number(lv) < Number(rvv);
      case '>=': return Number(lv) >= Number(rvv);
      case '<=': return Number(lv) <= Number(rvv);
      case '==': case '=': return lv == rvv;
      case '!=': return lv != rvv;
    }
    return false;
  }
  const sp = ctx.splitOptionExtra(ctx.extractOptionLine('<选项:"强攻",战斗块,条件:力量>=20>')[0].extra);
  assert.equal(evalOneCond(sp.condition), false, '力量=10 时 力量>=20 为假 → 选项应隐藏');
  vars.力量 = 25;
  assert.equal(evalOneCond(sp.condition), true, '力量=25 时 力量>=20 为真 → 选项应显示');
}

console.log('option condition parsing test passed');