# Visual Story State Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-compatible visual editor for story options and story state so non-programmers can create conditions and state changes without seeing syntax.

**Architecture:** Story source text remains the only persisted source of truth. Shared pure modules parse options, conditions, state operations, and document spans; visual mode renders those nodes and applies validated source-range patches. Preview, playtest, and exported HTML consume the same shared semantics.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, browser DOM APIs, localStorage, IndexedDB, Node.js `assert`, Node.js `vm`, existing Python inline build script.

---

## 0. Execution baseline and file map

Implementation must start from commit `950668f` on `feature/story-vars`, because that branch contains the tested `StoryVars` single-source implementation. The design and this plan live on master commits and must be cherry-picked into the implementation branch.

Create or modify these files only for the responsibilities listed here:

| File | Responsibility |
|---|---|
| `js/story-vars.js` | Condition AST, typed comparison, state operation semantics, runtime-source injection |
| `js/story-options.js` | One authoritative option parser/serializer, new optional fields, summaries |
| `js/story-visual-doc.js` | Lossless document scanning, source spans, node replacement |
| `js/story-visual-ui.js` | Visual/source mode controller and visual editing DOM |
| `js/project-converter.js` | Conversion analysis, report construction, pure naming helpers |
| `js/exporter.js` | Consume shared option parser; present disabled options; apply effects before jump |
| `js/editor.js` | Wire modules into existing editor, state library safety, project-screen entry points |
| `js/storage.js` | Transaction-like project snapshot/copy/cleanup APIs |
| `index.html` | Mode switch, visual editor host, script ordering, conversion modal |
| `css/style.css` | Quiet text-editor visual styling and accessible light/dark contrast |
| `docs.html` | Quick start, recipes, advanced source mapping, conversion guide |
| `tests/story-vars.test.js` | Condition AST and typed comparison tests |
| `tests/story-options.test.js` | Option grammar and serialization tests |
| `tests/story-visual-doc.test.js` | Lossless scanning and patch tests |
| `tests/visual-story-ui.test.js` | Static DOM/API contract tests for visual mode |
| `tests/project-converter.test.js` | Conversion naming/report and retry behavior tests |
| `tests/visual-runtime-conformance.test.js` | Editor/export runtime semantic parity |
| `tests/release-cache-bust.test.js` | Exact version and new script cache assertions |

Do not add npm dependencies. All tests must continue to run with plain Node.

### Task 1: Create an isolated implementation branch

**Files:**
- No product files changed in this task.

- [ ] **Step 1: Read the worktree skill before creating the implementation workspace**

Run:

```powershell
Get-Content -Raw 'C:\Users\z1x2c\.agents\skills\using-git-worktrees\SKILL.md'
```

Expected: the full skill instructions are printed.

- [ ] **Step 2: Create a worktree from the tested variable branch**

Use the verified sibling path below. The branch name must be `codex/visual-story-state` and its base must be `feature/story-vars`.

Run from the repository root:

```powershell
git worktree add 'C:\CH_ZAWU\vibecoding工具\剧情编辑器-visual-story-state' -b codex/visual-story-state feature/story-vars
```

Expected: a new worktree at commit `950668f`.

- [ ] **Step 3: Bring the approved documentation into the branch**

Run inside the new worktree:

```powershell
git cherry-pick dbd318f..master
```

Expected: the design and this implementation plan exist under `docs/superpowers/`.

- [ ] **Step 4: Prove the baseline is green**

Run:

```powershell
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName }
```

Expected: every current test prints its `passed` message and the command exits 0.

### Task 2: Extend StoryVars with public condition AST and typed operators

**Files:**
- Modify: `js/story-vars.js:130-306,528-547`
- Modify: `tests/story-vars.test.js`

- [ ] **Step 1: Add failing AST round-trip and string-operator tests**

Append tests that require these public functions:

