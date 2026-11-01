# Feiyu 活泼度试听

当前目的是在已通过的相位精度修正基线上选择语速和语调起伏，不修改原模型、原 profile、已通过音频或默认 Dv5。所有试听仍由包内手机同款 ONNX CPU 代码生成；不能以 PC 结果代替手机真机验收。

## 当前试听组

输出目录：`D:/CodePackage/DSHA/projects/lucidheart/local/feiyu/auditions/liveliness-20261101/`。

| 文件 | 语速 | 语调起伏 | 用途 |
|---|---|---|---|
| `reference_accepted.wav` | 原始 | 原始 | 刚刚通过的音频原样复制，保留原 SHA |
| `00_control.wav` | +0% | 1.0 | 固定 seed=42 重新生成，用于控制生成波动 |
| `01_rate06.wav` | +6% | 1.0 | 只调整前置 TTS 语速 |
| `02_rate12.wav` | +12% | 1.0 | 较快语速 |
| `03_contour125.wav` | +0% | 1.25 | 只扩大已有语调起伏 |
| `04_contour150.wav` | +0% | 1.5 | 较明显起伏，用于判断是否过度 |
| `05_combo.wav` | +6% | 1.25 | 组合对照，不预先认定为最优 |

文本相同：“你好呀，我是小满。这个是新声库的测试，先听听自然不自然。”全部保持 RVC pitch=0、brightness=0、indexRatio=0.3、protect=0.33、noiseScale=0.66666 和连续合成。每个语速使用一份干声缓存，同语速的各组复用干声；所有新生成组均设置 NumPy/ORT seed=42，减少随机性这个混杂因素，不宣称跨平台逐样本确定。

先听原始参考，再比较 00_control 与单变量组，最后听组合组。分别评价自然度、活泼感、是否像刻意卖萌、句尾是否突兀，以及是否仍有变形。一次短句不能证明长段叙述、提问或情绪表达都合适。

用户本轮反馈：B（`01_rate06.wav`）与F（`05_combo.wav`）较好，语速更拟人，F能听出起伏，但最后约1秒变形。下一轮优先以B的+6%语速为候选；F保留为表达参考，尚未通过平顺度验收，不自动设为默认。原始已验收参考继续保留。

## 调哪两个参数

- `rate`：Edge-TTS 的说话速度，默认 `+0%`，本脚本允许 `-20%..+20%`。先比较 `+6%` 和 `+12%`；它不会凭空增加笑意或重音。
- `intonationScale`：实验性的语调起伏系数，默认 `1.0` 完全旁路，允许 `0.8..1.6`。在有声帧的对数 F0 上，以其中位数为中心放大原有变化；无声帧保持不变，每帧额外变化限制为正负2半音，F0限制50～1100Hz。它不是整体升调，RVC音高档位仍只允许0/-4。建议先听1.25，1.5用于识别上限，不当作默认推荐。

该系数会同时重新计算离散 pitch 和连续 pitchf，避免二者失配。它不能推断一句话应该开心、疑问还是安慰，也不能补出原干声没有的语义重音。若参数只能让声音更快或更夸张，却不能更自然，下一步应比较情绪/韵律更丰富的前置 TTS，而不是无限提高系数。

[Edge-TTS 的官方说明](https://github.com/rany2/edge-tts#custom-ssml)列出了语速、音高、音量调节，且不支持任意自定义 SSML。本轮不伪造 `cheerful`、重音或情绪标签；没有通过全局调高音量制造“更活泼”的错觉。

## 直接生成一个自定义试听

在 `D:/CodePackage/DSHA` 的 PowerShell 中运行，沿用项目现有 uv 管理的 Python 环境：

```powershell
& .\projects\rvc\.venv310\Scripts\python.exe `
  .\projects\lucidheart\packages\rvc\scripts\voice_audition.py `
  --profile .\projects\lucidheart\local\feiyu\rvc-onnx-phasefix\voice-profile.json `
  --output-dir .\projects\lucidheart\local\feiyu\auditions\my-try-01 `
  --rate=+8% --intonation-scale 1.3 `
  --text '你回来啦！我刚好有件事想跟你说。'
```

每次换一个**尚不存在的输出目录**，避免覆盖。输出 `custom.wav`、干声、结果 JSON 和 `manifest.json`。脚本不安装依赖、不部署手机、不修改 profile。更换文字会使用在线 Edge-TTS；音色转换在本机 CPU 执行。当前每份干声必须短于10秒，长句会明确失败，先拆成短句再试听。

如果只改起伏，可以复用已通过参考的干声、完全离线执行转换：

```powershell
& .\projects\rvc\.venv310\Scripts\python.exe `
  .\projects\lucidheart\packages\rvc\scripts\voice_audition.py `
  --profile .\projects\lucidheart\local\feiyu\rvc-onnx-phasefix\voice-profile.json `
  --output-dir .\projects\lucidheart\local\feiyu\auditions\my-contour-01 `
  --dry-input .\projects\lucidheart\local\feiyu\samples\feiyu_rvc_plugin_text.dry.mp3 `
  --rate=+0% --intonation-scale 1.3
```

`--dry-input` 只作为原速干声复用，文字必须与它一致；修改 rate 后会重新合成干声，而不是给现有文件错误标注新语速。

## 修改整批参数

复制 `scripts/voice_audition_presets.json` 到自己的位置，修改 `rate` 和 `intonationScale`，通过 `--presets <文件>` 传入；`--only 01_rate06 03_contour125` 可只运行指定组。不要将 `--only` 与单组自定义参数混用。

```powershell
& .\projects\rvc\.venv310\Scripts\python.exe `
  .\projects\lucidheart\packages\rvc\scripts\voice_audition.py `
  --profile .\projects\lucidheart\local\feiyu\rvc-onnx-phasefix\voice-profile.json `
  --output-dir .\projects\lucidheart\local\feiyu\auditions\batch-02 `
  --dry-input .\projects\lucidheart\local\feiyu\samples\feiyu_rvc_plugin_text.dry.mp3 `
  --reference-audio .\projects\lucidheart\local\feiyu\samples\feiyu_onnx_phasefix.wav
```

`manifest.json` 保存参数、输入/输出 SHA、随机种子、耗时、运行器指纹和逐组成功状态。失败时保留已生成文件并记录错误，不能把部分完成当作整批验收。

选定后可以将 `ttsRate` 和 `intonationScale` 写入**新的** profile 再测试；当前生产默认仍为 `+0%` / `1.0`，Heart 尚不自动选择本轮实验参数。不要改写作为验收证据保存的原始 profile。
