# 全指令可视化编辑器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有常用剧情指令在可视化编辑中显示为低饱和语义 chip，并可从顶部与素材库快速插入，同时移除分屏和修复独占预览。

**Architecture:** `StoryVisualDoc` 继续负责无损扫描与 span 替换，并新增通用指令分类描述器；`StoryVisualUI` 负责渲染 chip 和调用插入回调；`editor.js` 只负责把现有素材库、状态库、预览和编辑器生命周期接入这些回调。颜色只定义在 CSS 变量中，亮暗主题都覆盖。

**Tech Stack:** 原生浏览器 JavaScript、CSS 自定义属性、Node `assert` 测试、现有单文件 beta 构建。

---

### Task 1: 无损识别全部常用指令

**Files:**
- Modify: `js/story-visual-doc.js`
- Modify: `tests/story-visual-doc.test.js`

- [ ] **Step 1: 写失败的分类测试**

在 `tests/story-visual-doc.test.js` 加入：

```js
const kinds = StoryVisualDoc.scan('<召唤背景:夜路>\n<召唤物品:钥匙,"">\n<召唤音乐:雨>\n<召唤音效:门>\n<标题:序章>\n<停顿>\n<剧情块:支线>')
  .nodes.filter(n => n.kind === 'command_chip').map(n => n.data.category);
assert.deepEqual(kinds, ['background', 'item', 'music', 'sound', 'flow', 'flow', 'flow']);
```

- [ ] **Step 2: 验证失败**

Run: `node tests/story-visual-doc.test.js`

Expected: FAIL，因为扫描器尚未输出 `command_chip`。

- [ ] **Step 3: 实现分类器和 span 节点**

在 `js/story-visual-doc.js` 添加纯函数：

```js
function describeCommand(raw) {
  const m = /^<([^:>]+)(?::([\s\S]*))?>$/.exec(raw);
  if (!m) return null;
  const name = m[1], value = m[2] || '';
  const category = /^召唤背景/.test(name) ? 'background'
    : /^召唤(?:物品|叠层)/.test(name) ? 'item'
    : /^召唤音乐|停止音乐/.test(name) ? 'music'
    : /^召唤音效/.test(name) ? 'sound' : 'flow';
  return { name, value, category, summary: value ? name + '：' + value : name };
}
```

让 `appendGeneric` 对每个完整 `<...>` 调用 `describeCommand`；成功时推入 `{kind:'command_chip', raw, data: descriptor}`，否则保留既有 `raw_command`。不能改变 `replaceNode` 或未改动源码的往返结果。

- [ ] **Step 4: 验证并提交**

Run: `node tests/story-visual-doc.test.js`

Expected: PASS.

Commit: `feat: classify visual story commands`.

### Task 2: 渲染语义 chip 与可视化插入菜单

**Files:**
- Modify: `js/story-visual-ui.js`
- Modify: `tests/visual-story-ui.test.js`
- Modify: `index.html`

- [ ] **Step 1: 写失败的描述器与插入测试**

在 `tests/visual-story-ui.test.js` 加入：

```js
assert.deepEqual(StoryVisualUI.describeNode({kind:'command_chip', data:{category:'music', summary:'召唤音乐：雨'}}, {}), {
  kind: 'command_chip', category: 'music', summary: '召唤音乐：雨', editable: true
});
assert.equal(typeof StoryVisualUI.insertAtVisualSelection, 'function');
assert.match(html, /id="visual-insert-menu"/, '可视化模式必须有插入菜单');
```

- [ ] **Step 2: 验证失败**

Run: `node tests/visual-story-ui.test.js`

Expected: FAIL，因为尚未导出插入函数和菜单宿主。

- [ ] **Step 3: 实现渲染与插入边界**

在 UI 模块中扩展 `describeNode`，返回 `{kind:'command_chip', category, summary, editable:true}`。`renderDocument` 为此节点创建 button，class 为 `story-visual-chip story-visual-chip-<category>`，点击时把该 node 交给现有诊断/编辑回调。

实现纯函数：

```js
function insertAtVisualSelection(source, selection, text) {
  const at = Math.max(0, Math.min(Number(selection) || source.length, source.length));
  return source.slice(0, at) + text + source.slice(at);
}
```

