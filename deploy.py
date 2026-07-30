#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
剧情编辑器 → htmlto.link 部署脚本
- 打包项目为 zip（自动排除凭证/无关目录）
- 调用 https://htmlto.link/api/skill/deploy
- 新建或更新页面（依据根目录 .htmltolink.json 中的 shareUrl）
- 成功后把 shareUrl / updateToken / versionNo 回写 .htmltolink.json
- 成功后打印最终分享链接（仅链接）
- 邮件通知：预留逻辑，仅当配置了 SMTP_* 环境变量时才发送

用法：
  python deploy.py                 # 部署当前目录（脚本所在目录）
  python deploy.py "D:/xxx/剧情编辑器"   # 指定项目根目录
  HTMLTOLINK_TOKEN=xxx python deploy.py  # 用环境变量覆盖内置 token
"""
import os
import sys
import io
import json
import zipfile
import datetime
import urllib.request
import urllib.error
import smtplib
import email.mime.text

# ============================ 配置 ============================
API_URL = "https://htmlto.link/api/skill/deploy"

# 内置 token（用户明确授权直接使用）；可用环境变量 HTMLTOLINK_TOKEN 覆盖
TOKEN = os.environ.get("HTMLTOLINK_TOKEN", "htl_a96ce5d65f828859fef848bca84a1d9be086d4dd540e6479")

# 入口 HTML（zip 内相对路径）
ENTRY_FILE = "index.html"

# 默认标题（可用环境变量 DEPLOY_TITLE 覆盖）
DEFAULT_TITLE = os.environ.get("DEPLOY_TITLE", "剧情编辑器")

# 自动排除：凭证或无关目录/文件（用户指定 + 安全补充）
EXCLUDE_NAMES = {
    ".htmltolink.json",   # 本脚本的状态文件，不能打进包
    "node_modules",
    ".git",
    ".next",
    "dist",
    "cache",
    ".workbuddy",         # 含记忆/MCP 配置，属无关且可能含凭证，安全排除
    "__pycache__",
    ".DS_Store",
    ".playwright-cli",    # 浏览器自动化测试遗留日志，非项目资源
    "TEST",               # 本地 playwright 测试脚手架，非项目资源
}

CONFIG_NAME = ".htmltolink.json"


# ============================ 打包 ============================
def build_zip(root):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirnames, filenames in os.walk(root):
            # 剪枝：排除名单里的子目录
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES]
            for fn in filenames:
                if fn in EXCLUDE_NAMES:
                    continue
                # 跳过 Windows 保留设备名文件（nul/con/aux/prn 等），避免路径解析异常
                if fn.lower() in {"nul", "con", "aux", "prn", "com1", "com2", "com3", "lpt1", "lpt2"}:
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                except ValueError:
                    continue
                if any(part in EXCLUDE_NAMES for part in rel.split("/")):
                    continue
                # 跳过无法读取的文件
                if not os.path.isfile(full):
                    continue
                z.write(full, rel)
    data = buf.getvalue()
    if len(data) == 0:
        raise RuntimeError("打包结果为空，请检查项目目录")
    return data


# ============================ 部署 ============================
def deploy(zip_bytes, title, share_url=None, update_token=None):
    boundary = "----deployboundary7Q3k9"
    body = io.BytesIO()

    def add_field(name, value):
        body.write(f"--{boundary}\r\n".encode("utf-8"))
        body.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.write(value.encode("utf-8") if isinstance(value, str) else value)
        body.write(b"\r\n")

    def add_file(field, filename, data):
        body.write(f"--{boundary}\r\n".encode("utf-8"))
        body.write(f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode("utf-8"))
        body.write(b"Content-Type: application/zip\r\n\r\n")
        body.write(data)
        body.write(b"\r\n")

    add_field("token", TOKEN)
    add_field("entry_file", ENTRY_FILE)
    add_field("title", title)
    if share_url:
        add_field("shareUrl", share_url)
    if update_token:
        add_field("updateToken", update_token)
    add_file("file", "project.zip", zip_bytes)
    body.write(f"--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(API_URL, data=body.getvalue(), method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"网络错误: {e.reason}")


# ============================ 邮件（预留） ============================
def send_notification(link, version, title):
    host = os.environ.get("SMTP_HOST")
    if not host:
        # 未配置 SMTP → 预留但不发送
        print("[email] 未配置 SMTP_* 环境变量，跳过发送（逻辑已预留）", file=sys.stderr)
        return False
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    pwd = os.environ.get("SMTP_PASS", "")
    frm = os.environ.get("SMTP_FROM", user)
    to = os.environ.get("DEPLOY_NOTIFY_EMAIL", "619597265@qq.com")
    body_text = (
        f"项目已部署/更新\n\n"
        f"标题：{title}\n"
        f"版本：v{version}\n"
        f"分享链接：{link}\n"
        f"部署时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
    )
    msg = email.mime.text.MIMEText(body_text, "plain", "utf-8")
    msg["Subject"] = f"[部署] {title} v{version}"
    msg["From"] = frm
    msg["To"] = to
    with smtplib.SMTP(host, port, timeout=30) as s:
        s.starttls()
        if user:
            s.login(user, pwd)
        s.sendmail(frm, [to], msg.as_string())
    print(f"[email] 已发送至 {to}", file=sys.stderr)
    return True


# ============================ 主流程 ============================
def main():
    root = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    if not os.path.isdir(root):
        print(f"错误：目录不存在 {root}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isfile(os.path.join(root, ENTRY_FILE)):
        print(f"错误：未找到入口文件 {ENTRY_FILE}", file=sys.stderr)
        sys.exit(1)

    cfg_path = os.path.join(root, CONFIG_NAME)
    prev = {}
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                prev = json.load(f)
        except Exception:
            prev = {}

    share_url = prev.get("shareUrl")
    update_token = prev.get("updateToken")
    mode = "更新" if share_url else "新建"

    print(f"[deploy] 项目根：{root}", file=sys.stderr)
    print(f"[deploy] 模式：{mode}（{'已有 shareUrl' if share_url else '将创建新页面'}）", file=sys.stderr)

    zip_bytes = build_zip(root)
    print(f"[deploy] 打包完成，zip 大小：{len(zip_bytes)} 字节", file=sys.stderr)

    resp = deploy(zip_bytes, DEFAULT_TITLE, share_url=share_url, update_token=update_token)
    if not resp.get("success"):
        raise RuntimeError(f"部署失败：{resp.get('message', resp)}")

    new_share = resp.get("shareUrl") or share_url
    new_token = resp.get("updateToken") or update_token
    new_ver = resp.get("versionNo")
    new_title = resp.get("title") or DEFAULT_TITLE

    state = {
        "shareUrl": new_share,
        "updateToken": new_token,
        "versionNo": new_ver,
        "title": new_title,
        "entryFile": resp.get("entryFile", ENTRY_FILE),
        "temporary": resp.get("temporary", False),
        "expiresAt": resp.get("expiresAt"),
        "deployedAt": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    print(f"[deploy] 已回写 {CONFIG_NAME}（v{new_ver}）", file=sys.stderr)

    # 邮件（仅当配置了 SMTP 才发）
    try:
        send_notification(new_share, new_ver, new_title)
    except Exception as e:
        print(f"[email] 发送失败（不影响部署）：{e}", file=sys.stderr)

    # 成功后仅返回最终分享链接
    print(new_share)


if __name__ == "__main__":
    main()
