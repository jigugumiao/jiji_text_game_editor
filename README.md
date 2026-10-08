> 🌐 语言 / Language：[English](README_EN.md) · 中文

# 剧情编辑器 / Text Adventure Editor

## ▶ 在线使用 / Use online
**想直接上手？点这里打开网页版编辑器（无需安装，数据存在你的浏览器本地）：**
👉 **https://jigugumiao.github.io/jiji_text_game_editor/**

一个**纯前端**（原生 HTML + JavaScript，零依赖、零构建步骤）的**互动剧情 / 文字冒险游戏**编辑器。写剧情、配素材（图片 / 物品 / 音乐 / 音效）、用 AI 辅助生成，一键导出成可在浏览器里玩的互动小说，也能直接部署成可分享的网页。

> 项目名「剧情编辑器」，英文仓库名 `jiji_text_game_editor`。本页由 GitHub Pages 静态托管。

## 功能特性

- **剧情编写**：正文编辑器，支持 `{变量名}` 变量替换、`<标题:...>` 浮动标题遮罩、`<召唤X:名称>` 召唤指令（背景 / 叠层 / 物品 / 音乐 / 音效）。叠层适合透明 PNG 角色或物件，可用 `<清除叠层>` 隐藏当前叠层并继续剧情。
- **变量系统**（`js/story-vars.js`）：变量库集中定义（数字 / 布尔 / 文本），正文用 `{名}` 读取、`<变量:名=值>` 赋值（一行可多个标签，值支持空格）、`<选项:"文字",块名,条件:表达式>` 条件选项（支持 `&& || ! ()` 与比较运算）。编辑器与导出运行时共用同一份解析实现；「修复检查」一键扫描全部剧情块的未声明赋值 / 错别字 / 坏指令等问题。
- **右键插入素材**：在正文任意位置右键，多级菜单插入图片 / 物品 / 音乐 / 音效（或手动输入名称），自动插入召唤指令并把光标定位到名称处。
- **素材库**：图片库（背景图 / 纯色）、物品、音乐、音效统一管理；纯色背景支持「重选颜色」再编辑；可用 AI 生成背景图。
- **AI 助理**（`js/ai.js`）：全文助理，支持续写、大纲、重写、按备注控制行数 / 文风等（需自备大模型 API）。
- **试玩 / 导出运行时**（`js/exporter.js`）：生成可玩 runtime——打字机效果、选项分支、存档 / 读档、开场背景与音乐、**自动播放**（停顿 2.5s 自动继续）、文字对比底板（深 / 浅背景自动适配保证可读）。
- **设置**：游戏名、副标题、作者等信息；开场背景 / 音乐配置。

## 目录结构

```
index.html            入口（含版本号与缓存后缀）
css/style.css         样式
js/editor.js          主编辑器 / 素材库 / 审阅 / 设置 / 音频
js/exporter.js        试玩与导出运行时
js/story-vars.js      变量系统单一事实源（解析 / 求值 / 静态分析，编辑与导出共用）
js/ai.js              AI 助理
js/storage.js         本地存储（window.Storage）
js/bbcode.js          文本标记解析
js/generators.js      素材生成器
js/lame.min.js        MP3 编码（音频导出）
js/zip.js             压缩
build_inline.py       生成内联单文件离线包（--test 生成数据隔离的测试版 dist-test/）
tests/                Node 直跑的回归测试
```

## 示例项目

仓库里有一个可直接导入的示例冒险故事 [`examples/sample-adventure/`](examples/sample-adventure/)，展示编辑器的核心功能：

- 背景音乐 `<召唤音乐:主题曲>`
- 背景切换 `<召唤背景:...>`
- 叠层角色 `<召唤叠层:...>` / `<清除叠层>`
- 正文内嵌图片 `@image#1:...`
- 浮动标题 `<标题:...>`
- 变量 `<变量:勇气=1>` / `{勇气}` / 条件选项 `<选项:"文字",块名,条件:勇气>=3>`
- 章节导航 `/// 第一章：冒险开始`
- 点击继续 `<停顿>`

目录内包含剧情文本 `story.txt`、资源文件（主题曲 MP3 + 两张场景图）以及导入说明 `README.md`。

## 本地使用

直接用浏览器打开 `index.html` 即可（无需服务器、无需安装依赖）。所有数据保存在浏览器本地存储。

首次新建项目时，主剧情会自动填入一段精简版示例文本（源码见 `js/editor.js` 的 `DEFAULT_TEXT`）。

## 生成离线单文件

```bash
python build_inline.py          # 从 index.html 生成 dist/index.html（内联，可离线打开）
python build_inline.py --test   # 生成测试版 dist-test/index.html：
                                #   1) 标题与版本号带「测试版」标记
                                #   2) 注入 window.STORY_EDITOR_NS='test'，
                                #      localStorage 与 IndexedDB 全部隔离，
                                #      与正式版互不共享数据（缓存/存档互不干扰）
```

## 测试

```bash
node tests/story-vars.test.js         # 变量系统单元测试
node tests/var-conformance.test.js    # 编辑端与导出端解析一致性回归
# 或逐个运行 tests/*.test.js（Node 直跑，无需依赖）
```

## 技术栈

- 原生 JavaScript（ES，无框架、无打包器）
- HTML5 + CSS3
- 本地存储（localStorage）
- 测试：jsdom

## 开源协议

[MIT License](LICENSE) © 2026 jigugumiao
