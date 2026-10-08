# Option Condition Tree and Conditional Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an intuitive tree editor for option conditions and allow each selected-option variable change to have its own optional execution condition.

**Architecture:** Keep `StoryOptions` as the only option grammar source and `StoryVars` as the only condition/variable semantics source. Extend option effects with `condition: string|null`, reuse one recursive condition draft UI for option-level and effect-level conditions, and select matching effects from a pre-click variable snapshot before applying them in source order.

**Tech Stack:** Browser JavaScript (ES5-compatible shared runtime functions), DOM/CSS, Node.js `assert` tests, Python inline build script.

---

## File map

- Modify `js/story-options.js`: parse, normalize, serialize and runtime-export `条件变化:`.
- Modify `js/story-visual-ui.js`: reusable condition-tree draft helpers, validation, natural-language translation and option form rendering.
- Modify `css/style.css`: quiet tree/effect layout with explicit light/dark form colors.
- Modify `js/exporter.js`: filter effects against a pre-click snapshot, then apply selected effects once.
- Modify `docs.html`: document the new source rule in the advanced reference.
- Modify `index.html`: bump app version and cache keys for changed assets.
- Modify `tests/story-options.test.js`: grammar, scanner and runtime-source coverage.
- Modify `tests/visual-story-ui.test.js`: draft conversion, validation, labels and progressive-disclosure coverage.
- Modify `tests/visual-options-runtime.test.js`: export parsing and snapshot semantics contract.
- Modify `tests/project-converter.test.js`: conditional effects count as option effects.
- Modify `tests/release-cache-bust.test.js`: exact version/cache assertions.

### Task 1: Extend the shared option grammar

**Files:**
- Modify: `tests/story-options.test.js`
- Modify: `tests/project-converter.test.js`
- Modify: `js/story-options.js`

- [ ] **Step 1: Write failing conditional-effect grammar tests**

Add cases that require both old and new effects to normalize to the same shape:

```js
const raw = '<选项:"购买",商店,条件变化:(勇气>=1)=>金币-10,变化:拿到钥匙=true>';
const parsed = StoryOptions.parseOptionTag(raw);
assert.equal(parsed.ok, true);
assert.deepEqual(parsed.option.effects, [
  { name: '金币', op: '-', val: '10', condition: '勇气>=1' },
  { name: '拿到钥匙', op: '=', val: 'true', condition: null }
]);
assert.equal(StoryOptions.serializeOption(parsed.option).value, raw);

assert.equal(
  StoryOptions.extractOptionLine('<选项:"A",条件变化:(勇气>0 && 金币>=10)=>金币-1>')[0].raw,
  '<选项:"A",条件变化:(勇气>0 && 金币>=10)=>金币-1>'
);

const malformed = StoryOptions.parseOptionTag('<选项:"A",条件变化:勇气>=1=>金币-1>');
assert.deepEqual(malformed.option.unknownFields, ['条件变化:勇气>=1=>金币-1']);
```

Also update existing expected old effects from `{name,op,val}` to `{name,op,val,condition:null}` and verify the injected runtime parser returns the same values.

In `tests/project-converter.test.js`, add `条件变化:(勇气>=1)=>金币-10` to one fixture and increase the expected `counts.effects` by one. This proves conversion analysis receives the new syntax from `StoryOptions` instead of a second parser.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node tests/story-options.test.js
node tests/project-converter.test.js
```

Expected: both FAIL because `条件变化:` is still unknown; the grammar test also shows old effects do not expose `condition:null`.

- [ ] **Step 3: Implement balanced conditional-effect parsing**

In `js/story-options.js`:

```js
var OPTIONAL_PREFIXES = ['条件变化:', '条件:', '不满足:', '提示:', '变化:'];

function getStoryVars() {
  if (typeof window !== 'undefined' && window.StoryVars) return window.StoryVars;
  if (typeof require === 'function') {
    try { return require('./story-vars.js'); } catch (_) { return null; }
  }
  return null;
}

