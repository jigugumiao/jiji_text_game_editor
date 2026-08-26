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

  var VisualDoc = {
    scan: scan,
    serializeUnchanged: serializeUnchanged,
    replaceNode: replaceNode,
    findNodeAtOffset: findNodeAtOffset,
    summarizeDiagnostics: summarizeDiagnostics
  };
  if (typeof window !== 'undefined') window.StoryVisualDoc = VisualDoc;
  if (typeof module !== 'undefined' && module.exports) module.exports = VisualDoc;
})();
