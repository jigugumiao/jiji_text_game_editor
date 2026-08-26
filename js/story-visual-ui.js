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

  // The visual surface deliberately renders from the lossless document model.
  // It never serializes or normalizes source merely because a user changed modes.
  function renderDocument(host, doc, onDiagnostic) {
    if (!host || !doc) return doc;
    host.replaceChildren();
    var surface = document.createElement('div');
    surface.className = 'story-visual-document';
    surface.setAttribute('role', 'document');
    surface.setAttribute('aria-label', '可视化剧情内容');

    (doc.nodes || []).forEach(function (node) {
      var element = document.createElement(node.kind === 'option_group' ? 'div' : 'span');
      element.className = 'story-visual-node story-visual-node-' + node.kind;
      element.dataset.start = String(node.start);
      element.dataset.end = String(node.end);
      element.textContent = node.raw;
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

  // Kept as a public boundary for the forthcoming editable visual controls.
  // Task 6 has no visual fields yet, so there is nothing buffered to commit.
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

    function refresh() {
      var VisualDoc = getVisualDoc();
      if (!VisualDoc) return null;
      currentDocument = VisualDoc.scan(getSource());
      renderDocument(visualHost, currentDocument, onDiagnostic);
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
      commitFocusedEditor: commitFocusedEditor,
      getMode: function () { return mode; },
      destroy: destroy
    };
  }

  var StoryVisualUI = {
    createController: createController,
    renderDocument: renderDocument,
    commitFocusedEditor: commitFocusedEditor,
    destroy: destroy
  };
  if (typeof window !== 'undefined') window.StoryVisualUI = StoryVisualUI;
  if (typeof module !== 'undefined' && module.exports) module.exports = StoryVisualUI;
})();