function parseEffect(value) {
  var SV = getStoryVars();
  if (!SV || typeof SV.parseVarLine !== 'function') return null;
  var parsed = SV.parseVarLine('<变量:' + value + '>');
  if (parsed.bad.length || parsed.ops.length !== 1) return null;
  return { name: parsed.ops[0].name, op: parsed.ops[0].op, val: parsed.ops[0].val, condition: null };
}

function parseConditionalEffect(value) {
  var source = String(value == null ? '' : value).trim();
  if (source.charAt(0) !== '(') return null;
  var depth = 0, quote = null, escaped = false, close = -1;
  for (var i = 0; i < source.length; i++) {
    var ch = source.charAt(i);
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) { close = i; break; }
  }
  if (close < 1 || source.slice(close + 1, close + 3) !== '=>') return null;
  var condition = source.slice(1, close).trim();
  var SV = getStoryVars();
  if (!condition || !SV || !SV.parseCondition(condition)) return null;
  var effect = parseEffect(source.slice(close + 3).trim());
  if (!effect) return null;
  effect.condition = condition;
  return effect;
}
```

Update `parseOptionTag`, `normalizeOption` and `serializeOption` so unconditional effects emit `变化:` and conditional effects emit `条件变化:(` + condition + `)=>`. Include `getStoryVars` and `parseConditionalEffect` in `buildRuntimeSource()`.

Use these exact branches/shapes:

```js
if (field.indexOf('条件变化:') === 0) {
  var conditionalEffect = parseConditionalEffect(field.slice(5).trim());
  if (conditionalEffect) option.effects.push(conditionalEffect);
  else option.unknownFields.push(field);
} else if (field.indexOf('变化:') === 0) {
  var effect = parseEffect(field.slice(3).trim());
  if (effect) option.effects.push(effect);
  else option.unknownFields.push(field);
}

option.effects = Array.isArray(source.effects) ? source.effects.map(function (effect) {
  return {
    name: String(effect.name == null ? '' : effect.name).trim(),
    op: effect.op,
    val: String(effect.val == null ? '' : effect.val).trim(),
    condition: effect.condition == null || String(effect.condition).trim() === ''
      ? null : String(effect.condition).trim()
  };
}) : [];

for (var i = 0; i < option.effects.length; i++) {
  var effect = parseEffect(option.effects[i].name + option.effects[i].op + option.effects[i].val);
  if (!effect) return { ok: false, value: null, error: '变量变化格式不正确' };
  if (option.effects[i].condition) {
    if (!getStoryVars().parseCondition(option.effects[i].condition)) {
      return { ok: false, value: null, error: '变量变化的执行条件格式不正确' };
    }
    fields.push('条件变化:(' + option.effects[i].condition + ')=>' + effect.name + effect.op + effect.val);
  } else {
    fields.push('变化:' + effect.name + effect.op + effect.val);
  }
}
```

Update the tag scanner to track parentheses outside quotes. A `>` closes the option only when parenthesis depth is zero and it is not the `>` in `=>`; comparisons inside the required outer parentheses must never end the tag.

The scanner loop must add `depth` and use these branches after quote handling:

```js
if (ch === '(') { depth++; continue; }
if (ch === ')' && depth > 0) { depth--; continue; }
if (ch === '>' && (depth > 0 || text.charAt(i - 1) === '=')) continue;
if (ch === '>' && !isConditionComparator(text, start, i)) { end = i + 1; break; }
```

- [ ] **Step 4: Run focused grammar and conformance tests**

Run:

```powershell
node tests/story-options.test.js
node tests/project-converter.test.js
node tests/var-conformance.test.js
```

Expected: both PASS.

- [ ] **Step 5: Commit the grammar change**

```powershell
git add js/story-options.js tests/story-options.test.js tests/project-converter.test.js
git commit -m "feat: add conditional option effect grammar"
```

### Task 2: Carry effect conditions through visual drafts and validation

**Files:**
- Modify: `tests/visual-story-ui.test.js`
- Modify: `js/story-visual-ui.js`

- [ ] **Step 1: Write failing draft and validation tests**

Add these expectations:

```js
assert.deepEqual(StoryVisualUI.effectDraftToOps([
  { name: '金币', op: '-', value: '10', condition: conditionDraft }
], stateMap), {
  ok: true,
  ops: [{ name: '金币', op: '-', val: '10', condition: '金币>=10 && (已见面==true || 名字 contains "客")' }],
  errors: []
});

