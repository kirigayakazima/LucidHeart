# Voice Duplex 沙盒

沙盒独立监听 Windows 本机回环。浏览器得到用户许可后，才开启麦克风和设备 AEC。AudioWorklet 以 16 kHz 单声道输出 32 ms 帧，常驻 Silero CPU ONNX worker 返回语音概率。回声残留相关性检查使用本机播放参考，队列最多保留 4 帧。

检测到讲话时，浏览器立即停止本机 Web Audio 播放，清空待发帧并更新 Epoch。迟到帧、过期租约和旧连接不能继续提交数据。启用本机 FullAwake ASR 后，沙盒仅显示同一回合的转录终稿。音频在内存中处理。

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
