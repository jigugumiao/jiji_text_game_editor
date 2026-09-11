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
    // ...结构/素材组后续加
  };

  // 文本操作核心（纯函数）：findAnchor（行号/文本锚定，精确优先、模糊回退）+ applyInsert + computeImpact
  // 注（Task 7 实现时修正的计划代码缺陷）：before/after 语义为「在锚点行前/后插入一整行」——
  // 因此 findAnchor 的 end 一律为锚点内容的末尾（不含行尾换行），并返回锚点所在行号 lineNo；
  // applyInsert 的 before/after 按行拼接（split/splice/join），replace 仍按字符区间精确替换。
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
    // 模糊回退：去空白后包含匹配（取首个）
    var qTrim = q.replace(/\s+/g, '');
    var tTrim = text.replace(/\s+/g, '');
    var pos = tTrim.indexOf(qTrim);
    if (pos >= 0) {
      // 把压缩串里的偏移映射回原文本偏移：逐步累加原字符，跳过空白
      var cursor = 0, mapped = 0;
      while (cursor < qTrim.length) {
        while (text[mapped] && /\s/.test(text[mapped])) mapped++;
        if (text[mapped] !== qTrim[cursor]) { mapped++; continue; }
        cursor++; mapped++;
      }
      var s = mapped - qTrim.length;
      return { start: s, end: mapped, lineNo: text.slice(0, s).split('\n').length, fuzzy: true };
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

  function computeImpact(blockName, resultText, wholeBlock) {
    var lines = resultText.split('\n').length;
    return { chars: resultText.length, lines: lines, wholeBlock: !!wholeBlock, block: blockName };
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
        var t = Agent.toolsDeps.getBlockText(names[i]);
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
      return { ok: true, block: a.blockName, resultText: result, impact: computeImpact(a.blockName, result, false) };
    },
    insert_at: function (a) {
      if (!a.blockName || a.anchor === undefined || a.text === undefined) return { error: '缺少 blockName/anchor/text' };
      var t = Agent.toolsDeps.getBlockText && Agent.toolsDeps.getBlockText(a.blockName);
      if (t === null || t === undefined) return { error: '未找到剧情块「' + a.blockName + '」' };
      var mode = a.mode || 'before';
      var pos = findAnchor(t, a.anchor, a.anchorType || 'text');
      if (pos.error) return { error: pos.error };
      var result = applyInsert(t, pos, String(a.text), mode);
      return { ok: true, block: a.blockName, resultText: result, impact: computeImpact(a.blockName, result, false) };
    },
    apply_review_marker: function (a) {
      // 占位：复用审阅标记管线（Task 10 关联创作辅助时接通 editor 侧 applyGeneratedBlocks/审阅写入）
      return { error: 'apply_review_marker 待 UI 接线' };
    },
  };
  Agent.tools = tools;

  if (typeof module !== 'undefined' && module.exports) module.exports = Agent;
  if (typeof window !== 'undefined') window.Agent = Agent;
  // vm 测试沙箱（Node 无 window / module）下挂到 globalThis，供 runInContext 提取场景表
  if (typeof window === 'undefined' && typeof module === 'undefined' && typeof globalThis !== 'undefined') globalThis.Agent = Agent;
})();
