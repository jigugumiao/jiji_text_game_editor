// js/agent.js — Agent 对话（全能助理）：意图路由 + 工具调用循环
// 设计文档：docs/agent-design.md
(function () {
  'use strict';

  // 场景表：id → { systemPrompt, preload, tools }
  // preload 取值：'full_text'|'outline'|'current_block'|'settings'|'vars'（buildMessages 按此取上下文）
  // tools：场景允许的工具名白名单（空数组=全部工具；非空=仅白名单）
  var AGENT_SCENARIOS = {
    polish: {
      systemPrompt: '你是剧情编辑器的局部改稿助手。只处理用户明确指出的片段，默认只读当前编辑块，不主动读取或修改其他块。需要修改时使用写工具，改动遵循小改自动落盘、大改预览确认。不要输出整篇全文。',
      preload: ['current_block'],
      tools: ['get_current_block', 'read_block', 'search_in_doc', 'append_to_block', 'insert_at', 'apply_review_marker'],
    },
    rewrite: {
      systemPrompt: '你是剧情编辑器的整篇改写/续写助手。可读取全文后整篇重写或续写，保留 <<剧情块:名称>> 分块标记与 <跳回>/<跳回重选> 跳转标记，只改写文字。大篇幅改动会走 diff 预览确认。',
      preload: ['full_text', 'outline'],
      tools: [],
    },
    design: {
      systemPrompt: '你是剧情编辑器的剧情设计顾问。围绕世界观、大纲、人物与剧情走向回答问题、出主意、梳理结构。以只读为主，可写大纲类块；不要擅自动当前正在创作的正文。',
      preload: ['outline', 'current_block'],
      tools: [],
    },
    vars: {
      systemPrompt: '你是剧情编辑器的变量/逻辑助手。专注变量库与正文中的变量语法（{名} 读取、<变量:名=值>、<变量:名+n>、<变量:名-n>、<玩家输入变量:名,"引导">、<选项:"文字",块名,条件:表达式>）。可增删改查变量，不改动正文叙事结构。',
      preload: ['vars', 'current_block'],
      tools: [],
    },
    general: {
      systemPrompt: '你是剧情编辑器的全能助理。通过工具按需读取任意剧情块、全文、设定、变量与素材元数据，回答或执行用户请求。写操作遵循小改自动、大改预览、破坏性操作强制确认。',
      preload: ['outline', 'current_block'],
      tools: [],
    },
  };

  var Agent = {
    AGENT_SCENARIOS: AGENT_SCENARIOS,

    // 意图轮输出解析：提取「首个平衡的 {…} 对象」（容忍 ```json 包裹与前后闲话）
    // 失败/未知 scenario → 兜底 general；needs 仅作提示，最终预载由场景表 preload 决定
    intentParse: function (raw) {
      var out = { scenario: 'general', needs: [], note: '' };
      if (!raw || typeof raw !== 'string') return out;
      // 从每个 '{' 起按深度匹配到其闭合 '}'，能 JSON.parse 且是对象即用；
      // 尾随闲聊里的花括号（如变量语法 {名}）不会吞掉前面的合法 JSON，前置的 decoy 花括号也会被跳过
      var start = raw.indexOf('{');
      while (start >= 0) {
        var depth = 0, end = -1;
        for (var i = start; i < raw.length; i++) {
          if (raw[i] === '{') depth++;
          else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) break; // 剩余部分没有闭合的花括号，放弃
        var slice = raw.slice(start, end + 1);
        try {
          var j = JSON.parse(slice);
          if (j && typeof j === 'object') {
            // 只认场景表自有键（防 __proto__/constructor 等原型链键混入）
            if (Object.prototype.hasOwnProperty.call(AGENT_SCENARIOS, j.scenario)) out.scenario = j.scenario;
            if (Array.isArray(j.needs)) out.needs = j.needs.filter(function (n) { return typeof n === 'string'; });
            if (typeof j.note === 'string') out.note = j.note;
          }
          return out;
        } catch (e) {
          // 该段不是合法 JSON（如 {名} 变量语法），跳到下一个 '{' 继续找
          start = raw.indexOf('{', start + 1);
        }
      }
      return out;
    },

    // 消息前缀构造（设计 §4.3 缓存纪律）：
    // [system: 场景 system 提示词] → [system: 创作设定] → [user: 预载上下文] → [user: 用户最新消息]
    // 预载内容按场景表 preload 固定顺序拼装、同场景同工程不变 → 前缀稳定可命中缓存；
    // 可变内容（用户消息/工具往返）只 append 在末尾，绝不插入中段。
    buildMessages: function (scenario, ctx, userText, opts) {
      // 只认场景表自有键（防 __proto__/constructor 等原型链键产生 undefined systemPrompt）
      var sc = Object.prototype.hasOwnProperty.call(AGENT_SCENARIOS, scenario) ? AGENT_SCENARIOS[scenario] : AGENT_SCENARIOS.general;
      ctx = ctx || {};
      var msgs = [];
      msgs.push({ role: 'system', content: sc.systemPrompt });
      var settings = ctx.settings;
      if (settings && String(settings).trim()) {
        msgs.push({ role: 'system', content: '【创作设定】\n' + settings });
      }
      // 预载上下文（固定顺序，保证前缀稳定）
      var pre = [];
      var want = sc.preload || [];
      for (var i = 0; i < want.length; i++) {
        var k = want[i];
        if (k === 'full_text' && ctx.fullText) pre.push('【全文】\n' + ctx.fullText);
        else if (k === 'outline' && ctx.outline) pre.push('【大纲】\n' + ctx.outline);
        else if (k === 'current_block' && ctx.currentBlock && ctx.currentBlock.text) pre.push('【当前编辑块《' + ctx.currentBlock.name + '》】\n' + ctx.currentBlock.text);
        else if (k === 'settings' && settings && String(settings).trim()) pre.push('【创作设定】\n' + settings);
        else if (k === 'vars' && ctx.vars && ctx.vars.length) {
          pre.push('【变量库】\n' + ctx.vars.map(function (v) { return v.name + ' (' + v.type + ') = ' + v.value; }).join('\n'));
        }
      }
      if (pre.length) msgs.push({ role: 'user', content: pre.join('\n\n') });
      msgs.push({ role: 'user', content: userText || '' });
      return msgs;
    },

    // 写操作分级判定（设计 §6）：destructive → 'destructive'；小改（chars≤500 且非整块）→ 'auto'；其余 → 'preview'
    classifyWrite: function (impact) {
      impact = impact || {};
      if (impact.destructive) return 'destructive';
      var chars = impact.chars || 0;
      if (chars <= 500 && !impact.wholeBlock) return 'auto';
      return 'preview';
    },

    // ===== Task 8: applyAgentWrite + 会话内撤销记录 =====
    // 本模块不做实际 DOM 写入：applyAgentWrite 仅分级 + 记录到会话日志（供 UI 渲染与撤销），
    // 返回 {block, before, after, level, impact} 让 UI（Task 15/16）决定自动落盘/预览/确认——
    // 写入由 UI 调 deps.commit(block, after) 完成（pushHistory + setText/setBlockText）。
    sessionWrites: [],
    applyAgentWrite: function (w, deps, log) {
      var level = Agent.classifyWrite(w.impact || {});
      var rec = { block: w.block, before: w.before !== undefined ? w.before : null, after: w.resultText, level: level, impact: w.impact || {} };
      Agent.sessionWrites.unshift(rec);
      if (Agent.sessionWrites.length > 50) Agent.sessionWrites.pop();
      if (log && typeof log.push === 'function') log.push(rec);
      return rec;
    },
    undoWrite: function (commitDeps) {
      var rec = Agent.sessionWrites.shift();
      if (!rec) return null;
      if (commitDeps && commitDeps.commit && rec.before !== null) commitDeps.commit(rec.block, rec.before);
      return rec;
    },
  };

  // ===== Task 7: 文档编辑工具纯函数 =====
  // 工具不碰 DOM/localStorage，所有外部依赖经 toolsDeps 由 UI/runLoop 运行时注入
  Agent.toolsDeps = {
    getActiveBlock: null,   // () => {name, text}
    listBlocks: null,       // () => [names]
    getBlockText: null,     // (name) => text|null
    fullText: null,         // () => 全文
    settings: null,         // () => 创作设定文本
    getVars: null, saveVars: null,
    blocksDoc: null,       // () => {块名: 文本}（块对象视图，结构组 rename/delete 同步引用用）
    saveBlocks: null,      // ({块名: 文本}) => void（结构组落盘）
    extractClues: null,          // (opts) => {ok, clues|text}（创作辅助：线索提取，UI 接 window.AI.extractClues）
    applyGeneratedBlocks: null,  // ([lines]) => {ok}（创作辅助：生成块写入，UI 接 window.StoryEditorApi.applyGeneratedBlocks）
    // ...素材组后续加
  };

  // 文本操作核心（纯函数）：findAnchor（行号/文本锚定，精确优先、模糊回退）+ applyInsert + computeImpact
  // 注（Task 7 实现时修正的计划代码缺陷）：before/after 语义为「在锚点行前/后插入一整行」——
  // 因此 findAnchor 的 end 一律为锚点内容的末尾（不含行尾换行），并返回锚点所在行号 lineNo；
  // applyInsert 的 before/after 按行拼接（split/splice/join），replace 仍按字符区间精确替换。
  // 模糊回退归一化（镜像 editor.js normText）：去所有空白（含全角空格）+ 全角标点→半角
  function normText(s) {
    if (!s) return '';
    return String(s)
      .replace(/[　\s]+/g, '')
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  }
  function findAnchor(text, anchor, anchorType) {
    if (anchorType === 'line') {
      var lines = text.split('\n');
      var idx = (typeof anchor === 'number' ? anchor : parseInt(anchor, 10)) - 1;
      if (isNaN(idx) || idx < 0 || idx >= lines.length) return { error: '行号超出范围（共 ' + lines.length + ' 行）' };
      var start = 0;
      for (var i = 0; i < idx; i++) { start += lines[i].length + 1; }
      var end = start + lines[idx].length;
      return { start: start, end: end, line: lines[idx], lineNo: idx + 1 };
    }
    var q = String(anchor);
    var idxExact = text.indexOf(q);
    if (idxExact >= 0) {
      return { start: idxExact, end: idxExact + q.length, lineNo: text.slice(0, idxExact).split('\n').length };
    }
    // 模糊回退：归一化后包含匹配（取首个），再按「非空白字符序号」映射回原文本偏移
    // （计划字面实现的贪心匹配从文本头重匹配 qTrim，假起点会吞掉真匹配前导字符 → 静默损坏文本；
    //   正确做法：起点 = 原文本第 pos+1 个非空白字符，终点 = 再消费 qNorm.length 个非空白字符）
    var qNorm = normText(q);
    var tNorm = normText(text);
    var pos = qNorm ? tNorm.indexOf(qNorm) : -1;
    if (pos >= 0) {
      var s = 0, cnt = 0;
      while (s < text.length && cnt <= pos) {
        if (!/\s/.test(text[s])) {
          if (cnt === pos) break;
          cnt++;
        }
        s++;
      }
      var e = s, consumed = 0;
      while (e < text.length && consumed < qNorm.length) {
        if (!/\s/.test(text[e])) consumed++;
        e++;
      }
      return { start: s, end: e, lineNo: text.slice(0, s).split('\n').length, fuzzy: true };
    }
    return { error: '未找到锚点「' + q.slice(0, 40) + '」' };
  }

  function applyInsert(text, pos, ins, mode) {
    if (mode === 'replace') return text.slice(0, pos.start) + ins + text.slice(pos.end);
    // before/after：在锚点所在行（lineNo，1 起）之前/之后插入一整行
    var lines = text.split('\n');
    if (mode === 'after') lines.splice(pos.lineNo, 0, ins);
    else lines.splice(pos.lineNo - 1, 0, ins); // before 默认
    return lines.join('\n');
  }

  // impact.chars 为「变更量」= |编辑后总长 − 编辑前总长|（设计 §6：小改判定按改动幅度，
  // 而非块总长——否则任何 ≥500 字的块编辑都会误入 preview，'小改自动落盘'失效）
  function computeImpact(blockName, resultText, wholeBlock, beforeText) {
    var lines = resultText.split('\n').length;
    var delta = Math.abs(resultText.length - (beforeText ? beforeText.length : 0));
    return { chars: delta, lines: lines, wholeBlock: !!wholeBlock, block: blockName };
  }

  // ===== Task 9: 变量工具辅助 =====
  // 变量格式 {name, type:'number'|'text'|'boolean', value}（storage.js:602）；
  // 命名规则同 editor.js:2886：字母/数字/下划线/中文，不得数字开头。
  function validVarName(name) {
    // 空值守卫：String(undefined)='undefined' 会命中正则，必须显式拒绝（防 LLM 漏传 name 落垃圾条目）
    if (typeof name !== 'string' || !name) return false;
    return /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*$/.test(name);
  }
  function getVarsArr() {
    return Agent.toolsDeps.getVars ? Agent.toolsDeps.getVars() : [];
  }

  // 结构组辅助：获取块对象视图 {块名: 文本}。
  // 优先用 toolsDeps.blocksDoc；缺省时回退 listBlocks+getBlockText 重建（结构组工具都经此拿当前块全量）。
  function blocksDocObj() {
    if (Agent.toolsDeps.blocksDoc) return Agent.toolsDeps.blocksDoc();
    var out = {};
    var names = Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : [];
    for (var i = 0; i < names.length; i++) {
      var t = Agent.toolsDeps.getBlockText ? Agent.toolsDeps.getBlockText(names[i]) : '';
      out[names[i]] = t == null ? '' : t;
    }
    return out;
  }

  var tools = {
    get_current_block: function () {
      if (!Agent.toolsDeps.getActiveBlock) return { error: '编辑器未就绪' };
      var b = Agent.toolsDeps.getActiveBlock();
      return { blockName: b.name, text: b.text };
    },
    list_blocks: function () {
      return Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : [];
    },
    read_block: function (a) {
      var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
      if (t === null || t === undefined) {
        var names = (Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : []).join('、');
        return { error: '未找到剧情块「' + a.blockName + '」，可用块：' + names };
      }
      return { blockName: a.blockName, text: t };
    },
    search_in_doc: function (a) {
      var q = String(a.query || '');
      if (!q) return { error: 'query 不能为空' };
      var out = [];
      var names = Agent.toolsDeps.listBlocks ? Agent.toolsDeps.listBlocks() : [];
      for (var i = 0; i < names.length && out.length < 20; i++) {
        var t = Agent.toolsDeps.getBlockText ? Agent.toolsDeps.getBlockText(names[i]) : null;
        if (!t) continue;
        var lines = t.split('\n');
        for (var j = 0; j < lines.length && out.length < 20; j++) {
          if (lines[j].indexOf(q) >= 0) out.push({ block: names[i], lineNo: j + 1, snippet: lines[j] });
        }
      }
      return out;
    },
    read_full_text: function () {
      var t = Agent.toolsDeps.fullText ? Agent.toolsDeps.fullText() : '';
      if (t.length > 50000) return { error: '全文过长（' + t.length + ' 字符），建议用 read_block 按块读取' };
      return { text: t };
    },
    read_settings: function () {
      return { settings: Agent.toolsDeps.settings ? Agent.toolsDeps.settings() : '' };
    },
    append_to_block: function (a) {
      if (!a.blockName || a.text === undefined) return { error: '缺少 blockName 或 text' };
      var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
      if (t === null || t === undefined) return { error: '未找到剧情块「' + a.blockName + '」' };
      var result = t + (t && !t.endsWith('\n') && !String(a.text).startsWith('\n') ? '\n' : '') + String(a.text);
      return { ok: true, block: a.blockName, resultText: result, impact: computeImpact(a.blockName, result, false, t) };
    },
    insert_at: function (a) {
      if (!a.blockName || a.anchor === undefined || a.text === undefined) return { error: '缺少 blockName/anchor/text' };
      var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
      if (t === null || t === undefined) return { error: '未找到剧情块「' + a.blockName + '」' };
      var mode = a.mode || 'before';
      if (mode !== 'before' && mode !== 'after' && mode !== 'replace') return { error: 'mode 无效：' + mode + '（应为 before/after/replace）' };
      var pos = findAnchor(t, a.anchor, a.anchorType || 'text');
      if (pos.error) return { error: pos.error };
      var result = applyInsert(t, pos, String(a.text), mode);
      // 整块替换必须标记 wholeBlock → 走预览确认（设计 §6）
      var wholeBlock = (mode === 'replace' && pos.start === 0 && pos.end === t.length);
      return { ok: true, block: a.blockName, resultText: result, impact: computeImpact(a.blockName, result, wholeBlock, t) };
    },
    apply_review_marker: function (a) {
      // 占位：复用审阅标记管线（Task 10 关联创作辅助时接通 editor 侧 applyGeneratedBlocks/审阅写入）
      return { error: 'apply_review_marker 待 UI 接线' };
    },
    // ===== Task 9: 变量工具（直接读写 master 现有格式，经 toolsDeps.getVars/saveVars 注入） =====
    // 直接变更注入的变量数组；destructive 仅 delete_var 标记（变量写入不走 sessionWrites 撤销）
    list_vars: function () {
      return getVarsArr().slice();
    },
    read_var: function (a) {
      var name = a && a.name;
      var arr = getVarsArr();
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === name) return { name: arr[i].name, type: arr[i].type, value: arr[i].value };
      }
      return { error: '未找到变量「' + name + '」' };
    },
    create_var: function (a) {
      var name = a && a.name;
      if (!validVarName(name)) return { error: '变量名只能 字母/数字/下划线/中文 且不能数字开头' };
      var type = (a && a.type === 'text') || (a && a.type === 'boolean') ? a.type : 'number';
      var arr = getVarsArr();
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === name) return { error: '已存在同名变量「' + name + '」' };
      }
      var value = a && a.value !== undefined ? a.value : (type === 'number' ? 0 : type === 'boolean' ? false : '');
      if (type === 'number') {
        value = Number(value);
        if (isNaN(value)) return { error: '初始值必须是数值' };
      } else if (type === 'boolean') {
        value = (value === true || value === 'true' || value === 1 || value === '1');
      } else {
        value = String(value);
      }
      var created = { name: name, type: type, value: value };
      var next = arr.slice();
      next.push(created);
      if (!Agent.toolsDeps.saveVars) return { error: '编辑器未就绪' };
      Agent.toolsDeps.saveVars(next);
      return { ok: true, name: created.name, type: created.type, value: created.value };
    },
    delete_var: function (a) {
      var name = a && a.name;
      var arr = getVarsArr();
      var found = -1;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === name) { found = i; break; }
      }
      if (found < 0) return { error: '未找到变量「' + name + '」' };
      var next = arr.slice();
      next.splice(found, 1);
      if (!Agent.toolsDeps.saveVars) return { error: '编辑器未就绪' };
      Agent.toolsDeps.saveVars(next);
      return { ok: true, name: name, destructive: true };
    },
    set_var: function (a) {
      var name = a && a.name;
      var arr = getVarsArr();
      var v = null;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === name) { v = arr[i]; break; }
      }
      if (!v) return { error: '未找到变量「' + name + '」' };
      var val = a && a.value;
      if (v.type === 'number') {
        // 先算后验：失败路径不得把 NaN 写进变量库（否则后续 update_var 会带着 NaN 继续）
        var n = Number(val);
        if (isNaN(n)) return { error: 'number 类型变量必须赋数值' };
        v.value = n;
      } else if (v.type === 'boolean') {
        v.value = (val === true || val === 'true' || val === 1 || val === '1');
      } else {
        v.value = String(val);
      }
      if (!Agent.toolsDeps.saveVars) return { error: '编辑器未就绪' };
      Agent.toolsDeps.saveVars(arr);
      return { ok: true, name: v.name, value: v.value };
    },
    update_var: function (a) {
      var name = a && a.name;
      var arr = getVarsArr();
      var v = null;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === name) { v = arr[i]; break; }
      }
      if (!v) return { error: '未找到变量「' + name + '」' };
      if (v.type !== 'number') return { error: '只有 number 类型支持加减' };
      var d = Number(a && a.delta);
      if (isNaN(d)) return { error: 'delta 必须是数值' };
      v.value = (a && a.op === '-') ? v.value - d : v.value + d;
      if (!Agent.toolsDeps.saveVars) return { error: '编辑器未就绪' };
      Agent.toolsDeps.saveVars(arr);
      return { ok: true, name: v.name, value: v.value };
    },
    // ===== Task 10: 结构组工具（create/rename/delete 剧情块） =====
    // 块名规则同 storage.js:288（只允许 中文/字母/数字/下划线）——
    // 该字符集不含正则元字符，块名插值进 RegExp 是安全的，无需转义。
    // 删除语义（按计划）：delete_block 只报告引用 + 标记 destructive，
    // 真正的删块由 runLoop（Task 13）在用户确认后执行，本工具不落盘。
    create_block: function (a) {
      var name = String(a && a.blockName || '').trim();
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(name)) return { error: '块名只允许 中文/字母/数字/下划线' };
      if (Agent.toolsDeps.mainBlock && name === Agent.toolsDeps.mainBlock) return { error: '不能创建与主剧情同名的块' };
      if (typeof Agent.toolsDeps.saveBlocks !== 'function') return { error: '编辑器未就绪' };
      var doc = blocksDocObj();
      if (name in doc) return { error: '已存在同名剧情块「' + name + '」' };
      var next = {};
      for (var k in doc) {
        if (Object.prototype.hasOwnProperty.call(doc, k)) next[k] = doc[k];
      }
      next[name] = '';
      Agent.toolsDeps.saveBlocks(next);
      return { ok: true, blockName: name };
    },
    rename_block: function (a) {
      var oldN = String(a && a.oldName || '').trim();
      var newN = String(a && a.newName || '').trim();
      if (typeof Agent.toolsDeps.saveBlocks !== 'function') return { error: '编辑器未就绪' };
      var doc = blocksDocObj();
      if (Agent.toolsDeps.mainBlock && oldN === Agent.toolsDeps.mainBlock) return { error: '主剧情块不可改名' };
      if (Agent.toolsDeps.mainBlock && newN === Agent.toolsDeps.mainBlock) return { error: '不能改名为主剧情' };
      if (!(oldN in doc)) return { error: '未找到剧情块「' + oldN + '」' };
      // newN 必须与 create_block 同规则校验：空串会建空键块，$&/$`/$' 等会污染替换串（审查加固）
      if (!/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(newN)) return { error: '块名只允许 中文/字母/数字/下划线' };
      if (newN in doc) return { error: '已存在同名剧情块「' + newN + '」' };
      // 旧名转义（repo 惯例 storage.js:564）：块名虽无正则元字符，但旧键可能来自手工编辑/历史数据
      var escOld = oldN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 同步三类引用：<<剧情块:旧名>> 分块标记、<选项:"…",旧名…> 跳转目标（含条件行）、
      // 单括号运行期跳转 <剧情块:旧名> / <对话块:旧名>（storage.js:568 同源，防止改名后运行期悬空引用）
      var reTag = new RegExp('<<剧情块:' + escOld + '>>', 'g');
      var reOpt = new RegExp('(<选项:"[^"]*",\\s*)' + escOld + '(?=\\s*(,|>))', 'g');
      var reJump = new RegExp('<(?:对话块|剧情块):\\s*' + escOld + '\\s*>', 'g');
      var next = {};
      for (var k in doc) {
        if (Object.prototype.hasOwnProperty.call(doc, k)) next[k] = doc[k];
      }
      next[newN] = next[oldN];
      delete next[oldN];
      // 遍历全部块（含改名块自身：其自引用旧名也会悬空，须一并同步），计数实际变更的块
      var changed = 0;
      for (var b in next) {
        if (!Object.prototype.hasOwnProperty.call(next, b)) continue;
        var t = String(next[b] == null ? '' : next[b]);
        var t2 = t.replace(reJump, '<剧情块:' + newN + '>').replace(reTag, '<<剧情块:' + newN + '>>').replace(reOpt, '$1' + newN);
        if (t2 !== t) { next[b] = t2; changed++; }
      }
      Agent.toolsDeps.saveBlocks(next);
      return { ok: true, oldName: oldN, newName: newN, blocksUpdated: changed };
    },
    delete_block: function (a) {
      var name = String(a && a.blockName || '').trim();
      if (typeof Agent.toolsDeps.blocksDoc !== 'function' && typeof Agent.toolsDeps.listBlocks !== 'function') return { error: '编辑器未就绪' };
      var doc = blocksDocObj();
      if (Agent.toolsDeps.mainBlock && name === Agent.toolsDeps.mainBlock) return { error: '主剧情块不可删除' };
      if (!(name in doc)) return { error: '未找到剧情块「' + name + '」' };
      // 只扫其他块的跳转引用：选项 <选项:"…",旧名…> 与单括号 <剧情块:旧名>/<对话块:旧名>；
      // 无 g 标志 → .test() 无 lastIndex 陷阱；引用数上限 20 防超长回报（同 search_in_doc）
      var escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp('<选项:"[^"]*",\\s*' + escName + '(?=\\s*(,|>))');
      var reJump = new RegExp('<(?:对话块|剧情块):\\s*' + escName + '\\s*>');
      var refs = [];
      for (var k in doc) {
        if (!Object.prototype.hasOwnProperty.call(doc, k)) continue;
        if (k === name) continue;
        var lines = String(doc[k] == null ? '' : doc[k]).split('\n');
        for (var i = 0; i < lines.length && refs.length < 20; i++) {
          if (re.test(lines[i]) || reJump.test(lines[i])) refs.push({ block: k, lineNo: i + 1, snippet: lines[i].slice(0, 60) });
        }
      }
      return { ok: true, blockName: name, destructive: true, references: refs };
    },
    // ===== Task 11: 创作辅助组工具（extract_clues / generate_options） =====
    // 只调 toolsDeps + 校验结果/语法，不直接碰 AI 或文档（UI 接线：extractClues→window.AI.extractClues，
    // applyGeneratedBlocks→window.StoryEditorApi.applyGeneratedBlocks）。
    extract_clues: function (a) {
      if (!Agent.toolsDeps.extractClues) return { error: '线索提取管线未接线' };
      try {
        var r = Agent.toolsDeps.extractClues(a && a.blockName ? { blockName: a.blockName } : {});
        return r && r.ok ? { ok: true, clues: r.clues || r.text || '' } : { error: (r && r.error) || '提取失败' };
      } catch (e) {
        return { error: '提取异常：' + e.message };
      }
    },
    generate_options: function (a) {
      if (!a || !a.text) return { error: '缺少 text' };
      var lines = String(a.text).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var ok = [], bad = [];
      for (var i = 0; i < lines.length; i++) {
        // 块名段 [^>]+ 贪心后回溯：条件段可含任意字符（如 金币>5），行尾 > 为闭合符
        if (/^<选项:"[^"]*",\s*[^>]+(?:,\s*条件:[\s\S]*)?>$/.test(lines[i])) ok.push(lines[i]);
        else bad.push(lines[i]);
      }
      if (!ok.length) return { error: '没有合法的 <选项:"文字",块名[,条件:…]> 行' };
      if (typeof Agent.toolsDeps.applyGeneratedBlocks !== 'function') return { error: '编辑器未就绪' };
      Agent.toolsDeps.applyGeneratedBlocks(ok);
      return { ok: true, count: ok.length, invalid: bad.length };
    },
  };
  Agent.tools = tools;
  // 暴露 textOps 纯函数（供测试直测 & 后续 applyAgentWrite 复用）
  Agent.textOps = { normText: normText, findAnchor: findAnchor, applyInsert: applyInsert, computeImpact: computeImpact };

  if (typeof module !== 'undefined' && module.exports) module.exports = Agent;
  if (typeof window !== 'undefined') window.Agent = Agent;
  // vm 测试沙箱（Node 无 window / module）下挂到 globalThis，供 runInContext 提取场景表
  if (typeof window === 'undefined' && typeof module === 'undefined' && typeof globalThis !== 'undefined') globalThis.Agent = Agent;
})();