const badEffectCondition = StoryVisualUI.effectDraftToOps([
  { name: '金币', op: '-', value: '10', condition: { mode: 'all', rows: [] } }
], stateMap);
assert.equal(badEffectCondition.ok, false);
assert.ok(badEffectCondition.errors.includes('第 1 条变量变化的条件组不能为空'));
```

Test `optionDraftFromOption` indirectly or export it for tests and assert that an effect condition string is converted with `conditionAstToDraft`.

Update the existing unconditional `effectDraftToOps` expectation so every returned option effect explicitly contains `condition: null`.

- [ ] **Step 2: Run the UI test and verify failure**

Run: `node tests/visual-story-ui.test.js`

Expected: FAIL because effect conditions are currently dropped.

- [ ] **Step 3: Implement shared condition validation and effect conversion**

Extract validation into one helper used by both locations:

```js
function validateConditionDraft(draft, states, prefix) {
  var types = stateTypes(states), errors = [];
  function checkGroup(group) {
    if (!group || !Array.isArray(group.rows) || !group.rows.length) {
      errors.push((prefix || '') + '条件组不能为空');
      return;
    }
    group.rows.forEach(function (row) {
      if (row && row.kind === 'group') { checkGroup(row); return; }
      if (!row || !row.name || !types[row.name]) {
        errors.push((prefix || '') + '请选择变量');
        return;
      }
      var type = types[row.name];
      var valid = type === 'number'
        ? ['>', '<', '>=', '<=', '==', '!=', '=']
        : type === 'text'
          ? ['==', '!=', '=', 'contains', 'notcontains']
          : ['==', '!=', '='];
      if (valid.indexOf(row.op) < 0) {
        errors.push((prefix || '') + '变量「' + row.name + '」不能使用此比较');
      }
      if (type === 'number' && !/^-?\d+(\.\d+)?$/.test(String(row.value == null ? '' : row.value))) {
        errors.push((prefix || '') + '变量「' + row.name + '」的比较值不正确');
      }
      if (type === 'boolean' && row.value !== true && row.value !== false && row.value !== 'true' && row.value !== 'false') {
        errors.push((prefix || '') + '变量「' + row.name + '」的比较值不正确');
      }
    });
  }
  if (draft) checkGroup(draft);
  return { ok: errors.length === 0, errors: errors, ast: conditionDraftToAst(draft) };
}
```

In `effectDraftToOps`, define `var SV = getStoryVars();`, change the loop to `effects.forEach(function (effect, index) { ... })`, then validate each `effect.condition` with:

```js
var conditionCheck = validateConditionDraft(
  effect.condition,
  types,
  '第 ' + (index + 1) + ' 条变量变化的'
);
errors = errors.concat(conditionCheck.errors);
```

Serialize the successful condition through `StoryVars.serializeCondition`, and return:

```js
ops.push({
  name: name,
  op: op,
  val: String(value == null ? '' : value),
  condition: conditionCheck.ast ? SV.serializeCondition(conditionCheck.ast) : null
});
```

Update `optionDraftFromOption` to preserve each effect condition:

```js
effects: (source.effects || []).map(function (effect) {
  return {
    name: effect.name,
    op: effect.op,
    value: effect.val,
    condition: effect.condition && SV
      ? conditionAstToDraft(SV.parseCondition(effect.condition), states)
      : null
  };
})
```

Use a blank variable (`name:''`) for newly added condition rows and newly added effects. This is required so action/value controls remain hidden until the user makes a choice.

- [ ] **Step 4: Run focused UI tests**

Run: `node tests/visual-story-ui.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the draft model change**

