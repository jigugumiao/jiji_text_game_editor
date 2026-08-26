// js/story-visual-ui.js — 可视化剧情编辑器的轻量壳层
(function () {
  'use strict';

  function getVisualDoc() {
    if (typeof window !== 'undefined' && window.StoryVisualDoc) return window.StoryVisualDoc;
    if (typeof require === 'function') {
      try { return require('./story-visual-doc.js'); } catch (_) { return null; }
    }
    return null;
  }

  function stateTypes(states) {
    if (Array.isArray(states)) {
      return states.reduce(function (map, state) {
        if (state && state.name) map[state.name] = state.type;
        return map;
      }, {});
    }
    return states || {};
  }

  function describeStateChange(node) {
    var data = node.data || {};
    var effects = data.effects || [];
    var words = { '+': '增加', '-': '减少', '=': '设为' };
    var summary = effects.map(function (effect) {
      if (!effect || !effect.name || !words[effect.op]) return '';
      var value = String(effect.val == null ? '' : effect.val);
      if (value === 'true') value = '真';
      if (value === 'false') value = '假';
      return effect.name + words[effect.op] + (value ? ' ' + value : '');
    }).filter(Boolean).join('，');
    if (!summary && data.playerInput && data.playerInput.name) summary = '输入' + data.playerInput.name;
    return { kind: 'state_change', summary: summary, editable: true };
  }

  function describeText(node, states) {
    var source = String(node.raw == null ? '' : node.raw);
    var types = stateTypes(states);
    var parts = [], cursor = 0;
    var tokenRe = /\{\s*([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*(?::\s*([^}\s|]*)\s*\|\s*([^}]*))?\s*\}/g;
    var match;
    while ((match = tokenRe.exec(source)) !== null) {
      // {{变量}} is the established escaped literal form, not an inline token.
      if (match.index > 0 && source.charAt(match.index - 1) === '{') continue;
      if (match.index > cursor) parts.push({ kind: 'text', value: source.slice(cursor, match.index) });
      var token = { kind: 'state_token', source: match[0], name: match[1], type: types[match[1]] };
      if (match[2] !== undefined && match[3] !== undefined) {
        token.trueText = match[2];
        token.falseText = match[3];
      }
      parts.push(token);
      cursor = tokenRe.lastIndex;
    }
    if (cursor < source.length || !parts.length) parts.push({ kind: 'text', value: source.slice(cursor) });
    return { kind: 'text', editable: true, parts: parts };
  }

  // DOM-free description boundary: Node tests can verify visual language without
  // requiring a browser, and the renderer below only consumes this result.
  function describeNode(node, states) {
    if (!node) return null;
    if (node.kind === 'text') return describeText(node, states);
    if (node.kind === 'state_change') return describeStateChange(node);
    return { kind: node.kind, raw: node.raw, editable: false };
  }

  function appendTextParts(element, descriptor) {
    descriptor.parts.forEach(function (part) {
      if (part.kind === 'text') {
        element.appendChild(document.createTextNode(part.value));
        return;
      }
      var token = document.createElement('span');
      token.className = 'story-visual-state-token';
      token.contentEditable = 'false';
      token.dataset.source = part.source;
      token.dataset.name = part.name;
      token.textContent = part.source;
      element.appendChild(token);
    });
  }

  function sourceFromTextEditor(element) {
    return Array.prototype.map.call(element.childNodes, function (child) {
      return child.nodeType === 1 && child.dataset && child.dataset.source != null
        ? child.dataset.source : child.textContent;
    }).join('');
  }

  // The visual surface deliberately renders from the lossless document model.
  // It never serializes or normalizes source merely because a user changed modes.
  function renderDocument(host, doc, onDiagnostic, options) {
    if (!host || !doc) return doc;
    host.replaceChildren();
    var surface = document.createElement('div');
    surface.className = 'story-visual-document';
    surface.setAttribute('role', 'document');
    surface.setAttribute('aria-label', '可视化剧情内容');

    (doc.nodes || []).forEach(function (node) {
      var descriptor = describeNode(node, options && options.getStates ? options.getStates() : null);
      if (node.kind === 'state_change' && !descriptor.summary) return;
      var element = document.createElement(node.kind === 'option_group' ? 'div' : 'span');
      element.className = 'story-visual-node story-visual-node-' + node.kind;
      element.dataset.start = String(node.start);
      element.dataset.end = String(node.end);
      if (node.kind === 'text') {
        element.contentEditable = 'true';
        element.spellcheck = false;
        appendTextParts(element, descriptor);
        element.addEventListener('blur', function () {
          if (options && options.commitTextNode) options.commitTextNode(node, sourceFromTextEditor(element));
        });
        element.addEventListener('keydown', function (event) {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (options && options.commitTextNode) options.commitTextNode(node, sourceFromTextEditor(element));
          }
        });
      } else if (node.kind === 'state_change') {
        element = document.createElement('button');
        element.type = 'button';
        element.className = 'story-visual-node story-visual-node-state_change story-visual-edit-button';
        element.dataset.start = String(node.start);
        element.dataset.end = String(node.end);
        element.textContent = descriptor.summary;
        element.addEventListener('click', function () {
          if (options && options.onEditState) options.onEditState(node);
        });
      } else {
        element.textContent = node.raw;
      }
      if (node.diagnostics && node.diagnostics.length) {
        element.classList.add('has-diagnostic');
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', node.diagnostics[0].message);
        var report = function () { if (onDiagnostic) onDiagnostic(node.diagnostics[0]); };
        element.addEventListener('click', report);
        element.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); report(); }
        });
      }
      surface.appendChild(element);
    });
    host.appendChild(surface);
    return doc;
  }

  // Public no-op retained for consumers which create no controller.
  function commitFocusedEditor() {}
  function destroy() {}

  function createController(options) {
    var sourceTextarea = options.sourceTextarea;
    var visualHost = options.visualHost;
    var sourceWrap = options.sourceWrap || (sourceTextarea && sourceTextarea.closest('.editor-text-wrap'));
    var getSource = options.getSource;
    var onDiagnostic = options.onDiagnostic;
    var lastNode = null;
    var currentDocument = null;
    var mode = 'source';
    var isCommitting = false;

    function commitTextNode(node, replacement) {
      if (isCommitting || !node || replacement === node.raw) return;
      var VisualDoc = getVisualDoc();
      if (!VisualDoc) return;
      try {
        isCommitting = true;
        var next = VisualDoc.replaceNode(getSource(), node, replacement);
        options.setSource(next);
        currentDocument = VisualDoc.scan(next);
        renderDocument(visualHost, currentDocument, onDiagnostic, renderOptions);
      } finally {
        isCommitting = false;
      }
    }
    function editState(node) {
      if (typeof options.onEditState === 'function') options.onEditState(node);
    }
    var renderOptions = {
      getStates: options.getStates,
      commitTextNode: commitTextNode,
      onEditState: editState
    };

    function refresh() {
      var VisualDoc = getVisualDoc();
      if (!VisualDoc) return null;
      currentDocument = VisualDoc.scan(getSource());
      renderDocument(visualHost, currentDocument, onDiagnostic, renderOptions);
      return currentDocument;
    }
    function rememberSelection() {
      if (!currentDocument || !sourceTextarea) return;
      var VisualDoc = getVisualDoc();
      lastNode = VisualDoc && VisualDoc.findNodeAtOffset(currentDocument, sourceTextarea.selectionStart);
    }
    function showVisual() {
      commitFocusedEditor();
      refresh();
      rememberSelection();
      mode = 'visual';
      if (sourceWrap) sourceWrap.hidden = true;
      if (visualHost) visualHost.hidden = false;
    }
    function showSource() {
      commitFocusedEditor();
      mode = 'source';
      if (visualHost) visualHost.hidden = true;
      if (sourceWrap) sourceWrap.hidden = false;
      if (sourceTextarea) {
        var position = lastNode ? lastNode.start : sourceTextarea.selectionStart;
        position = Math.max(0, Math.min(position, sourceTextarea.value.length));
        sourceTextarea.focus();
        try { sourceTextarea.setSelectionRange(position, position); } catch (_) {}
      }
    }
    return {
      showVisual: showVisual,
      showSource: showSource,
      refresh: refresh,
      commitFocusedEditor: function () {
        var active = typeof document !== 'undefined' && document.activeElement;
        if (active && active.matches && active.matches('.story-visual-node-text[contenteditable="true"]')) active.blur();
      },
      getMode: function () { return mode; },
      destroy: destroy
    };
  }

  var StoryVisualUI = {
    createController: createController,
    renderDocument: renderDocument,
    describeNode: describeNode,
    commitFocusedEditor: commitFocusedEditor,
    destroy: destroy
  };
  if (typeof window !== 'undefined') window.StoryVisualUI = StoryVisualUI;
  if (typeof module !== 'undefined' && module.exports) module.exports = StoryVisualUI;
})();