`createController` 新增 `insert(text)`：记录最近文本节点偏移；无偏移时追加；调用 `setSource(next)`、`refresh()`。在 `index.html` 的编辑器标题处增加 `<button id="visual-insert-menu" ...>插入</button>`；菜单只在可视化模式显示。

- [ ] **Step 4: 验证并提交**

Run: `node tests/visual-story-ui.test.js`

Expected: PASS.

Commit: `feat: render visual command chips and insertion`.

### Task 3: 接入素材库、状态插入、移除分屏并独占预览

**Files:**
- Modify: `js/editor.js`
- Modify: `index.html`
- Modify: `tests/visual-story-ui.test.js`

- [ ] **Step 1: 写失败的编辑器集成测试**

在 `tests/visual-story-ui.test.js` 加入：

```js
assert.doesNotMatch(html, /id="btn-split"/, '工具栏不再提供分屏模式');
assert.match(editorSource, /visualController\.insert\(/, '素材和状态可插入可视化光标');
assert.match(editorSource, /storyPreview\.classList\.toggle\('hidden', !on\)/, '预览必须独占编辑主区');
```

- [ ] **Step 2: 验证失败**

Run: `node tests/visual-story-ui.test.js`

Expected: FAIL，因为旧分屏按钮和源码专用插入仍存在。

- [ ] **Step 3: 实现编辑器桥接**

删除 `#btn-split` HTML、事件绑定和 `splitMode` 分支；所有 `setPreviewMode(true)` 必须隐藏 `editorTextWrap` 与 `#story-visual-editor`，显示 `#story-preview` 并让它 `flex:1`；关闭预览恢复 visual controller 当前模式。

新增 `insertVisualOrSource(text)`：若 `visualController.getMode()==='visual'` 则 `visualController.insert(text)`，否则使用既有 `insertAtCursor(text)`。素材卡、停止音乐卡以及状态库“插入到正文”统一改调该函数。顶部“插入”菜单调用同一函数，菜单项目至少包含变量、选项、背景、物品、音乐、音效、标题、停顿、分割线、剧情块、跳回与随机跳转。

- [ ] **Step 4: 验证并提交**

Run: `node tests/visual-story-ui.test.js`

Expected: PASS.

Commit: `feat: insert assets in visual mode and remove split`.

### Task 4: 主题颜色、回归与 beta 构建

**Files:**
- Modify: `css/style.css`
- Modify: `index.html`
- Modify: `tests/release-cache-bust.test.js`

- [ ] **Step 1: 写失败的样式契约测试**

在 `tests/visual-story-ui.test.js` 读取 CSS 并断言以下选择器同时存在：

```js
['state-read', 'state-write', 'option', 'background', 'item', 'music', 'sound', 'flow'].forEach(category =>
  assert.match(styleSource, new RegExp('story-visual-chip-' + category)));
assert.match(styleSource, /body\.dark[\s\S]*story-visual-chip/, '暗色主题必须覆盖 chip');
```

- [ ] **Step 2: 验证失败**

Run: `node tests/visual-story-ui.test.js`

Expected: FAIL，因为完整颜色类别尚未定义。

- [ ] **Step 3: 实现低饱和主题 token**

在 `css/style.css` 定义每类 `--chip-*-fg/bg/border`，亮色背景透明度约 10%，暗色背景约 20%。为 `.story-visual-state-token` 使用 `state-read`，`.story-visual-node-state_change` 使用 `state-write`，选项蓝色，命令 chip 使用分类 class。所有 chip 使用 `color/background/border`，不使用荧光色或阴影卡片。

同步更新 `index.html` app/about version、所有改变的 js/css `?v=` 与 `tests/release-cache-bust.test.js` 精确断言。

- [ ] **Step 4: 完整验证和提交**

Run:

```powershell
Get-ChildItem tests -Filter '*.test.js' | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
git diff --check
python build_inline.py --test
```

Expected: 所有测试 PASS，`dist-test/index.html` 包含 `-TEST` 与 `window.STORY_EDITOR_NS = "test"`。

Commit: `feat: complete visual instruction editor`.