```powershell
git add js/story-visual-ui.js tests/visual-story-ui.test.js
git commit -m "feat: validate conditions on option effects"
```

### Task 3: Rebuild the condition and effect form UI

**Files:**
- Modify: `tests/visual-story-ui.test.js`
- Modify: `js/story-visual-ui.js`
- Modify: `css/style.css`

- [ ] **Step 1: Add failing interaction-language and theme tests**

Add static assertions for the confirmed labels and structure:

```js
assert.match(visualUiSource, /rowLabel\('选项条件'\)/);
assert.match(visualUiSource, /自然语言翻译：/);
assert.match(visualUiSource, /仅当满足以下/);
assert.match(visualUiSource, /添加执行条件/);
assert.match(visualUiSource, /移除执行条件/);
assert.match(styleSource, /\.story-visual-condition-tree/);
assert.match(styleSource, /body\.dark[\s\S]*?--visual-form-field-bg:/);
assert.doesNotMatch(visualUiSource, /rowLabel\('条件'\)/);
```

- [ ] **Step 2: Run the UI test and verify failure**

Run: `node tests/visual-story-ui.test.js`

Expected: FAIL on the new labels and controls.

- [ ] **Step 3: Extract one reusable recursive renderer**

Inside `renderOptionEditor`, replace the old one-off `renderGroup` with this reusable recursive renderer (keep `makeField`, `types`, `readOnly` and `rerender` from the surrounding form):

```js
function renderConditionTree(group, parent, config) {
  var tree = document.createElement('div');
  tree.className = 'story-visual-condition-tree';
  var header = document.createElement('div');
  header.className = 'story-visual-condition-header';
  var prefix = document.createElement('span');
  prefix.textContent = config.prefixText || '满足以下';
  var mode = makeField('select', group.mode, [
    ['all', '全部条件'], ['any', '任意条件']
  ], readOnly);
  mode.addEventListener('change', function () { group.mode = mode.value; rerender(); });
  header.append(prefix, mode);
  if (!readOnly && config.onRemove) {
    var removeGroup = document.createElement('button');
    removeGroup.type = 'button';
    removeGroup.textContent = config.removeText || '删除条件组';
    removeGroup.addEventListener('click', config.onRemove);
    header.appendChild(removeGroup);
  }
  tree.appendChild(header);

  group.rows.forEach(function (row, index) {
    if (row.kind === 'group') {
      renderConditionTree(row, tree, {
        prefixText: '满足以下',
        removeText: '删除条件组',
        onRemove: function () { group.rows.splice(index, 1); rerender(); }
      });
      return;
    }
    var line = document.createElement('div');
    line.className = 'story-visual-condition-row';
    var name = makeField('select', row.name, [['', '选择变量']].concat(
      Object.keys(types).map(function (key) { return [key, key]; })
    ), readOnly);
    name.addEventListener('change', function () {
      row.name = name.value;
      row.op = types[row.name] === 'number' ? '>=' : '=';
      row.value = types[row.name] === 'boolean' ? true : '';
      rerender();
    });
    line.appendChild(name);

    if (name.value && types[name.value] === 'boolean') {
      var boolValue = makeField('select', String(row.value), [
        ['true', '为是'], ['false', '为否']
      ], readOnly);
      boolValue.addEventListener('change', function () {
        row.op = '=';
        row.value = boolValue.value === 'true';
        rerender();
      });
      line.appendChild(boolValue);
    } else if (name.value) {
      var opChoices = types[name.value] === 'number'
        ? [['>=', '不少于'], ['<=', '不多于'], ['>', '大于'], ['<', '小于'], ['=', '等于'], ['!=', '不等于']]
        : [['=', '等于'], ['!=', '不等于'], ['contains', '包含'], ['notcontains', '不包含']];
      var op = makeField('select', row.op, opChoices, readOnly);
      var value = makeField('input', row.value, null, readOnly);
      op.addEventListener('change', function () { row.op = op.value; rerender(); });
      value.addEventListener('input', function () { row.value = value.value; });
      line.append(op, value);
    }

    if (!readOnly) {
      var removeRow = document.createElement('button');
      removeRow.type = 'button';
      removeRow.textContent = '删除';
      removeRow.addEventListener('click', function () { group.rows.splice(index, 1); rerender(); });
      line.appendChild(removeRow);
    }
    tree.appendChild(line);
  });

  if (!readOnly) {
    var actions = document.createElement('div');
    actions.className = 'story-visual-condition-actions';
    var addCondition = document.createElement('button');
    addCondition.type = 'button';
    addCondition.textContent = '添加条件';
    addCondition.addEventListener('click', function () {
      group.rows.push({ kind: 'comparison', name: '', op: '', value: '' });
      rerender();
    });
    var addGroup = document.createElement('button');
    addGroup.type = 'button';
    addGroup.textContent = '添加条件组';
    addGroup.addEventListener('click', function () {
      group.rows.push({ kind: 'group', mode: 'all', rows: [] });
      rerender();
    });
    actions.append(addCondition, addGroup);
    tree.appendChild(actions);
  }
  parent.appendChild(tree);
}
```

