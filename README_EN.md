> 中文 · [English 🌐](README.md)

# 剧情编辑器 / Text Adventure Editor

A **pure front-end** (vanilla HTML + JavaScript, zero dependencies, zero build step) **interactive fiction / text-adventure game** editor. Write your story, manage assets (images / items / music / sound effects), get AI-assisted generation, then export a playable interactive novel that runs in the browser — or deploy it as a shareable web page.

> Project name 「剧情编辑器」, English repo name `jiji_text_game_editor`. This page is statically hosted on GitHub Pages.

## ▶ Use online
**Want to start right away? Open the web editor here (no install; your data is saved in your browser's local storage):**
👉 **https://jigugumiao.github.io/jiji_text_game_editor/**

## Features

- **Story writing**: a text editor supporting `{variable}` substitution, `<标题:...>` floating title overlays, and `<召唤X:名称>` summon commands (image / item / music / sound).
- **Right-click to insert assets**: right-click anywhere in the text to open a multi-level menu and insert images / items / music / sound effects (or type a name manually); the summon command is inserted and the cursor lands on the name.
- **Asset library**: unified management of the image library (backgrounds / solid colors), items, music, and sound effects; solid-color backgrounds support "re-pick color" re-editing; you can generate backgrounds with AI.
- **AI assistant** (`js/ai.js`): a full-text assistant with continuation, outlining, rewriting, note-based control of line count / style, etc. (bring your own LLM API).
- **Playtest / export runtime** (`js/exporter.js`): generates a playable runtime — typewriter effect, branching options, save / load, opening background & music, **auto-play** (continues automatically after a 2.5s pause), and contrast backplates (auto-adapts for light/dark backgrounds to stay readable).
- **Settings**: game title, subtitle, author info; opening background / music configuration.

## Directory structure

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

## Sample project

There is an importable sample adventure in [`examples/sample-adventure/`](examples/sample-adventure/) that demonstrates the editor's core features:

- Background music `<召唤音乐:主题曲>`
- Background switching `<召唤背景:...>`
- Inline images `@image#1:...`
- Floating titles `<标题:...>`
- Variables `<变量:勇气=1>` / `{勇气}`
- Chapter navigation `/// 第一章：冒险开始`
- Click-to-continue `<停顿>`

The folder contains the story text `story.txt`, the asset files (theme MP3 + two scene images), and import instructions in `README.md`.

## Local usage

Just open `index.html` in a browser (no server, no dependencies). All data is stored in the browser's local storage.

When you create your first project, the main story is automatically pre-filled with a concise sample text (see `DEFAULT_TEXT` in `js/editor.js`).

## Generate a single offline file

```bash
python build_inline.py  # produces dist/index.html (inlined, openable offline)
```

## Tech stack

- Vanilla JavaScript (ES, no framework, no bundler)
- HTML5 + CSS3
- Local storage (localStorage)
- Tests: jsdom

## Open-source license

[MIT License](LICENSE) © 2026 jigugumiao
