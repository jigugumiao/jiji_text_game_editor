// js/story-visual-doc.js — 可视化剧情编辑器的无损源码文档模型
(function () {
  'use strict';

  function dependency(name, path) {
    if (typeof window !== 'undefined' && window[name]) return window[name];
    if (typeof require === 'function') {
      try { return require(path); } catch (_) { return null; }
    }
    return null;
  }

  function splitLines(source) {
    var lines = [], re = /\r\n|\n|\r/g, start = 0, match;
    while ((match = re.exec(source)) !== null) {
      lines.push({ start: start, end: match.index, separatorEnd: re.lastIndex });
      start = re.lastIndex;
    }
    if (start < source.length || source.length === 0) lines.push({ start: start, end: source.length, separatorEnd: source.length });
    return lines;
  }

  function scan(source) {
    var text = String(source == null ? '' : source);
    var StoryOptions = dependency('StoryOptions', './story-options.js');
    var StoryVars = dependency('StoryVars', './story-vars.js');
    var nodes = [], plainStart = -1, plainEnd = -1;

    function push(kind, start, end, data, diagnostics) {
      if (start === end) return;
      if (kind === 'text') {
        if (plainStart < 0) plainStart = start;
        plainEnd = end;
        return;
      }
      flushPlain();
      nodes.push({ kind: kind, start: start, end: end, raw: text.slice(start, end), data: data || {}, diagnostics: diagnostics || [] });
    }
    function flushPlain() {
      if (plainStart >= 0) {
        nodes.push({ kind: 'text', start: plainStart, end: plainEnd, raw: text.slice(plainStart, plainEnd), data: {}, diagnostics: [] });
        plainStart = -1;
        plainEnd = -1;
      }
    }
    function isStandaloneState(line) {
      var trimmed = line.trim();
      if (!trimmed || !StoryVars) return null;
      var parsed = StoryVars.parseVarLine(trimmed);
      if (parsed.ops.length && parsed.bad.length === 0) return { effects: parsed.ops };
      var input = StoryVars.parsePlayerInput(trimmed);
      return input ? { playerInput: input, effects: [] } : null;
    }
    function appendGeneric(start, end) {
      var cursor = start, re = /<[^\r\n<>]+>/g, fragment = text.slice(start, end), match;
      while ((match = re.exec(fragment)) !== null) {
        var tagStart = start + match.index, tagEnd = tagStart + match[0].length;
        if (tagStart > cursor) push('text', cursor, tagStart);
        push('raw_command', tagStart, tagEnd, { command: match[0] });
        cursor = tagEnd;
      }
      if (cursor < end) push('text', cursor, end);
    }

    splitLines(text).forEach(function (line) {
      var rawLine = text.slice(line.start, line.end);
      var state = isStandaloneState(rawLine);
      if (state) {
        push('state_change', line.start, line.end, state);
      } else {
        var matches = StoryOptions && StoryOptions.extractOptionLine ? StoryOptions.extractOptionLine(rawLine) : [];
        if (matches.length) {
          var cursor = line.start;
          matches.forEach(function (match) {
            var start = line.start + match.start, end = line.start + match.end;
            if (cursor < start) appendGeneric(cursor, start);
            if (match.ok) {
              push('option_group', start, end, { option: match.option, options: [match.option] });
            } else {
              push('source_error', start, end, {}, [{ kind: 'malformed_option', severity: 'error', message: match.error || '无法识别的选项指令' }]);
            }
            cursor = end;
          });
          if (cursor < line.end) appendGeneric(cursor, line.end);
        } else {
          appendGeneric(line.start, line.end);
        }
      }
      if (line.separatorEnd > line.end) push('text', line.end, line.separatorEnd);
    });
    flushPlain();
    return { source: text, nodes: nodes };
  }

  function serializeUnchanged(doc) {
    if (!doc || typeof doc.source !== 'string') throw new TypeError('Visual document must include its source');
    return doc.source;
  }

  function replaceNode(source, node, replacement) {
    var text = String(source == null ? '' : source);
    if (!node || typeof node.start !== 'number' || typeof node.end !== 'number'
      || text.slice(node.start, node.end) !== node.raw) {
      throw new Error('Node span does not match its raw source');
    }
    return text.slice(0, node.start) + String(replacement == null ? '' : replacement) + text.slice(node.end);
  }

  // Standalone visual directives own their line.  This keeps an emptied state
  // change from turning into an unexplained blank line when its final effect is
  // removed by the visual editor.
  function removeNode(source, node) {
    var text = String(source == null ? '' : source);
    if (!node || typeof node.start !== 'number' || typeof node.end !== 'number'
      || text.slice(node.start, node.end) !== node.raw) {
      throw new Error('Node span does not match its raw source');
    }
    var lineStart = Math.max(text.lastIndexOf('\n', node.start - 1), text.lastIndexOf('\r', node.start - 1)) + 1;
    var nextBreak = /\r\n|\n|\r/.exec(text.slice(node.end));
    var lineEnd = nextBreak ? node.end + nextBreak.index : text.length;
    if (node.start !== lineStart || node.end !== lineEnd) return replaceNode(text, node, '');
    if (nextBreak && nextBreak.index === 0) return text.slice(0, node.start) + text.slice(node.end + nextBreak[0].length);
    if (node.start > 0) {
      var previousStart = node.start - (text.charAt(node.start - 1) === '\n' && text.charAt(node.start - 2) === '\r' ? 2 : 1);
      return text.slice(0, previousStart) + text.slice(node.end);
    }
    return text.slice(node.end);
  }

  function findNodeAtOffset(doc, offset) {
    if (!doc || !Array.isArray(doc.nodes) || typeof offset !== 'number') return null;
    for (var i = 0; i < doc.nodes.length; i++) {
      var node = doc.nodes[i];
      if (offset >= node.start && offset < node.end) return node;
    }
    return null;
  }

  function summarizeDiagnostics(docOrNodes) {
    var nodes = Array.isArray(docOrNodes) ? docOrNodes : (docOrNodes && docOrNodes.nodes) || [];
    var diagnostics = [];
    nodes.forEach(function (node) {
      (node.diagnostics || []).forEach(function (diagnostic) {
        diagnostics.push({ kind: diagnostic.kind, severity: diagnostic.severity, message: diagnostic.message, start: node.start, end: node.end, node: node });
      });
    });
    return diagnostics;
  }

  // Project-wide state usage is kept here instead of in the editor so callers
  // can safely preview destructive library operations before touching storage.
  function buildStateReferenceIndex(blockMap, states) {
    var StoryVars = dependency('StoryVars', './story-vars.js');
    var StoryOptions = dependency('StoryOptions', './story-options.js');
    var references = [], byName = {}, seen = {}, duplicates = [];
    (states || []).forEach(function (state) {
      var name = state && String(state.name == null ? '' : state.name).trim();
      if (!name) return;
      if (seen[name] && duplicates.indexOf(name) < 0) duplicates.push(name);
      seen[name] = true;
    });
    function add(name, kind, block, line, extra) {
      if (!name) return;
      var ref = { name: name, kind: kind, block: block, line: line };
      if (extra) Object.keys(extra).forEach(function (key) { ref[key] = extra[key]; });
      references.push(ref);
      if (!byName[name]) byName[name] = [];
      byName[name].push(ref);
    }
    function addConditionRefs(expr, block, line) {
      if (!StoryVars || !StoryVars.parseCondition) return;
      var ast = StoryVars.parseCondition(expr);
      function walk(node) {
        if (!node) return;
        if (node.k === 'bare') add(node.name, 'condition', block, line, { requiredType: 'boolean' });
        else if (node.k === 'cmp') {
          var required = null;
          if (node.op === '>' || node.op === '<' || node.op === '>=' || node.op === '<=') required = 'number';
          if (node.op === 'contains' || node.op === 'notcontains') required = 'text';
          add(node.name, 'condition', block, line, { requiredType: required });
        }
        if (node.l) walk(node.l);
        if (node.r) walk(node.r);
        if (node.e) walk(node.e);
      }
      walk(ast);
    }
    Object.keys(blockMap || {}).forEach(function (block) {
      String(blockMap[block] == null ? '' : blockMap[block]).split(/\r\n|\n|\r/).forEach(function (raw, i) {
        var line = i + 1, trimmed = raw.trim();
        if (!trimmed || /^\s*\/\//.test(raw)) return;
        var parsed = StoryVars && StoryVars.parseVarLine ? StoryVars.parseVarLine(trimmed) : { ops: [], bad: [] };
        if (parsed.ops.length && parsed.bad.length === 0) {
          parsed.ops.forEach(function (op) {
            add(op.name, 'change', block, line, { op: op.op, requiredType: (op.op === '+' || op.op === '-') ? 'number' : null });
          });
          return;
        }
        var playerInput = StoryVars && StoryVars.parsePlayerInput ? StoryVars.parsePlayerInput(trimmed) : null;
        if (playerInput) {
          add(playerInput.name, 'player_input', block, line, { requiredType: 'text' });
          return;
        }
        if (StoryOptions && StoryOptions.extractOptionLine) {
          StoryOptions.extractOptionLine(raw).forEach(function (match) {
            if (!match.ok || !match.option) return;
            if (match.option.condition) addConditionRefs(match.option.condition, block, line);
            (match.option.effects || []).forEach(function (effect) {
              add(effect.name, 'effect', block, line, { op: effect.op, requiredType: (effect.op === '+' || effect.op === '-') ? 'number' : null });
            });
          });
        }
        if (StoryVars && StoryVars.extractRefs) {
          StoryVars.extractRefs(raw).forEach(function (ref) {
            add(ref.name, 'read', block, line, { requiredType: ref.disp ? 'boolean' : null });
          });
        }
      });
    });
    return { references: references, byName: byName, duplicates: duplicates };
  }

  function findIncompatibleStateReferences(index, name, nextType) {
    var refs = index && index.byName && index.byName[name] ? index.byName[name] : [];
    return refs.filter(function (ref) { return ref.requiredType && ref.requiredType !== nextType; });
  }

  var VisualDoc = {
    scan: scan,
    serializeUnchanged: serializeUnchanged,
    replaceNode: replaceNode,
    removeNode: removeNode,
    findNodeAtOffset: findNodeAtOffset,
    summarizeDiagnostics: summarizeDiagnostics,
    buildStateReferenceIndex: buildStateReferenceIndex,
    findIncompatibleStateReferences: findIncompatibleStateReferences
  };
  if (typeof window !== 'undefined') window.StoryVisualDoc = VisualDoc;
  if (typeof module !== 'undefined' && module.exports) module.exports = VisualDoc;
})();
