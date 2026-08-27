// js/story-options.js — 可视化选项的单一语法源
(function () {
  'use strict';

  var OPTIONAL_PREFIXES = ['条件:', '不满足:', '提示:', '变化:', '条件变化:'];

  function splitTopLevelFields(source) {
    var text = String(source == null ? '' : source);
    var fields = [], start = 0, depth = 0, quote = null, escaped = false;
    var pairs = { '“': '”', '‘': '’', '「': '」', '『': '』' };
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"') { quote = '"'; continue; }
      if (pairs[ch]) { quote = pairs[ch]; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')' && depth > 0) { depth--; continue; }
      if (ch === ',' && depth === 0) {
        fields.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    fields.push(text.slice(start).trim());
    return fields;
  }

  function unescapeString(value) {
    return value.replace(/\\([\\"nrt])/g, function (_, ch) {
      return ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch;
    });
  }

  function readString(field) {
    var s = String(field == null ? '' : field).trim();
    var last = s.charAt(s.length - 1);
    var pairs = { '"': '"', '“': '”', '‘': '’', '「': '」', '『': '』' };
    if (s.length < 2 || !pairs[s.charAt(0)] || pairs[s.charAt(0)] !== last) return null;
    return unescapeString(s.slice(1, -1));
  }

  function escapeString(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  }

  function isOptional(field) {
    for (var i = 0; i < OPTIONAL_PREFIXES.length; i++) {
      if (field.indexOf(OPTIONAL_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function getStoryVars() {
    var SV = typeof window !== 'undefined' ? window.StoryVars : null;
    if (!SV && typeof require === 'function') {
      try { SV = require('./story-vars.js'); } catch (_) { SV = null; }
    }
    return SV;
  }

  function parseEffect(value) {
    var SV = getStoryVars();
    if (!SV || typeof SV.parseVarLine !== 'function') return null;
    var parsed = SV.parseVarLine('<变量:' + value + '>');
    if (parsed.bad.length !== 0 || parsed.ops.length !== 1) return null;
    return { name: parsed.ops[0].name, op: parsed.ops[0].op, val: parsed.ops[0].val, condition: null };
  }

  function parseConditionalEffect(value) {
    var source = String(value == null ? '' : value).trim();
    if (source.charAt(0) !== '(') return null;
    var depth = 0, quote = null, escaped = false, close = -1;
    var pairs = { '“': '”', '‘': '’', '「': '」', '『': '』' };
    for (var i = 0; i < source.length; i++) {
      var ch = source.charAt(i);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"') { quote = '"'; continue; }
      if (pairs[ch]) { quote = pairs[ch]; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
        if (depth < 0) return null;
      }
    }
    if (close < 0 || source.slice(close + 1, close + 3) !== '=>') return null;
    var condition = source.slice(1, close).trim();
    var SV = getStoryVars();
    if (!SV || typeof SV.parseCondition !== 'function' || !SV.parseCondition(condition)) return null;
    var effect = parseEffect(source.slice(close + 3).trim());
    if (!effect) return null;
    effect.condition = condition;
    return effect;
  }

  function makeOption() {
    return { text: '', block: null, condition: null, unmetBehavior: 'hide', unmetMessage: null, effects: [], unknownFields: [] };
  }

  function parseOptionTag(raw) {
    var source = String(raw == null ? '' : raw).trim();
    if (source.slice(0, 4) !== '<选项:' || source.charAt(source.length - 1) !== '>') {
      return { ok: false, option: null, error: '选项标签格式不正确' };
    }
    var fields = splitTopLevelFields(source.slice(4, -1));
    var text = readString(fields.shift());
    if (text === null) return { ok: false, option: null, error: '选项文字必须使用引号' };
    var option = makeOption();
    option.text = text;
    if (fields.length && !isOptional(fields[0])) {
      var blockValue = readString(fields[0]);
      option.block = blockValue === null ? fields[0].trim() : blockValue;
      fields.shift();
    }
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (field.indexOf('条件变化:') === 0) {
        var conditionalEffect = parseConditionalEffect(field.slice(5));
        if (conditionalEffect) option.effects.push(conditionalEffect);
        else option.unknownFields.push(field);
      } else if (field.indexOf('条件:') === 0) option.condition = field.slice(3).trim() || null;
      else if (field.indexOf('不满足:') === 0) {
        var behavior = field.slice(4).trim();
        if (behavior === '隐藏') option.unmetBehavior = 'hide';
        else if (behavior === '禁用') option.unmetBehavior = 'disable';
        else option.unknownFields.push(field);
      } else if (field.indexOf('提示:') === 0) {
        var message = readString(field.slice(3));
        if (message === null) option.unknownFields.push(field);
        else option.unmetMessage = message;
      } else if (field.indexOf('变化:') === 0) {
        var effect = parseEffect(field.slice(3).trim());
        if (effect) option.effects.push(effect);
        else option.unknownFields.push(field);
      } else option.unknownFields.push(field);
    }
    return { ok: true, option: option, error: null };
  }

  function isConditionComparator(source, start, at) {
    var previous = source.charAt(at - 1);
    if (previous === '=' || previous === '<') return true;
    if (source.charAt(at + 1) === '=') return true;
    var following = source.charAt(at + 1);
    if (!following || following === '<' || /\s/.test(following)) return false;
    var field = splitTopLevelFields(source.slice(start + 4, at)).pop() || '';
    return field.indexOf('条件:') === 0;
  }

  function extractOptionLine(line) {
    var text = String(line == null ? '' : line), matches = [], cursor = 0;
    var quotePairs = { '“': '”', '‘': '’', '「': '」', '『': '』' };
    while (cursor < text.length) {
      var start = text.indexOf('<选项:', cursor);
      if (start < 0) break;
      var quote = null, escaped = false, depth = 0, end = -1;
      for (var i = start + 4; i < text.length; i++) {
        var ch = text.charAt(i);
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === '"') { quote = '"'; continue; }
        if (quotePairs[ch]) { quote = quotePairs[ch]; continue; }
        if (ch === '(') { depth++; continue; }
        if (ch === ')' && depth > 0) { depth--; continue; }
        if (ch === '>' && depth === 0 && !isConditionComparator(text, start, i)) { end = i + 1; break; }
      }
      if (end < 0) {
        var rawTail = text.slice(start);
        matches.push({ start: start, end: text.length, raw: rawTail, ok: false, option: null, error: '选项标签未闭合' });
        break;
      }
      var raw = text.slice(start, end), parsed = parseOptionTag(raw);
      matches.push({ start: start, end: end, raw: raw, ok: parsed.ok, option: parsed.option, error: parsed.error });
      cursor = end;
    }
    return matches;
  }

  function normalizeOption(input) {
    var source = input || {}, option = makeOption();
    option.text = String(source.text == null ? '' : source.text).trim();
    option.block = source.block == null || String(source.block).trim() === '' ? null : String(source.block).trim();
    option.condition = source.condition == null || String(source.condition).trim() === '' ? null : String(source.condition).trim();
    option.unmetBehavior = source.unmetBehavior === 'disable' ? 'disable' : 'hide';
    option.unmetMessage = source.unmetMessage != null && String(source.unmetMessage).trim() !== '' ? String(source.unmetMessage) : null;
    option.effects = Array.isArray(source.effects) ? source.effects.map(function (effect) {
      return {
        name: String(effect.name == null ? '' : effect.name).trim(), op: effect.op,
        val: String(effect.val == null ? '' : effect.val).trim(),
        condition: effect.condition == null || String(effect.condition).trim() === '' ? null : String(effect.condition).trim()
      };
    }) : [];
    option.unknownFields = Array.isArray(source.unknownFields) ? source.unknownFields.slice() : [];
    return option;
  }

  function serializeOption(input) {
    var option = normalizeOption(input);
    if (!option.text) return { ok: false, value: null, error: '选项文字不能为空' };
    var fields = ['"' + escapeString(option.text) + '"'];
    if (option.block) fields.push(option.block.indexOf(',') >= 0 || /["\\\r\n]/.test(option.block) ? '"' + escapeString(option.block) + '"' : option.block);
    if (option.condition) fields.push('条件:' + option.condition);
    if (option.unmetBehavior === 'disable') fields.push('不满足:禁用');
    if (option.unmetMessage) fields.push('提示:"' + escapeString(option.unmetMessage) + '"');
    for (var i = 0; i < option.effects.length; i++) {
      var effect = parseEffect(option.effects[i].name + option.effects[i].op + option.effects[i].val);
      if (!effect) return { ok: false, value: null, error: '变量变化格式不正确' };
      if (option.effects[i].condition) {
        var SV = getStoryVars();
        if (!SV || typeof SV.parseCondition !== 'function' || !SV.parseCondition(option.effects[i].condition)) {
          return { ok: false, value: null, error: '条件变化格式不正确' };
        }
        fields.push('条件变化:(' + option.effects[i].condition + ')=>' + effect.name + effect.op + effect.val);
      } else fields.push('变化:' + effect.name + effect.op + effect.val);
    }
    for (var j = 0; j < option.unknownFields.length; j++) fields.push(String(option.unknownFields[j]));
    return { ok: true, value: '<选项:' + fields.join(',') + '>', error: null };
  }

  function summarizeOption(input) {
    var option = normalizeOption(input), parts = [option.text || '未命名选项'];
    if (option.block) parts.push('→ ' + option.block);
    if (option.condition) parts.push('条件：' + option.condition);
    if (option.unmetBehavior === 'disable') parts.push('不满足时禁用');
    if (option.effects.length) parts.push('变化 ' + option.effects.length + ' 项');
    return parts.join(' · ');
  }

  function buildRuntimeSource() {
    var fns = [splitTopLevelFields, unescapeString, readString, escapeString, isOptional, getStoryVars, parseEffect, parseConditionalEffect, makeOption, parseOptionTag, isConditionComparator, extractOptionLine, normalizeOption, serializeOption, summarizeOption];
    var src = '(function(){\n"use strict";\nvar OPTIONAL_PREFIXES=["条件:","不满足:","提示:","变化:","条件变化:"];\nvar SO={};\n';
    fns.forEach(function (fn) { src += fn.toString() + '\nSO.' + fn.name + '=' + fn.name + ';\n'; });
    return src + 'window.StoryOptions=SO;\n})();';
  }

  var StoryOptions = {
    splitTopLevelFields: splitTopLevelFields,
    parseOptionTag: parseOptionTag,
    extractOptionLine: extractOptionLine,
    serializeOption: serializeOption,
    summarizeOption: summarizeOption,
    normalizeOption: normalizeOption
    ,buildRuntimeSource: buildRuntimeSource
  };
  if (typeof window !== 'undefined') window.StoryOptions = StoryOptions;
  if (typeof module !== 'undefined' && module.exports) module.exports = StoryOptions;
})();
