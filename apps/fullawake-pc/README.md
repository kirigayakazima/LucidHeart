# FullAwake PC

本地源码0.2.1。小满的主脑/Heart/Memory仍在手机，阿醒独立；PC网关不读取阿醒私有DSH数据，不充当另一份小满。当前PC运行版本须查/health，源码或端口存在不证明已重载。

## 现有能力

pc_status、pc_list_windows、pc_snapshot、pc_read_file受控只读感官；文件白名单/拒绝目录/大小限制按core策略。截图字节保存为宿主attachment后才可能成为模型图像，完整路径需端到端验收，工具文本说成功不够。

POST /v1/voice/rvc为单独显式开启的语音计算，Bearer加客户端IP校验，固定本地worker，只接受文本/固定音色hash/白名单设置，不接受任意路径/命令/解释器。单任务，断连/超时终止子进程，临时目录受控。

0.2.1音频上限8MiB、PC超时290秒；手机适配器0.2.1流式JSON上限12MiB/超时300秒。RVC0.2.4在完整TTS后分段变声并合并，PC文本最多200字符。40kHz WAV内容/hash/实际provider回传，手机验证后发送QQ，PC不代报送达。

CPU回传有手机实测；源码支持可选CUDA参数并有实验，尚不能据此宣称GPU常驻或新手机GPU全链验收。调用仍按请求启动worker，不是实时推理服务器。

## 启动与配置

从Suite根使用apps/fullawake-pc/scripts/start_voice_gateway.ps1 -Background；默认PC回环8765。USB工具scripts/connect_usb.py建立手机回环28765→PC8765，手机gatewayUrl对应http://127.0.0.1:28765。双方authToken保留本地配置，不输出。USB断开/ADB重启后需重建隧道，不改防火墙。

Python环境和依赖统一本项目uv .venv与清华源；声库/语音运行环境外置。当前启动脚本也可使用机器已配置的解释器/推理库，须按实际指纹验证，不能从目录存在推断环境可重现。网关重启短暂中断能力，不重启手机App。

测试用tests/test_voice.py、tests/test_mcp_gateway.py等，在隔离环境运行；不得把测试客户端的HTTP200当生产QQ验收。新增provider保留身份/路径限制、限并发和真实回执。

## QQ 语音条转录

`POST /v1/voice/asr` 接收 Silk、WAV、AMR 或 MP3 二进制，返回文字、时长与语言。回环调用可直接发送音频。无法识别时返回 `AUDIO_UNCLEAR`。

在 FullAwake PC 项目目录给现有 uv 环境安装推理依赖。

```powershell
uv pip install --python .venv/Scripts/python.exe --index-url https://pypi.tuna.tsinghua.edu.cn/simple faster-whisper==1.2.1 pilk==0.2.4
```

将 [Faster-Whisper Base 模型](https://huggingface.co/Systran/faster-whisper-base) 放到 Suite 的 `local/fullawake/faster-whisper-base`，保留模型和 tokenizer 文件。启动脚本默认使用该目录，也可在启动前设定 `FULLAWAKE_ASR_MODEL_DIR`。推理使用本机 CUDA 和 cuDNN。