Add a pure helper for translations so incomplete rows never produce a misleading sentence:

```js
function conditionNaturalText(draftCondition, states) {
  var types = stateTypes(states), leaf = 0, incomplete = 0;
  function visit(group) {
    if (!group || !Array.isArray(group.rows) || !group.rows.length) return false;
    group.rows.forEach(function (row) {
      if (row && row.kind === 'group') { if (!visit(row) && !incomplete) incomplete = leaf + 1; return; }
      leaf++;
      if (!row || !row.name || !types[row.name] || !row.op) { if (!incomplete) incomplete = leaf; return; }
      if (types[row.name] === 'number' && !/^-?\d+(\.\d+)?$/.test(String(row.value == null ? '' : row.value))) {
        if (!incomplete) incomplete = leaf;
      }
      if (types[row.name] === 'boolean' && row.value !== true && row.value !== false) {
        if (!incomplete) incomplete = leaf;
      }
    });
    return true;
  }
  if (!visit(draftCondition)) return { ok: false, text: '请先添加一条条件。' };
  if (incomplete) return { ok: false, text: '请完成第 ' + incomplete + ' 条条件。' };
  var SV = getStoryVars(), ast = conditionDraftToAst(draftCondition);
  return { ok: true, text: SV.summarizeCondition(ast, types) };
}
```

Use it once under `rowLabel('选项条件')` and once under each effect that has `effect.condition`.

For each effect with a selected variable:

```js
var conditionToggle = document.createElement('button');
conditionToggle.type = 'button';
conditionToggle.textContent = effect.condition ? '移除执行条件' : '添加执行条件';
conditionToggle.addEventListener('click', function () {
  effect.condition = effect.condition ? null : { mode: 'all', rows: [
    { kind: 'comparison', name: '', op: '', value: '' }
  ] };
  rerender();
});
```

Render `自然语言翻译：` beneath the option condition and each effect. Use `StoryVars.summarizeCondition` for complete ASTs. For incomplete structures display the exact validation prompt rather than a partial statement. Effect summaries must be:

```js
conditionSummary
  ? '自然语言翻译：当' + conditionSummary + '时，' + effectSummary + '。'
  : '自然语言翻译：选中后，' + effectSummary + '。';
```

Boolean comparison rows must use a select for “是/否” and must not render a free-text value input.

When `unknownFields` contains a string beginning with `条件变化:`, replace the generic read-only message with `条件变量变化格式不正确，请在源码模式修复` while preserving the raw field unchanged.

- [ ] **Step 4: Add quiet light/dark CSS**

Define neutral form tokens and a tree layout in `css/style.css`:

