# Edge-TTS 分句表达前置实验

链路：文字 → 可编辑分句计划 → 分句 Edge-TTS → 干声首尾静音整理/短停顿 → 合并干声 → 相位精度修正后的 RVC 连续合成。

这是规则驱动的第一版，使用标点和少量开场词；没有调用 LLM 推断情绪，不提供未经 Edge 支持的情绪 SSML，也没有假设能控制具体重音。整个实验不改写文字、不改默认 profile、不切换手机配置。

## 本轮控制

- 对照：同文本、同 Xiaoxiao 声音，整段 Edge-TTS，语速 `+6%`，对应用户偏好的B方向。
- 前置处理：完整句子分段，开场/感叹句略快、问句/收尾略缓，再插入短静音。
- RVC：同一精度修正模型、pitch=0、brightness=0、indexRatio=0.3、protect=0.33、noiseScale=0.66666、seed=42。
- `intonationScale` 强制为1.0，不使用用户指出尾部变形的F组语调放大设置。

整段对照本身也会根据标点生成韵律；本实验测试的是额外的分句、逐句语速和显式停顿是否有帮助。独立分句可能削弱跨句语境，停顿过多也可能显得机械，必须比较实际音频，不能按生成成功宣称更自然。

## 生成一次对照

在 `D:/CodePackage/DSHA` 的 PowerShell 中，使用现有 uv 管理的环境：

```powershell
& .\projects\rvc\.venv310\Scripts\python.exe `
  .\projects\lucidheart\packages\rvc\scripts\edge_expression.py `
  --profile .\projects\lucidheart\local\feiyu\rvc-onnx-phasefix\voice-profile.json `
  --output-dir .\projects\lucidheart\local\feiyu\auditions\my-expression-01 `
  --text '欸，你回来啦！我刚好有件事想跟你说。'
```

每次输出目录必须是新的。`control.wav` 是整段+6%经RVC，`expression.wav` 是分句处理经RVC。`control.dry.mp3`、`expression.dry.wav` 可用于判断变化来自前置TTS还是转换环节。`expression-plan.json` 保存可读计划；`phrases/` 保存逐句原始干声；manifest保存每句裁剪样本位置、插入静音数量、语速、文件SHA和RVC结果。

当前连续RVC只支持不足10秒的干声，合并干声超限会明确失败，不回退旧分块或截掉尾句。Edge部分在线执行，RVC部分本地CPU，无Torch；本轮未在手机运行，也未重建安装包。

## 调整计划

复制一次生成的 `expression-plan.json`，修改每句的 `rate` 和 `gapMs`，再以 `--plan <文件>` 生成到另一目录。

```json
{
  "schema": "lucidheart-edge-expression-v1",
  "text": "欸，你回来啦！我刚好有件事想跟你说。",
  "baseRate": "+6%",
  "parts": [
    {"text": "欸，你回来啦！", "rate": "+9%", "gapMs": 140},
    {"text": "我刚好有件事想跟你说。", "rate": "+4%", "gapMs": 0}
  ]
}
```

`rate` 允许-20%～+20%；`gapMs` 为该句之后额外插入的静音，0～600毫秒，最后一句必须为0。裁剪会保留约30/50ms的前后裕量，因此它不是精确到字边界的总停顿长度。不改变逐句音量，不在有声波形之间交叉混合。

计划必须逐字保留原始文字与标点（仅忽略空白差异），不能漏句、重复或偷偷改写。`--base-rate 6` 控制整段对照和自动计划基速，默认6；自定义计划的逐句 rate 使用其显式值。`--control-dry` 只用于复用同文本、同基速的既有干声，由调用者保证匹配。

自动规则示例：问句基速-2、感叹基速+3、招呼开场基速+2、一般收尾基速-2；这只是实验启发式。尚未覆盖语义重音、讽刺、安慰、情绪变化、精确字级停顿或长句流式处理。

## 当前试听

`local/feiyu/auditions/edge-expression-20261101/` 包含两组：

1. `reference-text/`：沿用此前短句，对照复用B组的+6%原始干声；前置处理为开场+8%、收尾+4%，中间加130ms静音。
2. `greeting/`：使用上面的回家招呼，对照整段+6%；前置处理为感叹+9%、收尾+4%，中间加140ms静音。

两组都待用户试听。若喜欢此方向，再扩展真实聊天文本与长句，并考虑作为可选前置策略接入插件；当前只提供独立可复现实验入口。

本次原测试句对照与此前B组的WAV逐字节一致。原句直读/表达为6.24/5.31秒，招呼直读/表达为4.15/3.16秒；表达版整理了Edge逐句自带的多余首尾静音，因此整体更紧凑，不能把差异全部归因于情绪或语速。四份RVC音频已通过格式、有限值和SHA检查，主观效果仍待确认。
