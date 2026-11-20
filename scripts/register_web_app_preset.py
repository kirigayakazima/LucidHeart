#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将小满专属伴侣预设作为原生预设注册进 dsh-web-app"""

import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parent))
from deploy_to_phone import AdbSocketClient

adb = AdbSocketClient()

# 1. 准备 xiaoman-companion.patch.yml (读取权威清单)
source_patch = Path(__file__).resolve().parent.parent / "projects" / "lucidheart" / "manifests" / "presets" / "xiaoman-companion" / "xiaoman-companion.patch.yml"
patch_yml = source_patch.read_text(encoding="utf-8")

local_patch = Path("xiaoman-companion.patch.yml.tmp")
local_patch.write_text(patch_yml, encoding="utf-8", newline="\n")
adb.push_file(local_patch, "/sdcard/dshproject/xiaoman-companion.patch.yml")
local_patch.unlink()

# 2. 准备注册脚本 register_preset.sh
sh_script = """#!/bin/sh
LOG="/sdcard/dshproject/register_preset.log"
exec > "$LOG" 2>&1
echo "=== 正在将小满专属伴侣预设注入 dsh-web-app ==="
date

WEB_APP_DIR="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app"
if [ ! -d "$WEB_APP_DIR" ]; then
    echo "[!] 未找到 $WEB_APP_DIR"
    exit 1
fi

echo "[✓] 找到 dsh-web-app: $WEB_APP_DIR"

# 1. 拷贝 xiaoman-companion.patch.yml 到 presets/
cp /sdcard/dshproject/xiaoman-companion.patch.yml "$WEB_APP_DIR/presets/xiaoman-companion.patch.yml"
chmod 644 "$WEB_APP_DIR/presets/xiaoman-companion.patch.yml"
echo "[✓] 已写入 $WEB_APP_DIR/presets/xiaoman-companion.patch.yml"

# 2. 更新 package.json 引入该 patch (使用 node 安全修改 JSON)
node -e '
const fs = require("fs");
const p = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
if (!pkg.dsh) pkg.dsh = {};
if (!pkg.dsh.bundle) pkg.dsh.bundle = {};
if (!Array.isArray(pkg.dsh.bundle.patch)) pkg.dsh.bundle.patch = ["./cordis.patch.yml"];
const target = "./presets/xiaoman-companion.patch.yml";
if (!pkg.dsh.bundle.patch.includes(target)) {
    pkg.dsh.bundle.patch.unshift(target); // 放在最前，最先加载
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\\n", "utf8");
    console.log("[✓] package.json 已成功加入 xiaoman-companion.patch.yml");
} else {
    console.log("[i] package.json 已存在 xiaoman-companion.patch.yml");
}
console.log("当前 patch 列表:", JSON.stringify(pkg.dsh.bundle.patch));
' "$WEB_APP_DIR/package.json"

# 3. 在 cordis.patch.yml 中配置 agent-preset-registry 的默认值
PROFILE_PATCH="/root/.dsh/profiles/web/cordis.patch.yml"
if [ -f "$PROFILE_PATCH" ]; then
    # 确保没有重复的 agent-preset-registry 配置
    if ! grep -q "agent-preset-registry" "$PROFILE_PATCH"; then
        cat << 'EOF' >> "$PROFILE_PATCH"

# == 默认激活小满专属伴侣模式 ==
- id: agent-preset-registry
  config:
    default: xiaoman-companion
EOF
        echo "[✓] 已将 xiaoman-companion 设置为默认预设"
    fi
fi

echo "=== 注册完成！请重启 DSH App ==="
"""

local_sh = Path("register_preset.sh.tmp")
local_sh.write_text(sh_script, encoding="utf-8", newline="\n")
adb.push_file(local_sh, "/sdcard/dshproject/register_preset.sh")
local_sh.unlink()

print("Register scripts pushed successfully!")
