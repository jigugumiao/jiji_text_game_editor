> 🌐 语言 / Language：[English](README_EN.md) · 中文

# 剧情编辑器 / Text Adventure Editor

## ▶ 在线使用 / Use online
**想直接上手？点这里打开网页版编辑器（无需安装，数据存在你的浏览器本地）：**
👉 **https://jigugumiao.github.io/jiji_text_game_editor/**

一个**纯前端**（原生 HTML + JavaScript，零依赖、零构建步骤）的**互动剧情 / 文字冒险游戏**编辑器。写剧情、配素材（图片 / 物品 / 音乐 / 音效）、用 AI 辅助生成，一键导出成可在浏览器里玩的互动小说，也能直接部署成可分享的网页。

> 项目名「剧情编辑器」，英文仓库名 `jiji_text_game_editor`。本页由 GitHub Pages 静态托管。

## 功能特性

- **剧情编写**：正文编辑器，支持 `{变量名}` 变量替换、`<标题:...>` 浮动标题遮罩、`<召唤X:名称>` 召唤指令（图片 / 物品 / 音乐 / 音效）。
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
js/ai.js              AI 助理
js/storage.js         本地存储（window.Storage）
js/bbcode.js          文本标记解析
js/generators.js      素材生成器
js/lame.min.js        MP3 编码（音频导出）
js/zip.js             压缩
build_inline.py       生成内联单文件离线包
TEST/                 基于 jsdom 的回归测试
```

## 本地使用

直接用浏览器打开 `index.html` 即可（无需服务器、无需安装依赖）。所有数据保存在浏览器本地存储。

## 生成离线单文件

```bash
python build_inline.py  # 从 index.html 生成 dist/index.html（内联，可离线打开）
```

## 技术栈

- 原生 JavaScript（ES，无框架、无打包器）
- HTML5 + CSS3
- 本地存储（localStorage）
- 测试：jsdom

## 开源协议

[MIT License](LICENSE) © 2026 jigugumiao
