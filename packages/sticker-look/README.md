# dsh-sticker-look (DSHA 主权增强分支)

> **定位**: 本仓库是 `dsh-sticker-look` 的 DSHA 主权 Fork 分支（当前版本：`v0.2.3`）。为大语言模型提供毫秒级、零外部依赖的表情包与图片多模态深度理解能力。

---

## 🌟 主权魔改与核心特性

1. **Heart Protocol v1 审美与情绪回流**：
   - 深度接入微内核契约：识别出的表情包动作、情绪意向与审美喜好，自动调用 `heart.observe({ type: 'sticker' })` 回流至小满心智日志。
2. **MD-02 极端除零漏洞修复**：
   - 彻底修复单帧动图或极端宽高图片抽帧拼接联系表时，由于时间间隔分母为零引发的运行时异常崩溃。
3. **零外部运行时依赖**：
   - 纯原生 Node.js 实现（仅使用 `node:zlib` 与纯 Buffer 计算）；
   - 自主内置 GIF 解码、宫格联系表拼接与 PNG 编码，无需 `sharp`、`ffmpeg`、`canvas` 等外部 C++ 原生模块，适配 Android Proot 极简环境。
4. **意图与约定先验**：
   - 支持本地表情约定库（`~/.dsh/stickers/`），先查约定再审意图，杜绝望文生义与幻觉。

---

## 🛠️ 安装与使用

### PC 端打包并推送到手机端
```bash
uv run python scripts/deploy_to_phone.py --plugin sticker-look
```

### 手机容器端安装
```bash
sh /sdcard/dshproject/updates/install_or_update.sh
```

---

## 🙏 致谢与声明 (Acknowledgments)

- 感谢原作者开创性的零依赖联系表抽帧算法与意图理解设计。
- 本项目遵循开源规范进行自主托管与维护。
