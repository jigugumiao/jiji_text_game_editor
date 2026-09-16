# Context Menu Variable Insertion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `插入 → 变量 → 变量名 → 操作` to the source text editor context menu, using current variable definitions and type-appropriate insertion actions.

**Architecture:** `js/story-vars.js` remains the single source of truth for which insert actions each variable type supports and for each action's text/caret/standalone metadata. `js/editor.js` converts that pure model into the existing nested context-menu item format and delegates actual source replacement to the existing variable choice path. The menu reads `Storage.getVars()` on every expansion so it never caches stale variable names.

**Tech Stack:** Browser JavaScript, Node.js `node:assert/strict` tests, existing `StoryVars`, existing custom context-menu renderer, Python inline build script.

---

## File Structure

- Modify `js/story-vars.js`: expose pure variable insertion action descriptors and insertion blueprints.
- Modify `js/editor.js`: add the nested variable menu, empty-state navigation, and shared insertion application.
- Modify `css/style.css`: style disabled context-menu rows used by the empty variable-library state.
- Create `tests/context-menu-variable.test.js`: cover action sets, generated syntax, context-menu wiring, and empty-state behavior.
- Modify `tests/release-cache-bust.test.js`: require the new app version and cache identifiers.
- Modify `index.html`: bump version and affected front-end resource cache identifiers.

### Task 1: Variable insertion model

**Files:**
- Modify: `js/story-vars.js`
- Create: `tests/context-menu-variable.test.js`

- [ ] **Step 1: Write the failing type/action tests**

Create `tests/context-menu-variable.test.js` with:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const StoryVars = require('../js/story-vars.js');

assert.deepEqual(
  StoryVars.getInsertActions({ name: '金币', type: 'number' }, false).map(item => item.act),
  ['read', 'assign', 'inc', 'dec']
);
assert.deepEqual(
  StoryVars.getInsertActions({ name: '工作', type: 'text' }, false).map(item => item.act),
  ['read', 'assign', 'input']
);
assert.deepEqual(
  StoryVars.getInsertActions({ name: '已开门', type: 'boolean' }, true).map(item => item.act),
  ['read', 'assign', 'cond']
);

const boolRead = '{已开门:是|否}';
assert.deepEqual(StoryVars.buildInsertChoice('read', '已开门', 'boolean'), {
  text: boolRead, caretOffset: boolRead.length, standalone: false
});
const assignOpen = '<变量:金币=';
assert.deepEqual(StoryVars.buildInsertChoice('assign', '金币', 'number'), {
  text: assignOpen + '>', caretOffset: assignOpen.length, standalone: true
});
const inputOpen = '<玩家输入变量:工作,"';
assert.deepEqual(StoryVars.buildInsertChoice('input', '工作', 'text'), {
  text: inputOpen + '">', caretOffset: inputOpen.length, standalone: true
});

const inline = StoryVars.applyInsertChoice('你 好', 1, 2, StoryVars.buildInsertChoice('read', '工作', 'text'));
assert.deepEqual(inline, { source: '你{工作}好', caret: '你{工作}'.length });
const standalone = StoryVars.applyInsertChoice('前文后文', 2, 2, StoryVars.buildInsertChoice('assign', '金币', 'number'));
assert.equal(standalone.source, '前文\n<变量:金币=>\n后文');
assert.equal(standalone.caret, ('前文\n' + assignOpen).length);
```

Use `Array.from(text.slice(0, caretOffset)).length` semantics only if implementation changes caret offsets to code-point units; otherwise offsets remain JavaScript string indices as used by `setSelectionRange`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tests/context-menu-variable.test.js
```

Expected: FAIL because `StoryVars.getInsertActions` is not a function.

- [ ] **Step 3: Implement the minimal pure model**

Add before the `StoryVars` export object in `js/story-vars.js`:

