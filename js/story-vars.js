// js/story-vars.js — 变量系统单一事实源（共享模块）
// 编辑器预览 / 校验 / 修复器 / 导出端 parseStoryForExport / 导出游戏运行时，
// 全部从这里取同一份实现，杜绝多份解析器手工同步造成的分叉。
//
// 正文语法：
//   读：  {名} · {名:真文案|假文案}（仅布尔） · {{名}} 转义保留
//   写：  <变量:名=值> / <变量:名+N> / <变量:名-N>（一行可多个标签；单标签内兼容旧版 ; 分隔）
//   输入：<玩家输入变量:名,"引导文字">
//   条件：<选项:"文字",块名,条件:表达式> —— 支持 && || ! () 与比较运算符，优先级 || < && < !
//
// 值语义（唯一权威定义）：
//   赋值 = ：'true'/'false' → 布尔；纯数字 → 数字；其余（可含空格、可为空）→ 文本
//   +N/-N：当前值转数字（失败按 0）后加减
//   truthy：true/'true'/1/'1'/'是'/非零数字/非空且非 'false' '否' '0' 的字符串

(function () {
  'use strict';

  var NAME_SRC = '[A-Za-z_\\u4e00-\\u9fa5][A-Za-z0-9_\\u4e00-\\u9fa5]*';
  var NAME_RE = new RegExp('^' + NAME_SRC + '$');
  // 单个 <变量:...> 标签：内容里不允许出现 '>'（值含空格允许）
  var VAR_TAG_RE = /<变量:\s*([^>]*?)\s*>/g;
  var PLAYER_INPUT_RE = new RegExp('^<玩家输入变量:\\s*(' + NAME_SRC + ')\\s*,\\s*"([\\s\\S]*?)"\\s*>$');

  // ---------- 解析 ----------

  // 解析一行 <变量:...> 指令。返回 { ops:[{name,op,val}], bad:['<变量:...>',...] }。
  // 规则：逐标签提取（修复旧导出端整行贪婪匹配导致的多标签行损坏）；
  //       标签内容兼容旧版分号分隔（<变量:a=1;b=2>）；值允许空格与空串。
  function parseVarLine(line) {
    var t = String(line == null ? '' : line).trim();
    var res = { ops: [], bad: [] };
    if (t.indexOf('<变量:') !== 0 || t.charAt(t.length - 1) !== '>') return res;
    VAR_TAG_RE.lastIndex = 0;
    var m;
    while ((m = VAR_TAG_RE.exec(t)) !== null) {
      var content = m[1];
      var segOps = [];
      var allValid = true;
      var segs = content.split(';');
      for (var i = 0; i < segs.length; i++) {
        var seg = segs[i].trim();
        if (!seg) continue;
        var am = seg.match(new RegExp('^(' + NAME_SRC + ')\\s*([=+\\-])\\s*([\\s\\S]*)$'));
        if (am) segOps.push({ name: am[1], op: am[2], val: am[3].trim() });
        else { allValid = false; break; }
      }
      if (allValid && segOps.length) {
        for (var j = 0; j < segOps.length; j++) res.ops.push(segOps[j]);
      } else {
        res.bad.push(m[0]);
      }
    }
    return res;
  }

  // 序列化（编辑器往返保持稳定）：每个操作一个标签
  function serializeVarOps(ops) {
    return (ops || []).map(function (o) {
      return '<变量:' + o.name + (o.op === '=' ? '=' : o.op) + o.val + '>';
    }).join('');
  }

  // <玩家输入变量:名,"提示"> → { name, prompt } | null
  function parsePlayerInput(line) {
    var m = String(line == null ? '' : line).trim().match(PLAYER_INPUT_RE);
    return m ? { name: m[1], prompt: m[2] } : null;
  }

  // 从一行选项指令里提取所有条件表达式文本。
  // 结束边界：真正的 '>'（不属于 >= <= => ）或 ','；表达式值不支持逗号/引号内尖括号。
  function extractCondExprs(line) {
    var t = String(line == null ? '' : line);
    var out = [];
    var idx = t.indexOf('条件:');
    while (idx >= 0) {
      var i = idx + 3, expr = '';
      for (; i < t.length; i++) {
        var ch = t[i];
        if (ch === '>') {
          var prev = t[i - 1] || '';
          var next = t[i + 1] || '';
          // >= / <= / => 中的「>」不是闭合符
          if (prev === '=' || prev === '<' || next === '=') { expr += ch; continue; }
          break;
        }
        if (ch === ',') break;
        expr += ch;
      }
      out.push(expr.trim());
      idx = t.indexOf('条件:', i);
    }
    return out;
  }

  // ---------- 类型与求值（RUNTIME_FNS：全部为无闭包的具名函数，供运行时序列化注入） ----------

  // 赋值字面量 → 布尔 / 数字 / 字符串
  function coerceLiteral(raw) {
    var v = String(raw == null ? '' : raw);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }

  function truthy(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === '是'
      || (typeof v === 'number' && v !== 0)
      || (typeof v === 'string' && v.length > 0 && v !== 'false' && v !== '否' && v !== '0');
  }

  // 对 vars 字典就地应用一组操作
  function applyOps(vars, ops) {
    (ops || []).forEach(function (o) {
      var cur = vars[o.name];
      if (o.op === '=') {
        vars[o.name] = coerceLiteral(o.val);
      } else if (o.op === '+') {
        var base1 = (typeof cur === 'number') ? cur : (Number(cur) || 0);
        vars[o.name] = base1 + (Number(o.val) || 0);
      } else if (o.op === '-') {
        var base2 = (typeof cur === 'number') ? cur : (Number(cur) || 0);
        vars[o.name] = base2 - (Number(o.val) || 0);
      }
    });
  }

  // ---------- 条件表达式：解析（AST）与求值分离，语法校验复用同一解析器 ----------
  // 文法：expr := or；or := and ('||' and)*；and := unary ('&&' unary)*；
  //       unary := '!' unary | primary；primary := '(' expr ')' | comparison | bare-name
  // comparison := name op value，op ∈ >= <= == != > < = contains notcontains
  // AST 节点：{k:'or'|'and', l, r} · {k:'not', e} · {k:'cmp', name, op, val:{s:'num'|'str'|'bool'|'word', v}} · {k:'bare', name}

  // 解析失败返回 null。空表达式视为恒真，返回 { k:'true' }。
  function parseCondition(expr) {
    var s = String(expr == null ? '' : expr).trim();
    if (!s) return { k: 'true' };
    var toks = condTokenize(s);
    if (!toks) return null;
    var pos = 0;
    function peek() { return toks[pos]; }
    function next() { return toks[pos++]; }
    function parseOr() {
      var left = parseAnd();
      while (peek() && peek().t === 'op' && peek().v === '||') {
        next();
        var right = parseAnd();
        left = { k: 'or', l: left, r: right };
      }
      return left;
    }
    function parseAnd() {
      var left = parseUnary();
      while (peek() && peek().t === 'op' && peek().v === '&&') {
        next();
        var right = parseUnary();
        left = { k: 'and', l: left, r: right };
      }
      return left;
    }
    function parseUnary() {
      var tk = peek();
      if (tk && tk.t === 'op' && tk.v === '!') { next(); return { k: 'not', e: parseUnary() }; }
      return parsePrimary();
    }
    function parsePrimary() {
      var tk = peek();
      if (!tk) return null;
      if (tk.t === 'op' && tk.v === '(') {
        next();
        var inner = parseOr();
        var close = peek();
        if (!(close && close.t === 'op' && close.v === ')')) return null;
        next();
        return inner;
      }
      if (tk.t !== 'name') return null;
      next();
      var nk = peek();
      if (nk && nk.t === 'op' && (nk.v === '>=' || nk.v === '<=' || nk.v === '==' || nk.v === '!=' || nk.v === '>' || nk.v === '<' || nk.v === '=' || nk.v === 'contains' || nk.v === 'notcontains')) {
        next();
        var vk = next();
        if (!vk || vk.t === 'op') return null;
        return { k: 'cmp', name: tk.v, op: nk.v, val: valToken(vk) };
      }
      return { k: 'bare', name: tk.v };
    }
    var ast = parseOr();
    if (!ast || pos !== toks.length) return null; // 剩余 token = 语法错误
    return ast;
  }

  function condTokenize(src) {
    var out = [], i = 0;
    while (i < src.length) {
      var ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"' || ch === '\u201c' || ch === '\u201d') {
        var closeCh = (ch === '"') ? '"' : '\u201d';
        var j = i + 1, str = '';
        while (j < src.length && src[j] !== closeCh) {
          if (src[j] === '\\' && closeCh === '"' && j + 1 < src.length) {
            var escaped = src[j + 1];
            if (escaped === '"' || escaped === '\\') { str += escaped; j += 2; continue; }
          }
          str += src[j]; j++;
        }
        if (j >= src.length) return null;
        out.push({ t: 'str', v: str });
        i = j + 1;
        continue;
      }
      var two = src.substr(i, 2);
      if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
        out.push({ t: 'op', v: two }); i += 2; continue;
      }
      if ('><=!()'.indexOf(ch) >= 0) {
        // 兼容旧写法：单独的「=」按等于处理
        out.push({ t: 'op', v: ch }); i++; continue;
      }
      var wordOp = src.slice(i).match(/^(notcontains|contains)(?![A-Za-z0-9_\u4e00-\u9fa5])/);
      if (wordOp) { out.push({ t: 'op', v: wordOp[1] }); i += wordOp[1].length; continue; }
      var nm = src.slice(i).match(/^-?\d+(\.\d+)?/);
      if (nm && (i === 0 || !/[\w\u4e00-\u9fa5_]/.test(src[i - 1]))) {
        out.push({ t: 'num', v: nm[0] }); i += nm[0].length; continue;
      }
      var idm = src.slice(i).match(/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/);
      if (idm) { out.push({ t: 'name', v: idm[0] }); i += idm[0].length; continue; }
      return null; // 无法识别的字符
    }
    return out;
  }

  function valToken(tk) {
    if (tk.t === 'num') return { s: 'num', v: Number(tk.v) };
    if (tk.t === 'str') return { s: 'str', v: tk.v };
    if (tk.v === 'true') return { s: 'bool', v: true };
    if (tk.v === 'false') return { s: 'bool', v: false };
    return { s: 'word', v: tk.v };
  }

  function compareVals(lv, op, rv) {
    switch (op) {
      case '>': return Number(lv) > Number(rv);
      case '<': return Number(lv) < Number(rv);
      case '>=': return Number(lv) >= Number(rv);
      case '<=': return Number(lv) <= Number(rv);
      case '==': case '=': return lv == rv; // eslint-disable-line eqeqeq
      case '!=': return lv != rv;           // eslint-disable-line eqeqeq
      case 'contains': return String(lv).indexOf(String(rv)) >= 0;
      case 'notcontains': return String(lv).indexOf(String(rv)) < 0;
    }
    return false;
  }

  function evalAst(node, getVar) {
    switch (node.k) {
      case 'true': return true;
      case 'or': return evalAst(node.l, getVar) || evalAst(node.r, getVar);
      case 'and': return evalAst(node.l, getVar) && evalAst(node.r, getVar);
      case 'not': return !truthy(evalAst(node.e, getVar));
      case 'bare': return truthy(getVar(node.name));
      case 'cmp': return compareVals(getVar(node.name), node.op, node.val.v);
    }
    return false;
  }

  // 条件表达式求值。getVar(name) 返回当前值（undefined 表示未定义）。
  // 空表达式 → true；语法错误 → false（编辑期用 parseCondition 单独报告语法问题）。
  function evalCondition(expr, getVar) {
    var ast = parseCondition(expr);
    if (!ast) return false;
    try { return !!evalAst(ast, getVar); } catch (e) { return false; }
  }

  // AST → 稳定的条件文本。不同优先级的逻辑组合显式加括号，避免编辑器往返时含义含混。
  function serializeCondition(ast) {
    function value(val) {
      if (!val) return '';
      if (val.s === 'num') return String(val.v);
      if (val.s === 'bool') return val.v ? 'true' : 'false';
      if (val.s === 'word') return String(val.v);
      return '"' + String(val.v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    function walk(node, parentKind) {
      if (!node) return '';
      if (node.k === 'true') return 'true';
      if (node.k === 'bare') return node.name;
      if (node.k === 'cmp') {
        var operator = node.op === 'contains' || node.op === 'notcontains' ? ' ' + node.op + ' ' : node.op;
        return node.name + operator + value(node.val);
      }
      if (node.k === 'not') {
        var negated = walk(node.e, 'not');
        return '!' + ((node.e && (node.e.k === 'and' || node.e.k === 'or')) ? '(' + negated + ')' : negated);
      }
      var op = node.k === 'and' ? ' && ' : ' || ';
      var body = walk(node.l, node.k) + op + walk(node.r, node.k);
      return parentKind && parentKind !== node.k && parentKind !== 'not' ? '(' + body + ')' : body;
    }
    return walk(ast, '');
  }

  function summarizeComparison(node) {
    var words = {
      '>=': '不少于', '<=': '不多于', '>': '大于', '<': '小于',
      '==': '等于', '=': '等于', '!=': '不等于',
      'contains': '包含', 'notcontains': '不包含'
    };
    var val = node.val || {};
    var rendered = val.s === 'str' ? '“' + String(val.v) + '”' : String(val.v);
    return node.name + (words[node.op] || node.op) + ' ' + rendered;
  }

  // AST → 面向作者的中文摘要。且的优先级高于“或者”，故其组合无需额外括号。
  function summarizeCondition(ast, typeMap) { // eslint-disable-line no-unused-vars
    function walk(node, parentPrec) {
      if (!node) return '';
      if (node.k === 'true') return '始终成立';
      if (node.k === 'bare') return node.name + '是“是”';
      if (node.k === 'cmp') return summarizeComparison(node);
      if (node.k === 'not') return '不是（' + walk(node.e, 0) + '）';
      var prec = node.k === 'and' ? 2 : 1;
      var glue = node.k === 'and' ? ' 且' : '，或者';
      var body = walk(node.l, prec) + glue + walk(node.r, prec);
      return prec < parentPrec ? '（' + body + '）' : body;
    }
    return walk(ast, 0);
  }

  // 验证 AST 运算符是否与声明变量类型匹配。类型表为 {变量名: 'number'|'boolean'|'text'}。
  function validateConditionTypes(ast, typeMap) {
    var errors = [];
    var map = typeMap || {};
    function variableType(name) { return map[name]; }
    function requireType(node, expected) {
      var actual = variableType(node.name);
      if (actual !== expected) errors.push({ name: node.name, op: node.op, expected: expected, actual: actual });
    }
    function walk(node) {
      if (!node) return;
      if (node.k === 'bare') {
        var actual = variableType(node.name);
        if (actual !== 'boolean') errors.push({ name: node.name, op: 'bare', expected: 'boolean', actual: actual });
      } else if (node.k === 'cmp') {
        if (node.op === 'contains' || node.op === 'notcontains') requireType(node, 'text');
        else if (node.op === '>' || node.op === '<' || node.op === '>=' || node.op === '<=') requireType(node, 'number');
      } else if (node.k === 'not') walk(node.e);
      else { walk(node.l); walk(node.r); }
    }
    walk(ast);
    return { ok: errors.length === 0, errors: errors };
  }

  // 正文插值：{名} / {名:真文案|假文案}；未定义保留原样；{{名}} 转义保留；布尔显示 真/假
  function interpolate(s, getVar) {
    return String(s == null ? '' : s).replace(
      /\{\{?\s*([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(?::\s*([^}\s|]*)\s*\|\s*([^}]*))?\s*\}/g,
      function (m, name, t, f) {
        if (m.charAt(1) === '{') return m; // 双花括号转义
        var val = getVar(name);
        if (val === undefined) return m;
        if (t !== undefined && f !== undefined) {
          var isTrue = (val === true || val === 'true' || val === 1 || val === '1');
          return isTrue ? t : f;
        }
        if (val === true) return '真';
        if (val === false) return '假';
        return String(val);
      }
    );
  }

  var RUNTIME_FNS = {
    coerceLiteral: coerceLiteral,
    truthy: truthy,
    applyOps: applyOps,
    condTokenize: condTokenize,
    valToken: valToken,
    compareVals: compareVals,
    parseCondition: parseCondition,
    evalAst: evalAst,
    evalCondition: evalCondition,
    interpolate: interpolate,
  };

  // 生成可注入导出 HTML 的运行时源码（函数序列化，保证与编辑端同源）
  function buildRuntimeSource() {
    var src = '(function(){\n"use strict";\nvar SV={};\n';
    Object.keys(RUNTIME_FNS).forEach(function (k) {
      src += RUNTIME_FNS[k].toString() + '\n';
      src += 'SV.' + k + '=' + k + ';\n';
    });
    src += 'window.StoryVars=SV;\n})();';
    return src;
  }

  // ---------- 静态分析（校验器 / 修复器的数据来源） ----------

  // 从赋值的字面量推断变量类型
  function inferTypeFromValue(raw) {
    var v = String(raw == null ? '' : raw);
    if (v === 'true' || v === 'false') return 'boolean';
    if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
    return 'text';
  }

  // 提取正文里的变量引用 {名} / {名:a|b}（跳过 {{转义}}）
  function extractRefs(text) {
    var out = [];
    var re = /\{\s*([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(?::\s*([^}\s|]*)\s*\|\s*([^}]*))?\s*\}/g;
    var m;
    var s = String(text == null ? '' : text);
    while ((m = re.exec(s)) !== null) {
      if (m.index > 0 && s.charAt(m.index + 1) === '{') continue; // {{转义}}
      out.push({ name: m[1], disp: (m[2] !== undefined && m[3] !== undefined) });
    }
    return out;
  }

  // 条件表达式分析：引用的变量名集合 + 语法是否可解析。
  // 返回 { names:[...], error: null | 'empty' | 'syntax' }
  function analyzeConditionExpr(expr) {
    var s = String(expr == null ? '' : expr).trim();
    if (!s) return { names: [], error: 'empty' };
    var ast = parseCondition(s);
    if (!ast) return { names: [], error: 'syntax', raw: s };
    var names = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.k === 'bare' || n.k === 'cmp') {
        if (n.name !== 'true' && n.name !== 'false' && names.indexOf(n.name) < 0) names.push(n.name);
        if (n.k === 'cmp' && n.val && n.val.s === 'word') {
          // 比较值若是裸词且与某变量同名，旧运行时按字符串处理；这里不算变量引用
        }
      }
      if (n.l) walk(n.l);
      if (n.r) walk(n.r);
      if (n.e) walk(n.e);
    })(ast);
    return { names: names, error: null, raw: s };
  }

  // 编辑距离（用于错别字建议）
  function editDistance(a, b) {
    a = String(a); b = String(b);
    var m = a.length, n = b.length;
    var dp = [];
    for (var i = 0; i <= m; i++) { dp.push([i]); }
    for (var j = 0; j <= n; j++) { dp[0][j] = j; }
    for (var i2 = 1; i2 <= m; i2++) {
      for (var j2 = 1; j2 <= n; j2++) {
        var cost = (a[i2 - 1] === b[j2 - 1]) ? 0 : 1;
        dp[i2][j2] = Math.min(dp[i2 - 1][j2] + 1, dp[i2][j2 - 1] + 1, dp[i2 - 1][j2 - 1] + cost);
      }
    }
    return dp[m][n];
  }

  // 从候选名里给疑似错别字找最近的真实变量
  function suggestRename(typo, declaredNames) {
    var best = null, bestD = Infinity;
    var maxD = (String(typo).length <= 4) ? 1 : 2;
    declaredNames.forEach(function (nm) {
      var d = editDistance(typo, nm);
      if (d > 0 && d <= maxD && d < bestD) { best = nm; bestD = d; }
    });
    return best;
  }

  // 全项目扫描。blocks: { 块名: 正文 }；varDefs: [{name,type,value}]
  // 返回 { usage, issues }：
  //   usage[name] = { reads:[{block,line}], writes:[{block,line}], conds:[{block,line}] }
  //   issues[] = { kind, severity:'error'|'warning'|'info', block, line, name?, raw?, message, fixes? }
  function analyze(blocks, varDefs) {
    var declared = {};   // name -> type
    var declaredNames = [];
    (varDefs || []).forEach(function (v) {
      if (!v || !v.name) return;
      var nm = String(v.name).trim();
      if (!nm) return;
      declared[nm] = v.type || 'text';
      declaredNames.push(nm);
    });
    var usage = {};
    var issues = [];
    function use(name, kind, block, line) {
      if (!usage[name]) usage[name] = { reads: [], writes: [], conds: [] };
      usage[name][kind].push({ block: block, line: line });
    }
    function fixFor(name, sampleValue) {
      var fixes = [{
        type: 'create_var', name: name,
        varType: inferTypeFromValue(sampleValue != null ? sampleValue : ''),
        value: (inferTypeFromValue(sampleValue != null ? sampleValue : '') === 'number') ? 0
          : (inferTypeFromValue(sampleValue != null ? sampleValue : '') === 'boolean') ? false : '',
      }];
      var sug = suggestRename(name, declaredNames);
      if (sug) fixes.push({ type: 'rename_var', from: name, to: sug });
      return fixes;
    }
    Object.keys(blocks).forEach(function (bn) {
      var lines = String(blocks[bn] == null ? '' : blocks[bn]).split('\n');
      lines.forEach(function (raw, i) {
        var n = i + 1;
        var t = String(raw).trim();
        if (!t) return;
        if (/^\s*\/\//.test(raw)) return;
        // <变量:...> 行
        if (t.indexOf('<变量:') === 0 && t.charAt(t.length - 1) === '>') {
          var pr = parseVarLine(t);
          pr.bad.forEach(function (rawTag) {
            issues.push({
              kind: 'malformed_tag', severity: 'error', block: bn, line: n, raw: rawTag,
              message: '无法识别的变量指令「' + rawTag + '」（正确格式如 <变量:金币=10>），导出时该行将按普通文本处理',
              fixes: [{ type: 'remove_tag', block: bn, line: n, raw: rawTag }],
            });
          });
          pr.ops.forEach(function (op) {
            use(op.name, 'writes', bn, n);
            if (!(op.name in declared)) {
              issues.push({
                kind: 'undeclared_write', severity: 'error', block: bn, line: n, name: op.name,
                message: '变量「' + op.name + '」未在变量库定义就被赋值（可能是错别字，会导致运行时凭空多出一个变量）',
                fixes: fixFor(op.name, op.val),
              });
            } else if ((op.op === '+' || op.op === '-') && declared[op.name] !== 'number') {
              issues.push({
                kind: 'type_mismatch', severity: 'warning', block: bn, line: n, name: op.name,
                message: '变量「' + op.name + '」是' + typeName(declared[op.name]) + '，不能做加减运算（仅数字类型支持 +N / -N）',
              });
            }
          });
          return;
        }
        // <玩家输入变量:...>
        var pi = parsePlayerInput(t);
        if (pi) {
          use(pi.name, 'writes', bn, n);
          if (!(pi.name in declared)) {
            issues.push({
              kind: 'undeclared_write', severity: 'error', block: bn, line: n, name: pi.name,
              message: '玩家输入写入的变量「' + pi.name + '」未在变量库定义',
              fixes: fixFor(pi.name, ''),
            });
          }
          return;
        }
        // 选项行：条件检查
        if (t.indexOf('<选项:') >= 0) {
          extractCondExprs(t).forEach(function (cexpr) {
            var r = analyzeConditionExpr(cexpr);
            r.names.forEach(function (nm2) {
              use(nm2, 'conds', bn, n);
              if (!(nm2 in declared)) {
                issues.push({
                  kind: 'undeclared_read', severity: 'warning', block: bn, line: n, name: nm2,
                  message: '条件「' + cexpr.trim() + '」引用了未定义的变量「' + nm2 + '」（未定义变量按空值参与比较）',
                  fixes: fixFor(nm2, ''),
                });
              }
            });
            if (r.error === 'empty') {
              issues.push({
                kind: 'cond_parse_error', severity: 'error', block: bn, line: n,
                message: '条件选项缺少条件表达式（如 <选项:"文字",块名,条件:金币>=10>）',
              });
            } else if (r.error === 'syntax') {
              issues.push({
                kind: 'cond_parse_error', severity: 'warning', block: bn, line: n,
                message: '条件「' + cexpr.trim() + '」无法解析（支持 && || ! 和比较运算，字符串请加引号）',
              });
            }
          });
        }
        // {名} 引用
        extractRefs(t).forEach(function (ref) {
          use(ref.name, 'reads', bn, n);
          if (!(ref.name in declared)) {
            issues.push({
              kind: 'undeclared_read', severity: 'warning', block: bn, line: n, name: ref.name,
              message: '未定义的变量「' + ref.name + '」（请在素材库·变量库定义，或用 <变量:' + ref.name + '=值> 赋值）',
              fixes: fixFor(ref.name, ''),
            });
          } else if (ref.disp && declared[ref.name] !== 'boolean') {
            issues.push({
              kind: 'type_mismatch', severity: 'warning', block: bn, line: n, name: ref.name,
              message: '显示映射 {' + ref.name + ':真|假} 仅用于布尔变量，「' + ref.name + '」是' + typeName(declared[ref.name]),
            });
          }
        });
      });
    });
    // 汇总级问题
    declaredNames.forEach(function (nm) {
      var u = usage[nm];
      if (!u || u.writes.length === 0) {
        issues.push({
          kind: 'never_written', severity: 'info', block: null, line: 0, name: nm,
          message: '变量「' + nm + '」从未被赋值（也没有玩家输入），游戏中将永远保持初值',
        });
      } else if (u.reads.length === 0 && u.conds.length === 0) {
        issues.push({
          kind: 'dead_var', severity: 'info', block: null, line: 0, name: nm,
          message: '变量「' + nm + '」被赋值但从未被读取或用于条件（可能是死变量）',
        });
      }
    });
    return { usage: usage, issues: issues };
  }

  function typeName(t) {
    return t === 'number' ? '数字' : t === 'boolean' ? '布尔' : '文本';
  }

  var StoryVars = {
    parseVarLine: parseVarLine,
    serializeVarOps: serializeVarOps,
    parsePlayerInput: parsePlayerInput,
    extractCondExprs: extractCondExprs,
    extractRefs: extractRefs,
    coerceLiteral: coerceLiteral,
    truthy: truthy,
    applyOps: applyOps,
    condTokenize: condTokenize,
    parseCondition: parseCondition,
    serializeCondition: serializeCondition,
    summarizeCondition: summarizeCondition,
    validateConditionTypes: validateConditionTypes,
    evalCondition: evalCondition,
    interpolate: interpolate,
    inferTypeFromValue: inferTypeFromValue,
    suggestRename: suggestRename,
    editDistance: editDistance,
    analyze: analyze,
    buildRuntimeSource: buildRuntimeSource,
    RUNTIME_FNS: RUNTIME_FNS,
  };

  if (typeof window !== 'undefined') window.StoryVars = StoryVars;
  if (typeof module !== 'undefined' && module.exports) module.exports = StoryVars;
})();
