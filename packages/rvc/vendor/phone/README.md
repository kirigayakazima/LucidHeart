# RVC 语音脚本交接（2026-10-31 拷贝）

这些是从手机上原样拷出来的脚本，源路径见下表。改完要回填到手机对应位置。

| 文件 | 手机上的源路径 | 用途 |
|---|---|---|
| say.sh | /root/dsh-bin/say.sh | TTS 入口：`say.sh "文本" [音色] [输出] [--engine edge\|melo\|auto] [--format auto\|wav\|mp3]`。优先 edge-tts，断网回落 MeloTTS |
| sayvoice.sh | /root/dsh-bin/sayvoice.sh | 端到端说话：TTS + RVC 换音色，约 50 秒 |
| sing-chain.sh | /root/dsh-bin/sing-chain.sh | 唱歌全流程：分离 → RVC → 混音 |
| rvc_onnx.py | /sdcard/rvc/rvc_onnx.py | RVC 推理核心（已含重叠相加 OLA 补丁） |
| local_tts.py | /root/.dsh/voice/local_tts.py | 离线 MeloTTS 兜底 |
| separate.py | /root/.dsh/voice/separate.py | UVR MDX-Net 人声分离 |
| mix.py | /root/.dsh/voice/mix.py | 人声与伴奏混音 |

运行环境：

- Python：/root/.dsh/bili-duty/.venv/bin/python
- 跑 sherpa-onnx 必须 `PYTHONPATH=/root/.dsh/voice/lib`
- 模型目录：/root/.dsh/voice/models/（MeloTTS、uvr/voc_ft.onnx、RVC Dv5）
- edge-tts 在 /root/.dsh/voice/lib

改动时注意（都是踩过的坑）：

- say.sh 的探活是 2.5 秒，别改成 1 秒，抖动会误判离线、声音突然变掉。
- rvc_onnx.py 里 OLA 已合入，别再拿 /sdcard/rvc/patch 下的旧补丁盖回去。
- RVC 输出 40kHz，和 44.1k 伴奏混音前要 resample_poly(441,400)。
- 混音要给人声单独限幅（clip 0.75），否则会削波。
- 手机说话 50 秒里约 10 秒是模型冷启动，属正常，不是卡死。

本目录只是交接副本，手机上的运行脚本没动。