```js
const ast = StoryVars.parseCondition('(金币>=10 && 见过商人) || 声望>=20');
assert.equal(ast.k, 'or');
assert.equal(StoryVars.serializeCondition(ast), '(金币>=10 && 见过商人) || 声望>=20');
assert.equal(StoryVars.summarizeCondition(ast, {
  金币: 'number', 见过商人: 'boolean', 声望: 'number'
}), '金币不少于 10 且见过商人是“是”，或者声望不少于 20');

const textVars = { 身份: '皇家贵宾' };
assert.equal(StoryVars.evalCondition('身份 contains "贵宾"', n => textVars[n]), true);
assert.equal(StoryVars.evalCondition('身份 notcontains "平民"', n => textVars[n]), true);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node tests/story-vars.test.js
```

Expected: FAIL because `serializeCondition` and `summarizeCondition` do not exist or `contains` cannot tokenize.

- [ ] **Step 3: Implement the public APIs in StoryVars**

Add named functions with these contracts and keep recursive helpers private:

```js
function serializeCondition(ast) {
  function walk(n, parentPrec) {
    if (!n) return '';
    if (n.k === 'true') return 'true';
    if (n.k === 'bare') return n.name;
    if (n.k === 'cmp') return n.name + n.op + serializeConditionValue(n.val);
    if (n.k === 'not') return '!' + walk(n.e, 3);
    var prec = n.k === 'and' ? 2 : 1;
    var op = n.k === 'and' ? ' && ' : ' || ';
    var body = walk(n.l, prec) + op + walk(n.r, prec);
    return prec < parentPrec ? '(' + body + ')' : body;
  }
  return walk(ast, 0);
}

function summarizeCondition(ast, typeMap) {
  function walk(n, parentPrec) {
    if (n.k === 'bare') return n.name + '是“是”';
    if (n.k === 'cmp') return summarizeComparison(n, typeMap || {});
    if (n.k === 'not') return '不是（' + walk(n.e, 0) + '）';
    var prec = n.k === 'and' ? 2 : 1;
    var glue = n.k === 'and' ? ' 且 ' : '，或者';
    var body = walk(n.l, prec) + glue + walk(n.r, prec);
    return prec < parentPrec ? '（' + body + '）' : body;
  }
  return walk(ast, 0);
}
function validateConditionTypes(ast, typeMap) {
  return { ok: true, errors: [] };
}
```

Implement private `serializeConditionValue` and `summarizeComparison` in the same file. `serializeConditionValue` emits numbers and booleans without quotes and escapes text with straight double quotes. `summarizeComparison` maps `>= <= > < == != contains notcontains` to `不少于/不多于/大于/小于/等于/不等于/包含/不包含`. Replace the temporary always-success body of `validateConditionTypes` with a recursive validator before the focused test is rerun; its final result is `{ok:errors.length===0, errors}`.

Extend tokenizer and comparison evaluation with exact source tokens `contains` and `notcontains`. They are binary comparison operators and only valid for declared text states. `compareVals` must implement them with `String(lv).indexOf(String(rv))`.

Export all three functions from `StoryVars`. Add them to `RUNTIME_FNS` only if the exported player runtime directly needs them; the runtime must at least receive the updated tokenizer/comparison functions through `buildRuntimeSource()`.

- [ ] **Step 4: Run focused and conformance tests**

Run:

```powershell
node tests/story-vars.test.js
node tests/var-conformance.test.js
```

Expected: both pass.

- [ ] **Step 5: Commit the semantic extension**

```powershell
git add js/story-vars.js tests/story-vars.test.js
git commit -m "feat: extend visual condition semantics"
```

### Task 3: Add the authoritative option grammar

**Files:**
- Create: `js/story-options.js`
- Create: `tests/story-options.test.js`
- Modify: `index.html:410-419`
- Modify: `tests/release-cache-bust.test.js`

- [ ] **Step 1: Write the complete option grammar tests**

Create `tests/story-options.test.js` with assertions for:

