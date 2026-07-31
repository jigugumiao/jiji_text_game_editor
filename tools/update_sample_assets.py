#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安全地把「用户压缩后的工程导出」里的图片/音乐，替换进示例工程 js/sample-project.js。

用法:
  python tools/update_sample_assets.py "<用户导出的工程JSON路径>"

关键约定（避免再次踩坑）:
  1. 示例工程的 blocks / vars / meta 必须是 JSON 字符串（seedExampleProjectInto 会对它们 JSON.parse）。
     因此本脚本**保留 HEAD 版本里的 blocks/vars/meta 字符串**，只替换图片/音乐的 src+size。
  2. 只取导出里压缩后的 `src`（data:image/jpeg / data:audio/mpeg 等），**绝不**读取 `original`
     大源文件字段（那个是用户压缩前的备份，绝不能进示例工程）。
  3. 重新按压缩后的 data URL 计算真实 size（导出里的 size 字段仍是旧原始大小，不可信）。
  4. 物品 (item) 的 GLB 等字段原样保留（HEAD 示例里已是正确的宝箱）。
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_JS = os.path.join(ROOT, "js", "sample-project.js")


def real_size(src):
    i = src.find("base64,")
    if i < 0:
        return 0
    b = src[i + 7:]
    pad = 2 if b.endswith("==") else (1 if b.endswith("=") else 0)
    return len(b) * 3 // 4 - pad


def main():
    if len(sys.argv) < 2:
        print("用法: python tools/update_sample_assets.py <用户导出JSON>")
        sys.exit(1)
    user_path = sys.argv[1]
    if not os.path.isfile(user_path):
        print("文件不存在:", user_path)
        sys.exit(1)

    # HEAD 示例（proven 的 blocks/vars/meta 序列化）
    head_src = subprocess.check_output(
        ["git", "show", "HEAD:js/sample-project.js"], cwd=ROOT
    ).decode("utf-8")
    head = json.loads(
        __import__("re").search(
            r"window\.SAMPLE_PROJECT_JSON\s*=\s*(\{[\s\S]*?\});\s*$", head_src
        ).group(1)
    )
    hdata = head["data"]

    with open(user_path, "r", encoding="utf-8") as f:
        user = json.load(f)
    by_key = {}
    for a in user["data"].get("assets", []):
        by_key[a["lib"] + "/" + a["name"]] = a

    new_assets = []
    for a in hdata["assets"]:
        if a["lib"] in ("background", "music"):
            ua = by_key.get(a["lib"] + "/" + a["name"])
            if ua and ua.get("src", "").startswith("data:"):
                size = real_size(ua["src"])
                rec = {"lib": a["lib"], "name": a["name"], "id": a["id"]}
                if a["lib"] == "background":
                    rec["kind"] = a.get("kind", "image")
                rec["src"] = ua["src"]          # 压缩后的 src，绝不用 original
                rec["size"] = size
                new_assets.append(rec)
                print("替换 %s/%s -> %.1f KB (%s)"
                      % (a["lib"], a["name"], size / 1024, ua["src"].split(";")[0]))
                continue
            print("!! 未找到压缩版 %s/%s，保留原样" % (a["lib"], a["name"]))
        new_assets.append(a)  # 宝箱等保持不变
    hdata["assets"] = new_assets

    out = ("window.SAMPLE_PROJECT_JSON = "
           + json.dumps({"format": "story-editor-project", "data": hdata},
                        ensure_ascii=False)
           + ";\n")
    with open(SAMPLE_JS, "w", encoding="utf-8") as f:
        f.write(out)
    print("写入 %s (%.2f MB)" % (SAMPLE_JS, len(out) / 1048576))


if __name__ == "__main__":
    main()
