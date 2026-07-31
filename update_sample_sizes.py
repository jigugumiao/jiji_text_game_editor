#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 js/sample-project.js 里的示例图片/音乐补真实文件 size 字段。"""
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'js', 'sample-project.js')

with open(SRC, 'r', encoding='utf-8') as f:
    text = f.read()

m = re.search(r'window\.SAMPLE_PROJECT_JSON\s*=\s*([\s\S]*?)\s*;\s*$', text)
if not m:
    raise RuntimeError('无法在 sample-project.js 中定位 JSON 数据')

json_text = m.group(1)
data = json.loads(json_text)

assets = data.get('data', {}).get('assets', [])
for asset in assets:
    lib = asset.get('lib')
    src = asset.get('src', '')
    if lib not in ('background', 'music') or not src:
        continue
    # src 形如 examples/sample-adventure/assets/X.png?v=20260731-06
    path_part = src.split('?')[0]
    full_path = os.path.join(ROOT, path_part)
    try:
        asset['size'] = os.path.getsize(full_path)
    except OSError as e:
        print('警告：无法读取', full_path, e)

new_json = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
new_text = 'window.SAMPLE_PROJECT_JSON = ' + new_json + ';\n'
with open(SRC, 'w', encoding='utf-8') as f:
    f.write(new_text)

print('已更新 js/sample-project.js 的 size 字段')
for asset in data.get('assets', []):
    print(' ', asset.get('lib'), asset.get('name'), 'size=', asset.get('size'))
