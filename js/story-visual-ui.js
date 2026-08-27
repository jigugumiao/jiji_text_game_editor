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

  function getStoryVars() {
    if (typeof window !== 'undefined' && window.StoryVars) return window.StoryVars;
    if (typeof require === 'function') {
      try { return require('./story-vars.js'); } catch (_) { return null; }
    }
    return null;
  }

  function getStoryOptions() {
    if (typeof window !== 'undefined' && window.StoryOptions) return window.StoryOptions;
    if (typeof require === 'function') {
      try { return require('./story-options.js'); } catch (_) { return null; }
    }
    return null;
  }

  function createEmptyOption(blocks) {
    return { text: '', block: null, condition: null, unmetBehavior: 'hide', unmetMessage: '', effects: [], unknownFields: [] };
  }

  function conditionAstToDraft(ast, states) {
    if (!ast || ast.k === 'true') return null;
    function comparison(node) {
      if (node.k === 'bare') return { kind: 'comparison', name: node.name, op: '==', value: true };
      if (node.k === 'cmp') return { kind: 'comparison', name: node.name, op: node.op, value: node.val && node.val.v };
      return null;
    }
    function group(node) {
      if (node.k === 'and' || node.k === 'or') {
        var mode = node.k === 'and' ? 'all' : 'any';
        var rows = [];
        function add(part) {
          if (part && part.k === node.k) { add(part.l); add(part.r); return; }
          var cmp = comparison(part);
          rows.push(cmp || group(part));
        }
        add(node);
        return { kind: 'group', mode: mode, rows: rows };
      }
      var row = comparison(node);
      return { kind: 'group', mode: 'all', rows: row ? [row] : [] };
    }
    var root = group(ast);
    delete root.kind;
    return root;
  }

  function conditionDraftToAst(draft) {
    if (!draft) return null;
    function rowToAst(row) {
      if (!row) return null;
      if (row.kind === 'group') return groupToAst(row);
      if (row.kind !== 'comparison' || !row.name || !row.op) return null;
      var value = row.value;
      var scalar = typeof value === 'boolean' ? { s: 'bool', v: value }
        : typeof value === 'number' ? { s: 'num', v: value }
          : { s: 'str', v: String(value == null ? '' : value) };
      return { k: 'cmp', name: String(row.name), op: row.op, val: scalar };
    }
    function groupToAst(group) {
      var rows = Array.isArray(group && group.rows) ? group.rows.map(rowToAst).filter(Boolean) : [];
      if (!rows.length) return null;
      var kind = group.mode === 'any' ? 'or' : 'and';
      return rows.slice(1).reduce(function (tree, row) { return { k: kind, l: tree, r: row }; }, rows[0]);
    }
    return groupToAst(draft);
  }

  function allowedOperations(type) {
    if (type === 'number') return ['+', '-', '='];
    if (type === 'boolean' || type === 'text') return ['='];
    return [];
  }

  function effectDraftToOps(draft, states) {
    var types = stateTypes(states), effects = Array.isArray(draft) ? draft : [];
    var ops = [], errors = [], seen = {};
    effects.forEach(function (effect) {
      var name = String(effect && effect.name || '').trim();
      var op = effect && effect.op;
      var value = effect && (effect.value !== undefined ? effect.value : effect.val);
      if (!name || !types[name]) { errors.push('变量「' + name + '」不存在'); return; }
      if (seen[name]) errors.push('变量「' + name + '」重复');
      seen[name] = true;
      if (allowedOperations(types[name]).indexOf(op) < 0) { errors.push('变量「' + name + '」不能使用此操作'); return; }
      if (types[name] === 'boolean' && value !== true && value !== false && value !== 'true' && value !== 'false') { errors.push('变量「' + name + '」的值不正确'); return; }
      if (types[name] === 'number' && !/^-?\d+(\.\d+)?$/.test(String(value == null ? '' : value))) { errors.push('变量「' + name + '」的值不正确'); return; }
      ops.push({ name: name, op: op, val: String(value == null ? '' : value) });
    });
    return { ok: errors.length === 0, ops: ops, errors: errors };
  }

  function validateOptionDraft(draft, states, blocks) {
    var source = draft || {}, types = stateTypes(states), names = Array.isArray(blocks) ? blocks : [];
    var errors = [];
    if (!String(source.text == null ? '' : source.text).trim()) errors.push('选项文字不能为空');
    if (source.block && names.indexOf(source.block) < 0) errors.push('所选剧情块不存在');
    if (Array.isArray(source.unknownFields) && source.unknownFields.length) errors.push('此选项包含无法识别的高级字段，请在源码模式编辑');
    function checkGroup(group) {
      if (!group || !Array.isArray(group.rows) || !group.rows.length) { errors.push('条件组不能为空'); return; }
      group.rows.forEach(function (row) {
        if (row && row.kind === 'group') { checkGroup(row); return; }
        if (!row || !types[row.name]) { errors.push('变量「' + String(row && row.name || '') + '」不存在'); return; }
        var type = types[row.name], valid = type === 'number' ? ['>', '<', '>=', '<=', '==', '!=', '='] : type === 'text' ? ['==', '!=', '=', 'contains', 'notcontains'] : ['==', '!=', '='];
        if (valid.indexOf(row.op) < 0) errors.push('变量「' + row.name + '」不能使用此操作');
      });
    }
    if (source.condition) checkGroup(source.condition);
    var effectCheck = effectDraftToOps(source.effects, types);
    errors = errors.concat(effectCheck.errors);
    return { ok: errors.length === 0, errors: errors, effects: effectCheck.ops, condition: conditionDraftToAst(source.condition) };
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

  // Keep source line breaks lossless, but do not make blank lines part of the
  // editable box.  A command followed by empty lines should read as normal
  // document spacing, not as an empty outlined editor row.
  function splitEditableText(raw) {
    var source = String(raw == null ? '' : raw);
    var leading = (source.match(/^(?:(?:\r\n)|\r|\n)*/) || [''])[0];
    var rest = source.slice(leading.length);
    var trailing = (rest.match(/(?:(?:\r\n)|\r|\n)*$/) || [''])[0];
    return { leading: leading, body: rest.slice(0, rest.length - trailing.length), trailing: trailing };
  }

  // DOM-free description boundary: Node tests can verify visual language without
  // requiring a browser, and the renderer below only consumes this result.
  function describeNode(node, states) {
    if (!node) return null;
    if (node.kind === 'text') return describeText(node, states);
    if (node.kind === 'state_change') return describeStateChange(node);
    if (node.kind === 'command_chip') {
      var command = node.data || {};
      return { kind: 'command_chip', category: command.category, summary: command.summary, editable: true };
    }
    return { kind: node.kind, raw: node.raw, editable: false };
  }

  function insertAtVisualSelection(source, selection, text) {
    var value = String(source == null ? '' : source);
    var offset = Number(selection);
    var at = Number.isFinite(offset) ? Math.max(0, Math.min(offset, value.length)) : value.length;
    return value.slice(0, at) + String(text == null ? '' : text) + value.slice(at);
  }

  function serializeCommandEdit(node, value) {
    var command = node && node.data || {};
    var name = String(command.name || '').trim();
    if (!name) return node && node.raw || '';
    var nextValue = String(value == null ? '' : value).trim();
    return '<' + name + (nextValue ? ':' + nextValue : '') + '>';
  }

  function appendTextParts(element, descriptor) {
    descriptor.parts.forEach(function (part) {
      if (part.kind === 'text') {
        element.appendChild(document.createTextNode(part.value));
        return;
      }
      var token = document.createElement('span');
      token.className = 'story-visual-state-token story-visual-state-token-read';
      token.contentEditable = 'false';
      token.dataset.source = part.source;
      token.dataset.name = part.name;
      token.textContent = part.source;
      element.appendChild(token);
    });
  }

  function sourceFromTextEditor(element) {
    // contenteditable creates <br> and block elements when the user presses
    // Enter.  textContent alone drops those visual line breaks, so turn the
    // browser DOM back into source text explicitly before replacing a span.
    function readChildren(parent, root) {
      var out = '';
      Array.prototype.forEach.call(parent.childNodes || [], function (child, index) {
        if (child.nodeType === 3) { out += child.nodeValue || ''; return; }
        if (child.nodeType !== 1) return;
        if (child.dataset && child.dataset.source != null) { out += child.dataset.source; return; }
        var tag = String(child.tagName || '').toUpperCase();
        if (tag === 'BR') { if (!out || out.charAt(out.length - 1) !== '\n') out += '\n'; return; }
        var block = tag === 'DIV' || tag === 'P';
        if (root && block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        out += readChildren(child, false);
        if (root && block && index < parent.childNodes.length - 1 && out.charAt(out.length - 1) !== '\n') out += '\n';
      });
      return out;
    }
    return readChildren(element, true);
  }

  function isCaretAtEditableBoundary(element, atEnd) {
    var selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed) return false;
    var range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return false;
    var edge = document.createRange();
    edge.selectNodeContents(element);
    edge.collapse(!!atEnd);
    return atEnd
      ? range.compareBoundaryPoints(Range.END_TO_END, edge) === 0
      : range.compareBoundaryPoints(Range.START_TO_START, edge) === 0;
  }

  function moveBetweenEditableParagraphs(element, direction) {
    if (!isCaretAtEditableBoundary(element, direction > 0)) return false;
    var paragraphs = Array.prototype.slice.call(element.parentNode.querySelectorAll('.story-visual-node-text[contenteditable="true"]'));
    var index = paragraphs.indexOf(element);
    var target = paragraphs[index + direction];
    if (!target) return false;
    var range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(direction < 0);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    target.focus();
    return true;
  }

  function optionDraftFromOption(option, states) {
    var source = option || {}, SV = getStoryVars();
    return {
      text: source.text || '', block: source.block || null,
      condition: source.condition && SV ? conditionAstToDraft(SV.parseCondition(source.condition), states) : null,
      unmetBehavior: source.unmetBehavior === 'disable' ? 'disable' : 'hide',
      unmetMessage: source.unmetMessage || '',
      effects: (source.effects || []).map(function (effect) { return { name: effect.name, op: effect.op, value: effect.val }; }),
      unknownFields: (source.unknownFields || []).slice()
    };
  }

  function makeField(tag, value, choices, disabled) {
    var element = document.createElement(tag);
    if (tag === 'select') (choices || []).forEach(function (choice) {
      var opt = document.createElement('option'); opt.value = choice[0]; opt.textContent = choice[1];
      if (String(value) === String(choice[0])) opt.selected = true;
      element.appendChild(opt);
    });
    else element.value = value == null ? '' : value;
    element.disabled = !!disabled;
    return element;
  }

  function renderContextualTip(context) {
    var key = context && context.tipKey;
    if (!key || !context.getUiPreference || !context.setUiPreference) return null;
    var preferenceKey = 'visual-story-tip-dismissed:' + key;
    if (context.getUiPreference(preferenceKey)) return null;
    var messages = {
      'first-option': '选项可以跳转到其他剧情，也可以只改变变量后留在当前剧情。先写按钮文字，其他内容可以慢慢补。',
      'first-condition': '条件决定这个选项何时出现。先从一条简单的「不少于」或「为真」开始。',
      'first-effect': '剧情状态变化会在玩家点击选项后发生，例如扣金币、拿到钥匙或提高好感度。'
    };
    if (!messages[key]) return null;
    var tip = document.createElement('div');
    tip.className = 'story-visual-context-tip';
    var text = document.createElement('span'); text.textContent = messages[key];
    var close = document.createElement('button'); close.type = 'button'; close.className = 'story-visual-context-tip-close'; close.textContent = '知道了';
    close.addEventListener('click', function () { context.setUiPreference(preferenceKey, '1'); tip.remove(); });
    tip.append(text, close);
    return tip;
  }

  function renderOptionEditor(host, node, initialDraft, context) {
    var states = context.getStates ? context.getStates() : [], types = stateTypes(states);
    var blocks = context.getBlocks ? context.getBlocks() : [];
    var draft = initialDraft;
    var readOnly = draft.unknownFields && draft.unknownFields.length;
    host.replaceChildren();
    var form = document.createElement('form');
    form.className = 'story-visual-option-form';
    form.noValidate = true;
    form.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    var title = document.createElement('div'); title.className = 'story-visual-form-title'; title.textContent = '编辑选项'; form.appendChild(title);
    var contextualTip = renderContextualTip(context);
    var error = document.createElement('div'); error.className = 'story-visual-form-error'; error.hidden = true; form.appendChild(error);
    if (readOnly) { error.textContent = '此选项包含无法识别的高级字段，请在源码模式编辑'; error.hidden = false; }
    function field(label, input) { var line = document.createElement('label'); line.className = 'story-visual-form-field'; line.append(document.createTextNode(label), input); form.appendChild(line); return input; }
    var text = field('按钮文字', makeField('input', draft.text, null, readOnly));
    var blockChoices = [['', '不跳转，留在当前剧情']].concat((blocks || []).map(function (name) { return [name, name]; }));
    var block = field('跳转到（可不选）', makeField('select', draft.block || '', blockChoices, readOnly));
    var unmet = field('条件未满足时', makeField('select', draft.unmetBehavior, [['hide', '隐藏'], ['disable', '禁用（显示但不可选择）']], readOnly));
    var message = field('禁用时显示的文字', makeField('input', draft.unmetMessage, null, readOnly));
    message.placeholder = '例如：金币不足';
    var messageLine = message.parentNode;
    messageLine.hidden = unmet.value !== 'disable';
    unmet.addEventListener('change', function () { messageLine.hidden = unmet.value !== 'disable'; });
    var conditionArea = document.createElement('div'); conditionArea.className = 'story-visual-condition-area'; form.appendChild(conditionArea);
    var effectsArea = document.createElement('div'); effectsArea.className = 'story-visual-effects-area'; form.appendChild(effectsArea);
    function rerender() { renderOptionEditor(host, node, readDraft(), context); }
    function readDraft() { return { text: text.value, block: block.value || null, condition: draft.condition, unmetBehavior: unmet.value, unmetMessage: message.value, effects: draft.effects, unknownFields: draft.unknownFields }; }
    function rowLabel(label) { var e = document.createElement('div'); e.className = 'story-visual-form-label'; e.textContent = label; return e; }
    function renderGroup(group, parent, removeGroup) {
      var groupEl = document.createElement('div'); groupEl.className = 'story-visual-condition-group';
      var mode = makeField('select', group.mode, [['all', '全部满足'], ['any', '任一满足']], readOnly);
      mode.addEventListener('change', function () { group.mode = mode.value; }); groupEl.appendChild(mode);
      if (!readOnly && removeGroup) {
        var removeGroupButton = document.createElement('button'); removeGroupButton.type = 'button'; removeGroupButton.textContent = '删除条件组';
        removeGroupButton.addEventListener('click', function () { removeGroup(); }); groupEl.appendChild(removeGroupButton);
      }
      group.rows.forEach(function (row, index) {
        if (row.kind === 'group') { renderGroup(row, groupEl, function () { group.rows.splice(index, 1); rerender(); }); return; }
        var line = document.createElement('div'); line.className = 'story-visual-condition-row';
        var name = makeField('select', row.name, [['', '变量']].concat(Object.keys(types).map(function (key) { return [key, key]; })), readOnly);
        var type = types[name.value] || 'number';
        var opChoices = type === 'number' ? [['>=', '不少于'], ['<=', '不多于'], ['>', '大于'], ['<', '小于'], ['=', '等于'], ['!=', '不等于']]
          : type === 'text' ? [['=', '等于'], ['!=', '不等于'], ['contains', '包含'], ['notcontains', '不包含']]
            : [['=', '是'], ['!=', '不是']];
        var op = makeField('select', row.op, opChoices, readOnly);
        var value = makeField('input', row.value, null, readOnly);
        name.addEventListener('change', function () { row.name = name.value; rerender(); });
        op.addEventListener('change', function () { row.op = op.value; }); value.addEventListener('input', function () { row.value = value.value; });
        line.append(name, op, value);
        if (!readOnly) { var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.addEventListener('click', function () { group.rows.splice(index, 1); rerender(); }); line.appendChild(remove); }
        groupEl.appendChild(line);
      });
      if (!readOnly) {
        var addComparison = document.createElement('button'); addComparison.type = 'button'; addComparison.textContent = '添加条件';
        addComparison.addEventListener('click', function () { group.rows.push({ kind: 'comparison', name: Object.keys(types)[0] || '', op: '=', value: '' }); rerender(); });
        var addGroup = document.createElement('button'); addGroup.type = 'button'; addGroup.textContent = '添加条件组';
        addGroup.addEventListener('click', function () { group.rows.push({ kind: 'group', mode: 'all', rows: [] }); rerender(); });
        groupEl.append(addComparison, addGroup);
      }
      parent.appendChild(groupEl);
    }
    conditionArea.appendChild(rowLabel('条件'));
    if (draft.condition) {
      renderGroup(draft.condition, conditionArea, function () { draft.condition = null; rerender(); });
      var conditionAst = conditionDraftToAst(draft.condition), SVForSummary = getStoryVars();
      if (conditionAst && SVForSummary && SVForSummary.summarizeCondition) {
        var summary = document.createElement('div'); summary.className = 'story-visual-condition-summary';
        summary.textContent = SVForSummary.summarizeCondition(conditionAst, types); conditionArea.appendChild(summary);
      }
    }
    else if (!readOnly) { var addCondition = document.createElement('button'); addCondition.type = 'button'; addCondition.textContent = '添加条件'; addCondition.addEventListener('click', function () { draft.condition = { mode: 'all', rows: [{ kind: 'comparison', name: Object.keys(types)[0] || '', op: '=', value: '' }] }; context.tipKey = 'first-condition'; rerender(); }); conditionArea.appendChild(addCondition); }
    effectsArea.appendChild(rowLabel('选中后变量变化'));
    draft.effects.forEach(function (effect, index) {
      var line = document.createElement('div'); line.className = 'story-visual-effect-row';
      var name = makeField('select', effect.name, [['', '变量']].concat(Object.keys(types).map(function (key) { return [key, key]; })), readOnly);
      var op = makeField('select', effect.op, allowedOperations(types[name.value]).map(function (value) { return [value, value === '+' ? '增加' : value === '-' ? '减少' : '设为']; }), readOnly);
      var value = makeField('input', effect.value, null, readOnly);
      name.addEventListener('change', function () { effect.name = name.value; effect.op = allowedOperations(types[name.value])[0] || '='; rerender(); });
      op.addEventListener('change', function () { effect.op = op.value; }); value.addEventListener('input', function () { effect.value = value.value; });
      line.append(name, op, value);
      if (!readOnly) { var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除'; remove.addEventListener('click', function () { draft.effects.splice(index, 1); rerender(); }); line.appendChild(remove); }
      effectsArea.appendChild(line);
    });
    if (!readOnly) { var addEffect = document.createElement('button'); addEffect.type = 'button'; addEffect.textContent = '添加变量变化'; addEffect.addEventListener('click', function () { draft.effects.push({ name: Object.keys(types)[0] || '', op: '=', value: '' }); context.tipKey = 'first-effect'; rerender(); }); effectsArea.appendChild(addEffect); }
    var actions = document.createElement('div'); actions.className = 'story-visual-form-actions';
    var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'story-visual-form-secondary'; cancel.textContent = '取消'; cancel.addEventListener('click', context.close); actions.appendChild(cancel);
    var submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'story-visual-form-primary'; submit.textContent = '完成'; submit.disabled = readOnly; actions.appendChild(submit); form.appendChild(actions);
    // The tip lives after the primary actions so its first appearance or
    // dismissal never shifts the fields a user is currently reading.
    if (contextualTip) form.appendChild(contextualTip);
    form.addEventListener('submit', function (event) {
      event.preventDefault(); var nextDraft = readDraft(); var checked = validateOptionDraft(nextDraft, types, blocks);
      if (!checked.ok) { error.textContent = checked.errors[0]; error.hidden = false; return; }
      var SV = getStoryVars(), SO = getStoryOptions();
      var option = { text: nextDraft.text, block: nextDraft.block, condition: checked.condition ? SV.serializeCondition(checked.condition) : null, unmetBehavior: nextDraft.unmetBehavior, unmetMessage: nextDraft.unmetMessage, effects: checked.effects, unknownFields: [] };
      var serialized = SO && SO.serializeOption ? SO.serializeOption(option) : { ok: false, error: '无法保存选项' };
      if (!serialized.ok) { error.textContent = serialized.error || '无法保存选项'; error.hidden = false; context.restore(); return; }
      var saved = context.commit(serialized.value);
      if (saved && !saved.ok) { error.textContent = saved.error || '无法保存选项'; error.hidden = false; }
    });
    host.appendChild(form);
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
        var textParts = splitEditableText(node.raw);
        if (textParts.leading) surface.appendChild(document.createTextNode(textParts.leading));
        if (!textParts.body) {
          if (textParts.trailing) surface.appendChild(document.createTextNode(textParts.trailing));
          return;
        }
        element = document.createElement('div');
        element.className = 'story-visual-node story-visual-node-text';
        element.dataset.start = String(node.start);
        element.dataset.end = String(node.end);
        element.contentEditable = 'true';
        element.spellcheck = false;
        appendTextParts(element, describeText({ raw: textParts.body }, options && options.getStates ? options.getStates() : null));
        element.addEventListener('blur', function () {
          if (options && options.commitTextNode) options.commitTextNode(node, textParts.leading + sourceFromTextEditor(element) + textParts.trailing);
        });
        element.addEventListener('keydown', function (event) {
          if (event.key === 'ArrowUp' && moveBetweenEditableParagraphs(element, -1)) {
            event.preventDefault();
            return;
          }
          if (event.key === 'ArrowDown' && moveBetweenEditableParagraphs(element, 1)) {
            event.preventDefault();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (options && options.commitTextNode) options.commitTextNode(node, textParts.leading + sourceFromTextEditor(element) + textParts.trailing);
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
      } else if (node.kind === 'command_chip') {
        element = document.createElement('button');
        element.type = 'button';
        element.className = 'story-visual-chip story-visual-chip-' + descriptor.category;
        element.dataset.start = String(node.start);
        element.dataset.end = String(node.end);
        element.textContent = descriptor.summary;
        element.addEventListener('click', function () {
          if (options && options.onEditCommand) options.onEditCommand(node, element);
        });
      } else if (node.kind === 'option_group') {
        element = document.createElement('button');
        element.type = 'button';
        element.className = 'story-visual-node story-visual-node-option_group story-visual-edit-button';
        element.dataset.start = String(node.start);
        element.dataset.end = String(node.end);
        var SO = getStoryOptions();
        element.textContent = SO && SO.summarizeOption ? SO.summarizeOption(node.data && node.data.option) : node.raw;
        element.addEventListener('click', function () {
          if (options && options.onEditOption) options.onEditOption(node);
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
      if (node.kind === 'text' && textParts.trailing) surface.appendChild(document.createTextNode(textParts.trailing));
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
    var editingOption = null;
    var sourceBeforeOptionEdit = null;
    var lastTextOffset = null;
    var insertMenu = typeof document !== 'undefined' ? document.getElementById('visual-insert-menu') : null;
    var insertPopover = typeof document !== 'undefined' ? document.getElementById('visual-insert-popover') : null;

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
    function editOption(node) {
      if (!node || !node.data || !node.data.option || !visualHost) return;
      editingOption = node;
      sourceBeforeOptionEdit = getSource();
      renderOptionEditor(visualHost, node, optionDraftFromOption(node.data.option, options.getStates ? options.getStates() : null), {
        getStates: options.getStates,
        getBlocks: options.getBlocks,
        tipKey: 'first-option',
        getUiPreference: options.getUiPreference,
        setUiPreference: options.setUiPreference,
        close: function () { editingOption = null; sourceBeforeOptionEdit = null; refresh(); },
        restore: function () { if (sourceBeforeOptionEdit != null) options.setSource(sourceBeforeOptionEdit); },
        commit: function (replacement) {
          var VisualDoc = getVisualDoc();
          try {
            var next = VisualDoc.replaceNode(getSource(), editingOption, replacement);
            options.setSource(next);
            editingOption = null; sourceBeforeOptionEdit = null;
            refresh();
            return { ok: true };
          } catch (_) {
            if (sourceBeforeOptionEdit != null) options.setSource(sourceBeforeOptionEdit);
            return { ok: false, error: '无法保存选项' };
          }
        }
      });
    }
    function editCommand(node, element) {
      if (!node || !node.data || !element || !element.parentNode) {
        if (typeof options.onEditCommand === 'function') options.onEditCommand(node);
        return;
      }
      var command = node.data;
      var editor = document.createElement('input');
      editor.type = 'text';
      editor.className = 'story-visual-command-input';
      editor.value = command.value == null ? '' : command.value;
      editor.setAttribute('aria-label', '编辑「' + command.name + '」的内容');
      editor.placeholder = command.name === '停顿' ? '毫秒（可留空）' : '填写内容';
      var wrapper = document.createElement('span');
      wrapper.className = element.className + ' story-visual-command-editing';
      var name = document.createElement('span');
      name.className = 'story-visual-command-name';
      name.textContent = command.name + '：';
      wrapper.append(name, editor);
      element.replaceWith(wrapper);
      var settled = false;
      function finish(save) {
        if (settled) return;
        settled = true;
        var replacement = serializeCommandEdit(node, editor.value);
        if (save && replacement !== node.raw) commitTextNode(node, replacement);
        else refresh();
      }
      editor.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      });
      editor.addEventListener('blur', function () { finish(true); });
      editor.focus();
      editor.select();
    }
    var renderOptions = {
      getStates: options.getStates,
      commitTextNode: commitTextNode,
      onEditState: editState,
      onEditOption: editOption,
      onEditCommand: editCommand
    };

    function refresh() {
      var VisualDoc = getVisualDoc();
      if (!VisualDoc) return null;
      if (editingOption) return currentDocument;
      currentDocument = VisualDoc.scan(getSource());
      renderDocument(visualHost, currentDocument, onDiagnostic, renderOptions);
      return currentDocument;
    }
    function rememberSelection() {
      if (!currentDocument || !sourceTextarea) return;
      var VisualDoc = getVisualDoc();
      lastNode = VisualDoc && VisualDoc.findNodeAtOffset(currentDocument, sourceTextarea.selectionStart);
      lastTextOffset = lastNode && lastNode.kind === 'text' ? sourceTextarea.selectionStart : null;
    }
    function insert(text) {
      var source = String(getSource() == null ? '' : getSource());
      var offset = Number(lastTextOffset);
      var at = Number.isFinite(offset) ? Math.max(0, Math.min(offset, source.length)) : source.length;
      var value = String(text == null ? '' : text);
      var next = insertAtVisualSelection(source, at, value);
      options.setSource(next);
      lastTextOffset = at + value.length;
      refresh();
      return next;
    }
    function showVisual() {
      commitFocusedEditor();
      refresh();
      rememberSelection();
      mode = 'visual';
      if (sourceWrap) sourceWrap.hidden = true;
      if (visualHost) visualHost.hidden = false;
      if (insertMenu) insertMenu.hidden = false;
    }
    function showSource() {
      commitFocusedEditor();
      mode = 'source';
      if (visualHost) visualHost.hidden = true;
      if (sourceWrap) sourceWrap.hidden = false;
      if (insertMenu) insertMenu.hidden = true;
      if (insertPopover) {
        insertPopover.hidden = true;
        insertPopover.classList.add('hidden');
      }
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
      insert: insert,
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
    insertAtVisualSelection: insertAtVisualSelection,
    splitEditableText: splitEditableText,
    sourceFromTextEditor: sourceFromTextEditor,
    serializeCommandEdit: serializeCommandEdit,
    createEmptyOption: createEmptyOption,
    validateOptionDraft: validateOptionDraft,
    conditionAstToDraft: conditionAstToDraft,
    conditionDraftToAst: conditionDraftToAst,
    effectDraftToOps: effectDraftToOps,
    commitFocusedEditor: commitFocusedEditor,
    destroy: destroy
  };
  if (typeof window !== 'undefined') window.StoryVisualUI = StoryVisualUI;
  if (typeof module !== 'undefined' && module.exports) module.exports = StoryVisualUI;
})();
