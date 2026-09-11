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
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Agent;
  if (typeof window !== 'undefined') window.Agent = Agent;
  // vm 测试沙箱（Node 无 window / module）下挂到 globalThis，供 runInContext 提取场景表
  if (typeof window === 'undefined' && typeof module === 'undefined' && typeof globalThis !== 'undefined') globalThis.Agent = Agent;
})();