```js
const assert = require('node:assert/strict');
const StoryOptions = require('../js/story-options.js');

const source = '<选项:"购买钥匙",商店,条件:(金币>=10),不满足:禁用,提示:"需要 10 金币",变化:金币-10,变化:拿到钥匙=true>';
const parsed = StoryOptions.parseOptionTag(source);
assert.equal(parsed.ok, true);
assert.equal(parsed.option.text, '购买钥匙');
assert.equal(parsed.option.block, '商店');
assert.equal(parsed.option.condition, '(金币>=10)');
assert.equal(parsed.option.unmetBehavior, 'disable');
assert.equal(parsed.option.unmetMessage, '需要 10 金币');
assert.deepEqual(parsed.option.effects, [
  { name: '金币', op: '-', val: '10' },
  { name: '拿到钥匙', op: '=', val: 'true' },
]);
assert.deepEqual(StoryOptions.serializeOption(parsed.option), { ok: true, value: source, error: null });

const unknown = StoryOptions.parseOptionTag('<选项:"A",块A,未来字段:保留>');
assert.equal(unknown.ok, true);
assert.deepEqual(unknown.option.unknownFields, ['未来字段:保留']);

const line = '前缀 <选项:"A",块A> <选项:"B",块B,条件:金币>=2> 后缀';
const matches = StoryOptions.extractOptionLine(line);
assert.equal(matches.length, 2);
assert.equal(line.slice(matches[0].start, matches[0].end), '<选项:"A",块A>');
assert.equal(line.slice(matches[1].start, matches[1].end), '<选项:"B",块B,条件:金币>=2>');

assert.equal(StoryOptions.parseOptionTag('<选项:"未闭合,块>').ok, false);
console.log('story-options.test.js passed');
```

- [ ] **Step 2: Verify the new test fails**

Run `node tests/story-options.test.js`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `js/story-options.js` as a UMD-style pure module**

The public object must contain exactly these APIs:

```js
{
  splitTopLevelFields,
  parseOptionTag,
  extractOptionLine,
  serializeOption,
  summarizeOption,
  normalizeOption,
}
```

`splitTopLevelFields` must track quote type, backslash escape, and parenthesis depth. `parseOptionTag` must normalize `隐藏/禁用` to `hide/disable`, parse every `变化:` through `StoryVars.parseVarLine('<变量:' + body + '>')`, and preserve unknown fields. `serializeOption` always returns `{ ok, value, error }`. Success is `{ ok:true, value:'<选项:...>', error:null }`. Options with unknown fields return `{ ok:false, value:null, error:'包含无法识别的高级字段' }`. Do not add a destructive serializer in this release.

The browser global is `window.StoryOptions`; CommonJS export is `module.exports`.

- [ ] **Step 4: Load the shared module before exporter and editor**

Insert in `index.html` after `story-vars.js`:

```html
<script src="js/story-options.js?v=20260827-01"></script>
```

Update the exact cache assertion test with the same version.

- [ ] **Step 5: Run and commit**

Run:

```powershell
node tests/story-options.test.js
node tests/release-cache-bust.test.js
```

Expected: PASS.

Commit:

```powershell
git add js/story-options.js tests/story-options.test.js index.html tests/release-cache-bust.test.js
git commit -m "feat: add shared visual option grammar"
```

### Task 4: Make editor parsing and export runtime consume StoryOptions

**Files:**
- Modify: `js/editor.js:122-156,249-296,320-395,5860-6035`
- Modify: `js/exporter.js:1918-1955,2490-2615,2780-2790`
- Create: `tests/visual-runtime-conformance.test.js`
- Modify: `tests/option-condition.test.js`

- [ ] **Step 1: Write failing parser/runtime conformance tests**

Test that `parseStoryForExport` produces:

```js
{
  type: 'options',
  options: [{
    text: '购买钥匙',
    block: '商店',
    condition: '金币>=10',
    unmetBehavior: 'disable',
    unmetMessage: '需要 10 金币',
    effects: [
      { name: '金币', op: '-', val: '10' },
      { name: '拿到钥匙', op: '=', val: 'true' },
    ],
  }],
}
```

Also statically assert that both editor parsing and exporter parsing call `StoryOptions.extractOptionLine` and no longer define local `extractOptionLine`/`splitOptionExtra` functions.

- [ ] **Step 2: Verify failure**

Run:

```powershell
node tests/option-condition.test.js
node tests/visual-runtime-conformance.test.js
```