```js
function buildInsertChoice(act, name, type) {
  var text = '';
  var caretOffset = null;
  var standalone = false;
  if (act === 'read') text = type === 'boolean' ? '{' + name + ':是|否}' : '{' + name + '}';
  else if (act === 'assign') {
    text = '<变量:' + name + '=>';
    caretOffset = ('<变量:' + name + '=').length;
    standalone = true;
  } else if (act === 'inc') { text = '<变量:' + name + '+1>'; standalone = true; }
  else if (act === 'dec') { text = '<变量:' + name + '-1>'; standalone = true; }
  else if (act === 'input') {
    var open = '<玩家输入变量:' + name + ',"';
    text = open + '">';
    caretOffset = open.length;
    standalone = true;
  }
  if (caretOffset == null) caretOffset = text.length;
  return { text: text, caretOffset: caretOffset, standalone: standalone };
}

function getInsertActions(state, includeCondition) {
  var name = state && String(state.name == null ? '' : state.name).trim();
  var type = state && state.type || 'text';
  if (!name) return [];
  var actions = [
    { label: '读取', act: 'read', choice: buildInsertChoice('read', name, type) },
    { label: '赋值', act: 'assign', choice: buildInsertChoice('assign', name, type) }
  ];
  if (type === 'number') {
    actions.push({ label: '+1', act: 'inc', choice: buildInsertChoice('inc', name, type) });
    actions.push({ label: '-1', act: 'dec', choice: buildInsertChoice('dec', name, type) });
  }
  if (type === 'text') actions.push({ label: '玩家输入', act: 'input', choice: buildInsertChoice('input', name, type) });
  if (includeCondition) actions.push({ label: '作为条件', act: 'cond', choice: null });
  return actions;
}

function applyInsertChoice(source, start, end, choice) {
  source = String(source == null ? '' : source);
  start = Math.max(0, Math.min(Number(start) || 0, source.length));
  end = Math.max(start, Math.min(Number(end) || start, source.length));
  var before = source.slice(0, start);
  var after = source.slice(end);
  var prefix = '';
  var suffix = '';
  if (choice.standalone) {
    var lineBefore = before.slice(before.lastIndexOf('\n') + 1);
    var nextNewline = after.indexOf('\n');
    var lineAfter = nextNewline === -1 ? after : after.slice(0, nextNewline);
    if (lineBefore.trim()) prefix = '\n';
    if (lineAfter.trim()) suffix = '\n';
  }
  var insertStart = before.length + prefix.length;
  return {
    source: before + prefix + choice.text + suffix + after,
    caret: insertStart + choice.caretOffset
  };
}
```

Export all three functions on `StoryVars`. Do not add them to `RUNTIME_FNS`; they are editor-only helpers and must not inflate exported games.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node tests/context-menu-variable.test.js
node tests/story-vars.test.js
node tests/var-conformance.test.js
```

Expected: all three commands exit 0.

- [ ] **Step 5: Commit the pure model**

```powershell
git add js/story-vars.js tests/context-menu-variable.test.js
git commit -m "feat: model variable context insert actions"
```

### Task 2: Nested right-click variable menu

**Files:**
- Modify: `js/editor.js`
- Modify: `css/style.css`
- Modify: `tests/context-menu-variable.test.js`

- [ ] **Step 1: Add failing editor wiring assertions**

Append to `tests/context-menu-variable.test.js`:

```js
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'editor.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');