```css
:root {
  --visual-form-field-bg: #fbfcfa;
  --visual-form-field-fg: #26302b;
  --visual-form-field-border: #cfd8d2;
  --visual-tree-line: #c9d1cc;
}
body.dark {
  --visual-form-field-bg: #202723;
  --visual-form-field-fg: #e3e9e5;
  --visual-form-field-border: #465149;
  --visual-tree-line: #536058;
}
.story-visual-condition-tree {
  margin: 10px 0 0 10px;
  padding-left: 14px;
  border-left: 1px solid var(--visual-tree-line);
}
.story-visual-condition-row,
.story-visual-effect-main { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.story-visual-option-form input,
.story-visual-option-form select {
  color: var(--visual-form-field-fg);
  background: var(--visual-form-field-bg);
  border-color: var(--visual-form-field-border);
}
```

Do not add card shadows or colored backgrounds to nested groups. Keep variable controls within the existing subdued green family.

- [ ] **Step 5: Run focused UI tests**

Run: `node tests/visual-story-ui.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the form UI**

```powershell
git add js/story-visual-ui.js css/style.css tests/visual-story-ui.test.js
git commit -m "feat: add tree editor for option conditions"
```

### Task 4: Apply conditional effects from a pre-click snapshot

**Files:**
- Modify: `tests/story-options.test.js`
- Modify: `tests/visual-options-runtime.test.js`
- Modify: `js/story-options.js`
- Modify: `js/exporter.js`

- [ ] **Step 1: Write failing selection and runtime tests**

Add a DOM-free shared selection test:

```js
const before = { 勇气: 0, 金币: 0 };
const selected = StoryOptions.selectEffects([
  { name: '勇气', op: '+', val: '1', condition: null },
  { name: '金币', op: '+', val: '10', condition: '勇气>=1' }
], (name) => before[name]);
assert.deepEqual(selected, [{ name: '勇气', op: '+', val: '1' }]);
```

Update the runtime source assertions to require:

```js
assert.match(exporterSrc, /const snapshot = Object\.assign\(\{\}, vars\);/);
assert.match(exporterSrc, /StoryOptions\.selectEffects/);
assert.match(exporterSrc, /applyVarOps\(selectedEffects\)/);
```

Update export parsing expectation so old effects contain `condition:null`, then add a conditional effect case.

- [ ] **Step 2: Run focused runtime tests and verify failure**

Run:

```powershell
node tests/story-options.test.js
node tests/visual-options-runtime.test.js
```

Expected: FAIL because `selectEffects` and snapshot filtering do not exist.

- [ ] **Step 3: Add shared effect selection**

In `js/story-options.js`:

```js
function selectEffects(effects, getVar) {
  var SV = getStoryVars(), selected = [];
  (Array.isArray(effects) ? effects : []).forEach(function (effect) {
    if (!effect || !effect.name || !effect.op) return;
    if (effect.condition && (!SV || !SV.evalCondition(effect.condition, getVar))) return;
    selected.push({ name: effect.name, op: effect.op, val: effect.val });
  });
  return selected;
}
```

Export it from `StoryOptions` and include it in `buildRuntimeSource()`.

In the normal click path in `js/exporter.js`:

```js
if (opt.effects && opt.effects.length && (!opt.block || Object.prototype.hasOwnProperty.call(DATA.blocks || {}, opt.block))) {
  const snapshot = Object.assign({}, vars);
  const selectedEffects = StoryOptions.selectEffects(opt.effects, function(name){ return snapshot[name]; });
  if (selectedEffects.length) applyVarOps(selectedEffects);
}
```

Do not add effect application to `fastReplay`.

- [ ] **Step 4: Run grammar, runtime and variable conformance tests**

Run:

```powershell
node tests/story-options.test.js
node tests/visual-options-runtime.test.js
node tests/var-conformance.test.js
node tests/story-vars.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit snapshot execution**

```powershell
git add js/story-options.js js/exporter.js tests/story-options.test.js tests/visual-options-runtime.test.js
git commit -m "feat: evaluate option effects from a state snapshot"
```

### Task 5: Update author documentation

**Files:**
- Modify: `tests/visual-story-ui.test.js`
- Modify: `docs.html`

- [ ] **Step 1: Add failing documentation assertions**