Expected: FAIL because local parsers remain and new fields are dropped.

- [ ] **Step 3: Replace local option parsing**

In editor and exporter, use:

```js
const parsed = window.StoryOptions.extractOptionLine(t);
const options = parsed.filter(x => x.ok).map(x => x.option);
```

All consumers—preview summary, block graph, rename logic, validation, export parser—must read the normalized option object. Do not retain a fallback local regex.

- [ ] **Step 4: Implement runtime disabled options and effects**

In `presentOptions(n)`:

```js
const conditionMet = !opt.condition || evalCond(opt.condition);
if (!conditionMet && opt.unmetBehavior !== 'disable') return;

btn.disabled = !conditionMet;
if (!conditionMet && opt.unmetMessage) btn.title = opt.unmetMessage;
if (!conditionMet) btn.classList.add('is-disabled');
```

The click handler must return immediately when disabled. Before applying effects, verify the target block exists when `opt.block` is present. Apply effects with `applyVarOps(opt.effects || [])`, then record the choice and jump. Replay logic for saved choices must apply the same effects exactly once during reconstruction.

- [ ] **Step 5: Run all semantic tests and commit**

Run:

```powershell
node tests/story-options.test.js
node tests/option-condition.test.js
node tests/visual-runtime-conformance.test.js
node tests/var-conformance.test.js
```

Expected: PASS.

Commit the four files with message `feat: run visual options through shared runtime`.

### Task 5: Add a lossless visual-document scanner and patcher

**Files:**
- Create: `js/story-visual-doc.js`
- Create: `tests/story-visual-doc.test.js`
- Modify: `index.html`
- Modify: `tests/release-cache-bust.test.js`

- [ ] **Step 1: Write failing span and no-op round-trip tests**

The test fixture must include CRLF, blank lines, ordinary commands, options, variables, player input, interpolation, and malformed option source. Assert:

```js
const source = '正文\r\n\r\n<召唤背景:村口>\r\n<选项:"A",块A><选项:"B",块B>\r\n<变量:金币+1>\r\n坏行 <选项:"未闭合\r\n';
const doc = VisualDoc.scan(source);
assert.equal(doc.source, source);
assert.equal(VisualDoc.serializeUnchanged(doc), source);
assert.ok(doc.nodes.some(n => n.kind === 'option_group'));
assert.ok(doc.nodes.some(n => n.kind === 'state_change'));
assert.ok(doc.nodes.some(n => n.kind === 'source_error'));

const optionNode = doc.nodes.find(n => n.kind === 'option_group');
const patched = VisualDoc.replaceNode(source, optionNode, '<选项:"改名",块A>');
assert.equal(patched.slice(0, optionNode.start), source.slice(0, optionNode.start));
assert.equal(patched.slice(optionNode.start + '<选项:"改名",块A>'.length), source.slice(optionNode.end));
```

- [ ] **Step 2: Verify module-not-found failure**

Run `node tests/story-visual-doc.test.js`.

- [ ] **Step 3: Implement the pure scanner**

Export:

```js
{
  scan,
  serializeUnchanged,
  replaceNode,
  findNodeAtOffset,
  summarizeDiagnostics,
}
```

Every node has `{kind,start,end,raw,data,diagnostics}`. Split lines while retaining separators. Group consecutive plain text into text nodes, but keep exact raw slices. A full line made only of one or more valid `<变量:...>` tags is `state_change`. `<玩家输入变量:...>` is also a state node. Lines with valid options become `option_group`; malformed option-like lines become `source_error`; other `<...>` commands remain `raw_command`.

`replaceNode` must throw if `source.slice(node.start,node.end) !== node.raw`.

- [ ] **Step 4: Load the module before the UI module**

Add `story-visual-doc.js?v=20260827-01` after `story-options.js` and update cache assertions.

- [ ] **Step 5: Run and commit**

Run the new test plus `release-cache-bust.test.js`; commit as `feat: add lossless visual story document model`.

### Task 6: Add the visual/source mode shell