assert.match(editorSource, /kind: 'variable', label: '变量'/);
assert.match(editorSource, /function buildVariableSubmenu\(\)/);
assert.match(editorSource, /window\.Storage\.getVars\(\)/);
assert.match(editorSource, /function buildVariableActionSubmenu\(state, includeCondition\)/);
assert.match(editorSource, /window\.StoryVars\.getInsertActions\(state, includeCondition\)/);
assert.match(editorSource, /window\.StoryOptions\.extractOptionLine\(line\)\.some/);
assert.match(editorSource, /label: '变量库为空', disabled: true/);
assert.match(editorSource, /label: '前往变量库'/);
assert.match(editorSource, /switchLib\('variable'\)/);
assert.match(editorSource, /if \(it\.disabled\)/);
assert.match(cssSource, /\.ctx-item\.disabled/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tests/context-menu-variable.test.js
```

Expected: FAIL at the missing `kind: 'variable'` assertion.

- [ ] **Step 3: Add the variable category**

In `buildInsertAssetMenu()` inside `js/editor.js`, add the first category:

```js
{ kind: 'variable', label: '变量', icon: 'ic-key' },
```

Handle it before asset kinds:

```js
if (c.kind === 'variable') {
  return { label: c.label, icon: c.icon, submenu: function () { return buildVariableSubmenu(); } };
}
```

- [ ] **Step 4: Build variable and action submenus dynamically**

Add near the existing right-click submenu builders in `js/editor.js`:

```js
function stateTypeLabel(type) {
  return ({ number: '数字', text: '文字', boolean: '是 / 否' })[type] || '文字';
}

function buildVariableSubmenu() {
  const vars = (window.Storage.getVars() || []).filter(function (state) {
    return state && String(state.name == null ? '' : state.name).trim();
  });
  if (!vars.length) {
    return [
      { label: '变量库为空', disabled: true },
      { separator: true },
      { label: '前往变量库', icon: 'ic-key', action: function () { switchLib('variable'); } }
    ];
  }
  const range = ctxInsertRange();
  const includeCondition = isOptionLineAt(range.s);
  return vars.map(function (state) {
    return {
      label: state.name + '（' + stateTypeLabel(state.type) + '）',
      icon: 'ic-key',
      submenu: function () { return buildVariableActionSubmenu(state, includeCondition); }
    };
  });
}

function isOptionLineAt(off) {
  const value = storyText.value;
  const lineStart = value.lastIndexOf('\n', off - 1) + 1;
  let lineEnd = value.indexOf('\n', off);
  if (lineEnd === -1) lineEnd = value.length;
  const line = value.slice(lineStart, lineEnd);
  return window.StoryOptions.extractOptionLine(line).some(function (option) { return option.ok; });
}

function buildVariableActionSubmenu(state, includeCondition) {
  return window.StoryVars.getInsertActions(state, includeCondition).map(function (item) {
    return {
      label: item.label,
      icon: 'ic-key',
      action: function () {
        const contextRange = ctxInsertRange();
        const range = { start: contextRange.s, end: contextRange.e };
        const optionContext = item.act === 'cond' && isOptionLineAt(range.start) ? lineCtxAt(range.start) : null;
        applyVarChoice(item.act, state.name, state.type, range, optionContext);
      }
    };
  });
}
```

- [ ] **Step 5: Make non-read state instructions standalone through the shared choice model**

Refactor the non-condition branches of `applyVarChoice()` to call `StoryVars.buildInsertChoice(act, name, type)`. Add this replacement helper, which delegates the actual source edit to the tested pure function:

```js
function replaceVarChoiceRange(choice, range) {
  const ta = storyText;
  const scrollTop = ta.scrollTop;
  const result = window.StoryVars.applyInsertChoice(ta.value, range.start, range.end, choice);
  ta.value = result.source;
  try { ta.setSelectionRange(result.caret, result.caret); } catch (_) {}
  ta.scrollTop = scrollTop;
  commitEdit();
}
```

The core branch should have this shape:

```js
if (act !== 'cond') {
  const choice = window.StoryVars.buildInsertChoice(act, name, type);
  replaceVarChoiceRange(choice, range);
  return;
}
```

`replaceVarChoiceRange(choice, range)` must treat `choice.standalone === false` as a direct range replacement and `true` as an independent-line insertion. This same path serves both the existing variable-library popover and the new context menu.

- [ ] **Step 6: Add disabled menu-row support**

In both `showContextMenu()` and `ctxMakePanel()`, append ` disabled` to the row class when `it.disabled` is true. Do not attach submenu or action click handlers to disabled rows.

Add to `css/style.css`:

```css
.ctx-menu .ctx-item.disabled,
.ctx-sub .ctx-item.disabled {
  opacity: .55;
  cursor: default;
  pointer-events: none;
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
node tests/context-menu-variable.test.js
node tests/story-state-management.test.js
node tests/visual-story-ui.test.js
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit the menu integration**

```powershell
git add js/editor.js css/style.css tests/context-menu-variable.test.js
git commit -m "feat: add variables to editor context menu"
```

### Task 3: Release metadata and complete verification

**Files:**
- Modify: `index.html`
- Modify: `tests/release-cache-bust.test.js`

- [ ] **Step 1: Write the failing cache-bust expectations**

Change `tests/release-cache-bust.test.js` to require:

```js
assert.match(html, /id="app-version">v25\.4\.85</, '界面版本必须标记右键变量插入');
assert.match(html, /css\/style\.css\?v=20260829-01/, '右键变量菜单样式必须刷新缓存标识');
assert.match(html, /js\/story-vars\.js\?v=20260829-01/, '变量插入模型必须刷新缓存标识');
assert.match(html, /js\/editor\.js\?v=20260829-02/, '右键变量菜单必须刷新 editor.js 缓存标识');
```

- [ ] **Step 2: Run the cache test and verify RED**

Run:

```powershell
node tests/release-cache-bust.test.js
```

Expected: FAIL because `index.html` still reports v25.4.84 and old cache identifiers.

- [ ] **Step 3: Update release metadata**

In `index.html`:

- Change both `v25.4.84` displays to `v25.4.85`.
- Change `css/style.css` cache identifier to `20260829-01`.
- Change `js/story-vars.js` cache identifier to `20260829-01`.
- Change `js/editor.js` cache identifier to `20260829-02`.

- [ ] **Step 4: Run the complete Node test suite**

Run:

```powershell
$tests = Get-ChildItem tests -Filter *.test.js | Sort-Object Name
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: every test exits 0, including `context-menu-variable.test.js`.

- [ ] **Step 5: Check syntax and whitespace**

Run:

```powershell
node --check js/story-vars.js
node --check js/editor.js
git diff --check
```

Expected: all commands exit 0 and `git diff --check` prints no errors.

- [ ] **Step 6: Build the isolated test version**

Run:

```powershell
python build_inline.py --test
```

Expected: exit 0 and `dist-test/index.html` contains `v25.4.85-TEST`, `getInsertActions`, and `buildVariableSubmenu`.

- [ ] **Step 7: Commit release metadata**

```powershell
git add index.html tests/release-cache-bust.test.js
git commit -m "chore: release context menu variable insertion"
```

- [ ] **Step 8: Review final branch state**

Run:

```powershell
git status --short --branch
git log -4 --oneline
```

Expected: clean `codex/visual-story-state` worktree, ahead of its remote only by the intended local commits.
