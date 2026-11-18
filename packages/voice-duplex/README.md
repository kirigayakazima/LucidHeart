# Voice Duplex 沙盒

沙盒独立监听 Windows 本机回环。浏览器得到用户许可后，才开启麦克风和设备 AEC。AudioWorklet 以 16 kHz 单声道输出 32 ms 帧，常驻 Silero CPU ONNX worker 返回语音概率。回声残留相关性检查使用本机播放参考，队列最多保留 4 帧。

检测到讲话时，浏览器停止本机 Web Audio 播放并更新 `audio_epoch`。浏览器向本机服务发送 16-bit PCM，服务对 Silero 转换为浮点。迟到帧、过期租约和旧连接不能继续提交数据。启用本机 FullAwake ASR 后，页面显示同一回合的草稿和定稿。200 毫秒静音在完整 32 毫秒帧上判定，最早在第七帧确认。

## Windows 启动

在工作区根目录运行。Silero 权重保存在包外目录。Python 路径需要指向由 uv 管理且已有 `numpy` 和 CPU `onnxruntime` 的环境。

```powershell
$pcPython = (Resolve-Path 'projects/lucidheart/apps/fullawake-pc/.venv/Scripts/python.exe').Path
$sileroModel = 'D:/models/silero-v6.2.3.onnx'
$sileroHash = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
node projects/lucidheart/packages/voice-duplex/lib/server.js --python $pcPython --model $sileroModel --sha256 $sileroHash
```

上例 SHA 对应 [Silero v6.2.3 的标准 ONNX 模型](https://github.com/snakers4/silero-vad/blob/v6.2.3/src/silero_vad/data/silero_vad.onnx)。用启动时打印的完整本机地址打开沙盒，点击开启麦克风，再选择本地音频播放。可选的 `DUPLEX_ASR_URL` 指向 `http://127.0.0.1:8765/v1/voice/asr`。如需使用令牌，由当前进程的 `DUPLEX_ASR_TOKEN` 传入。

页面可导出队列、丢帧、回声抑制计数、首声估计和打断延迟。扬声器与耳机应分别累计至少 40 轮。首声估计取自本地解码波形和 Web Audio 时钟，物理设备到耳端的延迟需要现场测量。当前沙盒播放本地音频，与 QQ 会话分开。

## 连接手机 DSH

在手机 DSH 加载 `@dsh/voice-duplex` 0.1.1、Memory 0.1.8 和 FullAwake 0.2.10。在 FullAwake 配置 `voiceEpochProtocol: true`、明确的 `duplexTarget`（DSH agent ID）及允许开启通话的本人私聊 `duplexQqSessions`。PC Node 进程设置 `DUPLEX_FORWARD_TO_HOST=1`，同时提供 `DUPLEX_ASR_URL` 与网关配置一致的 `DUPLEX_ASR_TOKEN`。浏览器开启麦克风后，向小满说“开启通话”，由 `voice_call_toggle({enabled:true})` 开启定稿投递。草稿只用于显示，VAD 结束后的定稿最多向指定 agent 提交一次。

通话中说“先挂了”，或调用 `voice_call_toggle({enabled:false})` 结束。手机撤销发声租约并将最近三轮实际对话交给 Memory 原子写入 `last_handoff.json`，QQ 本人私聊下一轮可自然续接。断桥也会结束并保存接力。PC 浏览器的麦克风许可与捕获开关由用户控制，挂断后可在页面关闭麦克风。

FullAwake 的 `/v1/voice/rvc/stream` 接受原 RVC 文本请求及 `audio_epoch`，返回逐句 NDJSON 音频。消费者按当前 epoch 接收，并在中止时关闭响应流。指定会话中的 `pc_duplex_speak` 经同一个分句工作器按桌宠播放回执逐句推进。耳机环境可为 PC 进程设置 `DUPLEX_AUDIO_ROUTE=headphone`，跳过桌宠扬声器参考过滤。