**Files:**
- Create: `js/story-visual-ui.js`
- Create: `tests/visual-story-ui.test.js`
- Modify: `index.html:111-143,410-419`
- Modify: `css/style.css`
- Modify: `js/editor.js` near initialization, `switchBlock`, and `commitEdit`

- [ ] **Step 1: Add failing static UI-contract tests**

Assert that `index.html` contains:

```html
<button id="editor-mode-visual" type="button">可视化编辑</button>
<button id="editor-mode-source" type="button">源码模式</button>
<div id="story-visual-editor" class="story-visual-editor" hidden></div>
```

Assert that `story-visual-ui.js` exports `createController`, `renderDocument`, `commitFocusedEditor`, and `destroy` in CommonJS mode.

- [ ] **Step 2: Verify the contract test fails**

Run `node tests/visual-story-ui.test.js`.

- [ ] **Step 3: Add exact DOM hosts and script order**

Place the mode switch in `.col-head-left` after the current block chip. Place the visual host beside `#editor-text-wrap`, inside `#editor-body`. Load `story-visual-ui.js` after `story-visual-doc.js` and before `editor.js`.

- [ ] **Step 4: Implement the controller boundary**

`createController` receives callbacks instead of touching Storage directly:

```js
const visualController = window.StoryVisualUI.createController({
  sourceTextarea: storyText,
  visualHost: document.getElementById('story-visual-editor'),
  getSource: () => storyText.value,
  setSource: (next) => { storyText.value = next; commitEdit(); },
  getStates: () => window.Storage.getVars(),
  getBlocks: () => window.Storage.listBlockNames(),
  onDiagnostic: issue => openCompileIssue(issue),
});
```

Switching to visual mode calls `commitFocusedEditor()`, scans current source, hides the source wrapper, shows visual host, and renders. Switching to source mode commits visual edits, reveals the textarea, and restores selection near the last node span. Store preference under a namespaced UI key, not project data.

- [ ] **Step 5: Add quiet text-editor CSS and commit**

CSS requirements are executable acceptance rules: no background on plain text nodes; option groups use only `border-left:2px solid var(--border)` and padding; empty summaries do not render; edit buttons have opacity below 0.45 until hover/focus; form elements explicitly set foreground/background in light and dark themes.

Run static tests and all existing tests, then commit `feat: add visual story editor mode shell`.

### Task 7: Render editable text, state tokens, and independent state changes

**Files:**
- Modify: `js/story-visual-ui.js`
- Modify: `css/style.css`
- Modify: `tests/visual-story-ui.test.js`
- Modify: `tests/story-visual-doc.test.js`

- [ ] **Step 1: Add failing renderer tests against pure render descriptors**

Do not require a browser DOM in Node. Add `describeNode(node, stateMap)` returning descriptors. Assert:

```js
assert.deepEqual(describeNode({kind:'state_change', data:{effects:[{name:'金币',op:'-',val:'10'}]}}, {金币:'number'}), {
  kind: 'state_change',
  summary: '金币减少 10',
  editable: true,
});
```

Assert text interpolation descriptors recognize `{金币}` and `{拿到钥匙:已打开|仍锁着}` while `{{金币}}` remains literal text.

- [ ] **Step 2: Verify failure**

Run the two focused tests.

- [ ] **Step 3: Implement text-node editing and inline state tokens**

Render text nodes as visually continuous editable regions. Inline state tokens use `contenteditable="false"`, store the exact raw source in `data-source`, and can be selected/deleted as one unit. On text-node blur or explicit commit, reconstruct only that node raw, replace its span, rescan, and rerender.

The slash command may be implemented after basic toolbar insertion, but the right-side state action “插入到正文” must work in this task.

- [ ] **Step 4: Implement state-change rows**

Render only their non-empty human summary. Clicking opens the state-effect editor. Removing the final effect removes the full node and its line without leaving a blank variable tag.

- [ ] **Step 5: Run, manually smoke-test, and commit**

Open `index.html`, type text around a token, delete a token, switch modes, and verify source is intact. Run focused and full tests. Commit `feat: render visual story state nodes`.

### Task 8: Build option, condition, and effect editors

