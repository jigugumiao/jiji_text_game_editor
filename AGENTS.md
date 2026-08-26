# 剧情编辑器 — Agent 工作记忆

## 部署模型（2026-08-26 确认）

- 正式版：GitHub Pages 托管 **master 分支根目录** → `https://jigugumiao.github.io/jiji_text_game_editor/`。仓库无 gh CLI，验证部署用 PowerShell Invoke-WebRequest 探测。
- 测试版：**只把 `python build_inline.py --test` 的产物放进 master 的 `beta/` 子目录**（自包含单文件 + docs.html），URL 不同→浏览器缓存分离；页面注入 `window.STORY_EDITOR_NS='test'` → localStorage/IndexedDB 与正式版完全隔离（storage.js 支持该前缀）。AI 设置（storyeditor:ai:*）与主题偏好仍共享（有意为之）。
- 重构类源码改动走独立分支验收，不直接改 master。当前待验收分支：`feature/story-vars`（变量系统重构 v25.4.60，测试版页面即其构建产物；该分支根目录有详细 AGENTS.md 记录变量系统架构约束）。

## 注意

- `dist/`、`dist-test/` 是构建产物，已 gitignore；要更新线上 beta 页面时把 dist-test 内容拷贝到 `beta/` 提交推送即可。
- tests/*.test.js 用 Node 直跑，无依赖；改动 js 后跑一遍全部测试 + 更新 index.html 的 `?v=` 缓存标识与 app-version（tests/release-cache-bust.test.js 断言精确版本串）。
