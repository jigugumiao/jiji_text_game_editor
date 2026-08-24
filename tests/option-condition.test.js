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

// 从 editor.js 原样提取纯函数并运行（测试真实源码，不复制实现）
function grab(name) {
  const m = editorSrc.match(new RegExp('function ' + name + '\\s*\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(m, 'source contains ' + name);
  return m[0];
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(grab('extractOptionLine') + '\n' + grab('splitOptionExtra') + '\n' + grab('rewriteCondVarsInLine'), ctx);

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

// —— < 与 <= 运算符（第二类尖括号，曾误判为「嵌套标签」/ 截断）——
{
  // 单 < 比较：<选项:"偷摸进村",潜入,条件:警戒<5>
  const oLt = ctx.extractOptionLine('<选项:"偷摸进村",潜入,条件:警戒<5>')[0];
  const spLt = ctx.splitOptionExtra(oLt.extra);
  assert.equal(spLt.block, '潜入');
  assert.equal(spLt.condition, '警戒<5', '< 不应截断条件，也不应被当作嵌套标签');

  // <= 比较：条件:金币<=20 && 力气>=5
  const oLe = ctx.extractOptionLine('<选项:"买东西",集市,条件:金币<=20 && 力气>=5>')[0];
  const spLe = ctx.splitOptionExtra(oLe.extra);
  assert.equal(spLe.block, '集市');
  assert.equal(spLe.condition, '金币<=20 && 力气>=5');

  // 新增的嵌套标签检查：内层 < 后跟数字（比较符）不算嵌套；后跟指令关键字才算
  const nestedRe = new RegExp('<[^>]*<(?:召唤|选项|变量|停顿|标题|分割线|剧情块|对话块|跳回|跳回重选|停止音乐|随机跳转|随机句子)[^>]*>');
  assert.equal(nestedRe.test('<选项:"A",块A,条件:警戒<5>'), false, '条件里的 <5 不是嵌套标签');
  assert.equal(nestedRe.test('<召唤背景:<变量:金币>>'), true, '<召唤> 内嵌 <变量:> 仍是错误嵌套');
  // <当:>/</当>/<否则> 已移除：普通 <当:金币<5> 不被嵌套检查误判；<当:<选项:...>> 因内层是选项指令仍按嵌套报错
  assert.equal(nestedRe.test('<当:金币<5>'), false, '已移除的 <当:金币<5> 不应被嵌套检查误判');
  assert.equal(nestedRe.test('<当:<选项:"A",块A>>'), true, '<当: 内嵌 <选项:> 走嵌套检查报错（与其它真嵌套一致）');
}

// —— 变量改名必须同步选项条件里的变量名（renameVarEverywhere 的逐行核心逻辑）——
{
  // 复刻 renameVarEverywhere 的 reCond（整词匹配、前后须非标识符字符）
  const escOld = '金币'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reCond = new RegExp('(^|[^A-Za-z0-9_\\u4e00-\\u9fa5])(' + escOld + ')(?=[^A-Za-z0-9_\\u4e00-\u9fa5]|$)', 'g');

  // 选项条件：>= 运算符 + 复合条件
  const o1 = ctx.rewriteCondVarsInLine('<选项:"掏空钱袋",豪赌,条件:金币>=20 && 力气>5>', reCond, '银两');
  assert.equal(o1.changed, true);
  assert.equal(o1.line, '<选项:"掏空钱袋",豪赌,条件:银两>=20 && 力气>5>', '选项条件里的变量应同步改名');

  // 同行多个选项、只有部分带条件
  const o2 = ctx.rewriteCondVarsInLine('<选项:"A",块A><选项:"B",块B,条件:金币<=3>', reCond, '银两');
  assert.equal(o2.changed, true);
  assert.equal(o2.line, '<选项:"A",块A><选项:"B",块B,条件:银两<=3>', '第二个选项条件改名、第一个不受影响');

  // 不带条件的选项行不应被改动
  const o3 = ctx.rewriteCondVarsInLine('<选项:"C",块C>', reCond, '银两');
  assert.equal(o3.changed, false);
  assert.equal(o3.line, '<选项:"C",块C>');

  // 条件里的其它变量（非改名对象）保持不变
  const o4 = ctx.rewriteCondVarsInLine('<选项:"D",块D,条件:金币>=1 && 勇气>=1>', reCond, '银两');
  assert.equal(o4.line, '<选项:"D",块D,条件:银两>=1 && 勇气>=1>');
}

console.log('option condition parsing test passed');