**Files:**
- Modify: `js/story-visual-ui.js`
- Modify: `css/style.css`
- Modify: `tests/visual-story-ui.test.js`
- Modify: `tests/story-options.test.js`

- [ ] **Step 1: Add failing pure form-state tests**

Expose and test:

```js
createEmptyOption(blocks)
validateOptionDraft(draft, stateMap, blocks)
conditionAstToDraft(ast, stateMap)
conditionDraftToAst(draft)
effectDraftToOps(draft, stateMap)
```

Required validation messages include exact Chinese text for empty button text, missing target block, duplicate/unknown state, invalid operation for type, empty condition group, and unknown option fields.

- [ ] **Step 2: Verify focused tests fail**

Run `node tests/visual-story-ui.test.js`.

- [ ] **Step 3: Implement the option editor**

The editor fields are: button text, target block, optional condition, unmet behavior, optional disabled message, ordered effects. “创建剧情块” and “新建剧情状态” return to the current draft and select the new object. Unknown fields make the visual form read-only and show “此选项包含无法识别的高级字段，请在源码模式编辑”.

- [ ] **Step 4: Implement recursive condition groups**

Each group has mode `all` or `any`; each row is a comparison or child group. Type controls determine operators. The completion button is disabled for empty groups or type errors. Always show the summary produced by `StoryVars.summarizeCondition`.

- [ ] **Step 5: Implement effect editing and source replacement**

Effects are ordered. Numeric: increase/decrease/set. Boolean: set true/false. Text: set/player input. Serialize through `StoryOptions.serializeOption`; require `result.ok === true`, then patch with `result.value`. Patch only the selected option-group node and rescan after success. On any failure restore the old source and keep the form open with an error.

- [ ] **Step 6: Run and commit**

Run all visual, option, condition, and conformance tests. Commit `feat: add visual option and condition editors`.

### Task 9: Make story-state management preventive and atomic

**Files:**
- Modify: `js/editor.js:2761-3092`
- Modify: `js/story-visual-doc.js`
- Modify: `tests/story-visual-doc.test.js`
- Create: `tests/story-state-management.test.js`

- [ ] **Step 1: Add failing reference-index tests**

Add a pure `buildStateReferenceIndex(blockMap, states)` that returns every read, condition, effect, standalone change, and player-input reference with block and line. Test duplicate names, rename preview counts, deletion blocking, and incompatible type-change reports.

- [ ] **Step 2: Verify failure**

Run `node tests/story-state-management.test.js`.

- [ ] **Step 3: Implement preventive create/edit validation**

Replace alert-only behavior with inline validation. User-visible labels are `数字`, `是 / 否`, `文字`. Keep stored types `number`, `boolean`, `text`. Numeric values must be finite. Empty and duplicate names cannot save.

- [ ] **Step 4: Implement atomic rename and guarded delete/type change**

Build all rewritten block strings in memory first. Validate every result. Only then write all blocks and the state library. If any validation fails, write nothing. Used states cannot be deleted. Incompatible type changes show all references and remain unsaved.

- [ ] **Step 5: Run and commit**

Run state management, visual document, option, and existing variable tests. Commit `feat: make story state management safe`.

### Task 10: Add retryable project-copy conversion

**Files:**
- Create: `js/project-converter.js`
- Create: `tests/project-converter.test.js`
- Modify: `js/storage.js:138-223,630-700`
- Modify: `js/editor.js:1419-1515`
- Modify: `index.html`
- Modify: `css/style.css`

- [ ] **Step 1: Add failing pure conversion-report tests**

Test `nextConvertedName`, `analyzeProjectSnapshot`, and `buildConversionReport`. Required name sequence: `迷雾村（可视化版）`, then `迷雾村（可视化版 2）`. Reports include converted option/state/effect counts, issues with block/line, and `lostContentCount:0`.

- [ ] **Step 2: Add failing storage transaction tests with an in-memory adapter**

Define `copyProjectForVisual(sourceId, requestedName, adapter)` so tests can inject failures. Assert the project registry is unchanged when asset copy or validation throws, temporary keys are removed, the source snapshot is unchanged, and retry succeeds.

