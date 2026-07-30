#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建单文件版 index.html：把所有外部 CSS/JS 内联进 HTML，输出到 dist/index.html。
配合 deploy.py 部署 dist/ 目录，可绕过 htmlto.link 对静态资源文件的 CDN/OSS 缓存问题。

用法：
  python build_inline.py
"""
import os
import re
import sys
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
SRC_HTML = os.path.join(ROOT, "index.html")
CONFIG_NAME = ".htmltolink.json"


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def inline_css(html):
    """把 <link rel="stylesheet" href="css/xxx.css?v=..."> 替换为 <style>...</style>"""
    def repl(m):
        href = m.group(1)
        # 取 ? 之前的路径
        path = href.split("?")[0]
        full = os.path.join(ROOT, path.replace("/", os.sep))
        if not os.path.isfile(full):
            print(f"[warn] CSS not found: {full}", file=sys.stderr)
            return m.group(0)
        css = read_text(full)
        # 防御：转义 CSS 内容里的 </style>，避免 HTML 解析器提前结束 <style> 块
        css = css.replace("</style>", "<\\/style>")
        return f"<style>\n/* inlined from {path} */\n{css}\n</style>"
    return re.sub(r'<link[^>]*rel=["\']stylesheet["\'][^>]*href=["\']([^"\']+)["\'][^>]*/?>',
                  repl, html)


def inline_js(html):
    """把 <script src="js/xxx.js?v=..."></script> 替换为 <script>...</script>"""
    def repl(m):
        src = m.group(1)
        path = src.split("?")[0]
        full = os.path.join(ROOT, path.replace("/", os.sep))
        if not os.path.isfile(full):
            print(f"[warn] JS not found: {full}", file=sys.stderr)
            return m.group(0)
        js = read_text(full)
        # 关键修复：JS 内容里的 </script> 字符串字面量必须转义为 <\/script>
        # （JS 中 \/ 等价于 /，但 HTML 解析器看到 <\/script> 不会认为是结束标签）
        # 否则 exporter.js 等文件里的字符串字面量会提前截断外层 <script> 块，
        # 剩余 JS 代码会被浏览器当作 HTML 文本渲染出来。
        js = js.replace("</script>", "<\\/script>")
        # 保留原 script 的其他属性（如 type），但去掉 src
        return f"<script>\n/* inlined from {path} */\n{js}\n</script>"
    # 匹配 <script src="..."></script>（自闭合不存在，script 必须有结束标签）
    return re.sub(r'<script[^>]*\ssrc=["\']([^"\']+)["\'][^>]*>\s*</script>',
                  repl, html)


def main():
    if not os.path.isfile(SRC_HTML):
        print(f"错误：未找到 {SRC_HTML}", file=sys.stderr)
        sys.exit(1)

    # 清理并重建 dist
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST, exist_ok=True)

    html = read_text(SRC_HTML)
    print(f"[build] 源 HTML: {len(html)} 字节", file=sys.stderr)

    html = inline_css(html)
    html = inline_js(html)

    out = os.path.join(DIST, "index.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"[build] 输出: {out} ({len(html)} 字节)", file=sys.stderr)

    # 复制 .htmltolink.json 到 dist，让 deploy.py 能读到 shareUrl/updateToken
    cfg_src = os.path.join(ROOT, CONFIG_NAME)
    cfg_dst = os.path.join(DIST, CONFIG_NAME)
    if os.path.isfile(cfg_src):
        shutil.copy2(cfg_src, cfg_dst)
        print(f"[build] 复制 {CONFIG_NAME} -> dist/", file=sys.stderr)

    print(out)


if __name__ == "__main__":
    main()