Add these assertions beside the existing documentation coverage:

```js
assert.match(docs, /条件变化:/, '高级源码参考必须解释条件变量变化');
assert.match(docs, /点击选项前的变量状态/, '文档必须说明快照判断语义');
```

- [ ] **Step 2: Run the documentation test and verify failure**

Run: `node tests/visual-story-ui.test.js`

Expected: FAIL because `docs.html` does not yet mention `条件变化:`.

- [ ] **Step 3: Add the advanced source reference**

In the existing option/variable advanced reference in `docs.html`, add:

```html
<h4>只在满足条件时改变变量</h4>
<pre><code>&lt;选项:"鼓起勇气购买",商店,条件变化:(勇气&gt;=1)=&gt;金币-10&gt;</code></pre>
<p><code>变化:</code> 每次选中都会执行；<code>条件变化:</code> 只在括号内条件满足时执行。多条变化的条件都按点击选项前的变量状态判断。</p>
```

Do not lead the beginner sections with source syntax.

- [ ] **Step 4: Run the visual documentation test**

Run: `node tests/visual-story-ui.test.js`

Expected: PASS.

- [ ] **Step 5: Commit documentation coverage**

```powershell
git add docs.html tests/visual-story-ui.test.js
git commit -m "docs: explain conditional option effects"
```

### Task 6: Release metadata, full verification and beta build

**Files:**
- Modify: `index.html`
- Modify: `tests/release-cache-bust.test.js`
- Generated (ignored): `dist-test/index.html`
- Generated (ignored): `dist-test/docs.html`

- [ ] **Step 1: Write the failing release assertion**

Change the exact expected version to `v25.4.79` and require new cache keys for every changed front-end asset:

```js
assert.match(html, /id="app-version">v25\.4\.79</);
assert.match(html, /css\/style\.css\?v=20260827-12/);
assert.match(html, /js\/story-options\.js\?v=20260827-03/);
assert.match(html, /js\/story-visual-ui\.js\?v=20260827-12/);
assert.match(html, /js\/exporter\.js\?v=20260827-03/);
```

- [ ] **Step 2: Run the release test and verify failure**

Run: `node tests/release-cache-bust.test.js`

Expected: FAIL against v25.4.78 and the old cache keys.

- [ ] **Step 3: Bump app metadata and cache keys**

In `index.html`, set both visible version locations to `v25.4.79` and update only the changed asset query strings to the values asserted above.

- [ ] **Step 4: Run every test**

Run:

```powershell
$failed = @()
Get-ChildItem tests\*.test.js | Sort-Object Name | ForEach-Object {
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { $failed += $_.Name }
}
if ($failed.Count) { throw "Failed tests: $($failed -join ', ')" }
```

Expected: all test files print their `passed` message and the command exits 0.

- [ ] **Step 5: Build the isolated beta artifact**

Run: `python build_inline.py --test`

Expected: exit 0 and updated self-contained files under `dist-test/`.

- [ ] **Step 6: Verify built artifact markers**

Run:

```powershell
Select-String -Path dist-test\index.html -Pattern "STORY_EDITOR_NS='test'",'v25.4.79','条件变化:'
```

Expected: all three patterns are found.

- [ ] **Step 7: Commit release metadata**

```powershell
git add index.html tests/release-cache-bust.test.js
git commit -m "chore: release conditional option effects beta"
```

- [ ] **Step 8: Perform manual light/dark smoke checks**

Open the test build and verify:

1. Create one nested option condition, delete a child group, and confirm “自然语言翻译：” updates.
2. Add one unconditional and one conditional variable change; confirm the latter expands below its own row.
3. Leave a new variable unselected; confirm action/value/condition controls remain hidden.
4. Switch light/dark themes; confirm input text, backgrounds, borders and tree lines are readable.
5. Preview an option with two effects where the first changes a variable used by the second condition; confirm the second uses the pre-click value.
6. Switch source/visual/source and confirm `变化:` plus `条件变化:` survive without unrelated rewriting.