- [ ] **Step 3: Implement snapshot/copy/commit storage APIs**

Add:

```js
readProjectSnapshot(projectId)
writeTemporaryProject(snapshot, targetId)
validateTemporaryProject(targetId)
registerTemporaryProject(targetId, name, metadata)
cleanupTemporaryProject(targetId)
copyProjectForVisual(sourceId, requestedName)
```

Do not change `_projectId` during conversion. Registration is the final operation. Metadata on the new project includes `visualEditorVersion:1` and `convertedFrom:sourceId`; the source project receives no marker.

- [ ] **Step 4: Add both UI entry points**

Project cards for game projects without `visualEditorVersion` show “转换为可视化项目”. The first old-project open shows one dismissible hint keyed by project ID in namespaced UI preferences. Both open the same modal and service. Failure leaves the button available. Success opens the new project and report.

- [ ] **Step 5: Run and commit**

Run converter and all storage-related tests, then commit `feat: add retryable visual project conversion`.

### Task 11: Update documentation and first-use guidance

**Files:**
- Modify: `docs.html:377-438`
- Modify: `js/story-visual-ui.js`
- Modify: `js/editor.js`
- Modify: `tests/visual-story-ui.test.js`

- [ ] **Step 1: Add static documentation assertions**

Assert docs contain headings or anchors for `五分钟快速入门`, `金币与商店`, `好感度与分支`, `钥匙状态`, `玩家姓名`, `多条件路线`, `高级源码参考`, and `旧项目转换`.

- [ ] **Step 2: Rewrite the variable chapter around tasks**

The first screen must not lead with `{}` or `&&`. Show the exact visual workflow for a 10-coin key purchase. Put source mappings in the advanced section. Use “剧情状态” in ordinary documentation and mention “变量” only when mapping to source.

- [ ] **Step 3: Add one-time contextual tips**

Tips trigger only on first option, first condition, and first effect. They can be dismissed and never block editing. Persist under the test/formal namespace so beta and formal preferences follow existing namespace rules.

- [ ] **Step 4: Run and commit**

Run static UI/docs tests and commit `docs: add visual story state guidance`.

### Task 12: Release hardening, full verification, and beta build

**Files:**
- Modify: `index.html` version and every changed script cache key
- Modify: `tests/release-cache-bust.test.js`
- Modify: `AGENTS.md` with final module invariants
- Build only: `dist-test/`, then copy build output to `beta/` only after tests pass

- [ ] **Step 1: Bump one exact release identifier everywhere**

Choose the next project version after `v25.4.60`, use one cache suffix for all changed CSS/JS, and update exact assertions. Do not leave mixed old/new keys for modified files.

- [ ] **Step 2: Run every test**

```powershell
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName }
```

Expected: every test exits 0.

- [ ] **Step 3: Run whitespace and repository checks**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intended source/test/doc changes appear.

- [ ] **Step 4: Build the isolated beta artifact**

```powershell
python build_inline.py --test
```

Expected: `dist-test/index.html` and `dist-test/docs.html` are generated; the HTML title and app version contain the test marker; `window.STORY_EDITOR_NS='test'` is injected before application scripts.

- [ ] **Step 5: Perform the manual acceptance story**

In the beta build, create the 10-coin key purchase without opening source mode. Test hide and disable behavior, multi-condition groups, option effects, independent effects, inline state display, mode round-trip, save/load, export, old-project conversion failure/retry, and repeat conversion.

- [ ] **Step 6: Request code review before deployment**

Use the `requesting-code-review` skill. Fix correctness and regression findings, rerun all tests, and only then copy `dist-test` output into `beta/` for a separate deployment commit.

## Plan self-review result

- Spec coverage: all design sections map to Tasks 2-12.
- Source-of-truth rule: enforced through shared modules and source-span patching.
- Runtime parity: explicitly tested in Task 4 and Task 12.
- Conversion retry and two UI entry points: covered in Task 10.
- Visual simplicity and no empty labels: acceptance rules in Task 6.
- No new package dependency: explicit global constraint.
- Release isolation: beta build and deployment remain separate from source commits.
