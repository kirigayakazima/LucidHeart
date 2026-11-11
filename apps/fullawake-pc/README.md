# FullAwake PC

小满的主脑、Heart 和 Memory 在手机，阿醒独立运行。以 `/health` 核对当前 PC 网关进程版本。

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

## 独立桌面挂件

新版挂件在独立 PySide6 进程连接 `ws://127.0.0.1:8765/ws/pet`，显示小满的气泡和点头、微笑、挥手、惊讶。它从 WAV 样本振幅和 Qt 的播放位置计算三档口型。左键拖动，右键关闭。

在 FullAwake PC 目录安装 Windows 挂件依赖，再从工作区根双击 `start_widget.bat`。也可用命令启动。

```powershell
uv pip install --python .venv/Scripts/python.exe --index-url https://pypi.tuna.tsinghua.edu.cn/simple 'PySide6-Addons==6.11.3' wsproto
$env:PYTHONPATH = 'src'
uv run --no-sync python -m fullawake.widget --watch
```

挂件支持 `--gateway-port`、`--name` 与 `--portrait`。旧本机音频监视仍可用 `scripts/start_widget.ps1 -Legacy` 启动，使用 127.0.0.1:8766 和原有 `/clock` 接口。

## 小满心智 2.0 · PC 语音打断

Phase 1 候选提供 `/ws/bridge`。手机从 ADB 回环 `ws://127.0.0.1:28765/ws/bridge` 主动连接，PC 网关在 8765 接受无 Origin 的回环请求，并校验 `Authorization: Bearer <FULLAWAKE_AUTH_TOKEN>`。沿用桌宠的 `FULLAWAKE_WATCH_TOKEN` 启用条件。握手成功后才尝试打开麦克风，断线会停止采集并撤下该连接的音频。

- `VOICE_VAD_ENABLED` 默认 `true`。设为 `false` 后重启网关即可关闭麦克风打断，握手会返回 `vadSupported: false`。可用 `FULLAWAKE_VAD_DEVICE` 选择支持 16 kHz 单声道的设备索引。
- `EPOCH_REVOCATION_ENABLED` 默认 `true`。设为 `false` 后重启网关即可禁用整个新桥接路由。旧版陪看继续走 `/v1/watch/reaction`。
- 手机为每次新连接生成 `connectionId`。握手的 `initialEpoch` 是最低可用值，手机签发每次发言的 Epoch。PC 保留 60 秒撤销记录，并在整条连接内拒绝旧水位，即使撤销记录已过期。忙碌或检测到近端说话时收到的语音指令会被丢弃，后续发言应使用新 Epoch。
- PC 收到 `audio.speak` 后使用本地配置的 `feiyu-rvc-v1` 合成，复用现有 RVC worker。由桌宠确认本地停声后，网关才报告 `localAudioStopped: true`。本阶段的采集验收以耳机为条件，扬声器回声消除尚未接入。

在 FullAwake PC 目录安装和运行测试。

```powershell
uv pip install --python .venv/Scripts/python.exe --index-url https://pypi.tuna.tsinghua.edu.cn/simple sounddevice webrtcvad-wheels
$env:PYTHONPATH = 'src'
$env:QT_QPA_PLATFORM = 'offscreen'
.\.venv\Scripts\python.exe -m pytest -q
```

延迟探针需要桌宠源码和一段裁掉开头静音的 16 kHz 单声道 PCM16 WAV。它在隔离回环端口使用真实 WebRTC VAD、WebSocket 和 Qt 播放器，注入语音 PCM 并保持音频输出静音。结果按播放器停止状态计时。

```powershell
$env:PYTHONPATH = 'src;..\..\..\dsh-pet-indesktop'
.\.venv\Scripts\python.exe scripts/measure_voice_interrupt.py '.\speech.wav' --samples 50
```

### Phase 2 手机建连与陪看结算

手机 FullAwake 0.2.6 默认关闭 `voiceEpochProtocol`。打开后，插件主动连接本地 ADB 反向地址，`bridgeUrl` 留空时从 `gatewayUrl` 推导。启用陪看租约需要本阶段的 PC 网关和桌宠代码，握手回执用 `turnLifecycle: true` 声明能力。旧网关与旧 HTTP 陪看可继续使用关闭状态。

- 手机先用 `audio.prepare` 取得 `audio.prepared`，再启动模型。手机对同一租约发 `audio.speak` 或 `pet.text`。打断时手机立即取消 LLM 并回复 `audio.interrupt_ack`，PC 同时取消在途合成或播放。
- 在手机 Heart 配置打开 `agency2PCQuota` 才启用自动陪看的两阶段记账。收到关联的 `audio.result`，且桌宠明确报告播完或文字已显示，才写入 `trigger.json`。打断、掉线、未展示及超时释放预留。手动陪看工具由发起回合负责配额归属。
- 独立于陪看的 Heart 节律 `agent.followup` 沿用原记账时机。宿主接口确认入队，相关通道尚缺逐回合的实际送达回执。

在 LucidHeart 仓库根目录执行 `pnpm test`。PC 网关回归入口为 `tests/test_voice_bridge.py`，桌宠回归入口为 `tests/test_fullawake_bridge.py`。

### Phase 3 陪看仲裁

`watchDecisionMode` 默认 `legacy`，沿用现有陪看。PC 在只读时钟摘要中提供最新画面候选的时间和差分值。Heart 在手机侧计算决策，按沉睡、北京时间静音期、最近一次打断后的 30 秒冷却及当日配额顺序门控。配额判断包含在途预留。

- `shadow` 只请求时钟摘要，把候选时间和差分值交给 `heart.observe()`，并记录 Heart 仲裁结果。该模式可在桌宠离线时运行。分镜、模型、TTS、动作下发和配额预留均不参与；手动陪看感想工具返回 `shadow`。
- `heart` 由 Heart 先决定是否选择 `SPEAK`。只有 `SPEAK` 可以进入自动陪看生成，且需要开启 `voiceEpochProtocol`、`agency2PCQuota` 并取得租约及配额预留。桌宠确认交付后沿用 Phase 2 结算。其他动作保留在决策日志。
- 决策写入 Heart 数据目录的 `logs/core.log`，事件为 `agency_decision`，字段包括前后状态、门控原因和候选评分。记录不带图像、标题或字幕。旧 PC 网关未提供差分值时，Heart 将该候选判为证据不足。

## 实时陪看

1. 在 PC 启动 FullAwake 0.2.5 前设置一枚独立采集令牌。语音网关启动脚本继承该环境变量。启动后检查 `/health`。分镜渲染使用主权 `dsh-video-storyboard` 的本地源码及 `PATH` 上的 Node.js。

   ```powershell
   $env:FULLAWAKE_WATCH_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   .\scripts\start_voice_gateway.ps1 -Background
   ```

2. 在 Chrome/Edge 的扩展管理页开启开发者模式，加载当前项目的 `browser-watch` 目录。在扩展选项填写同一令牌和网关端口。打开 B 站普通 BV 视频页，点扩展图标开始分享，再点一次停止。`ON` 表示时钟已送达，`CLK` 表示只能读到时钟，`ERR` 表示网关或配对失败。
3. 手机通过现有 USB 回环 28765 访问 PC 8765。`pc_watch_get_summary` 返回已播区间、已播完的浏览器字幕及至多一张 768×768 分镜。字幕来自浏览器开放的 `TextTrack`，未提供时返回空数组。384 是每张图的预算，供应商计量需单独核对。`pc_watch_control` 支持 `pause`、`play` 和 `sensitivity`，播放命令先排队，浏览器回执随后出现在摘要里。
4. 在手机 `dsh-fullawake` 配置 `watchProvider`、`watchModel` 为已有视觉模型。用户在小满会话里用 `pc_watch_auto` 开启或关闭自动陪看。`voice:true` 使用已加载的 RVC 0.2.13，省略时仅发气泡。也可在同一会话用 `pc_watch_react` 发送与最近 `cueId` 对应的一句感想。

网页只上传用户明确共享的播放器画面。网关按播放秒数保留候选帧，拖动进度后另起时间线。手机在反应前后检查 Heart，按 `Asia/Shanghai` 执行静音期。模型或语音超时、播放进度越过片段 15 秒、暂停、切换或断连都会取消待发反应。PC 只采集、合成与呈现，离线刷视频仍由手机原有插件处理。

自动模型调用只带一张图，完成后释放插件持有的引用。附件存储由宿主管理。桌宠接收手机反应，不启动模型、不发送 QQ 消息。

## 旧版播放监视

在 FullAwake PC 目录使用现有 uv 环境。

```powershell
uv sync --locked --inexact --extra widget
uv run --no-sync python -m fullawake.widget
```

打开启动时打印的完整地址，在浏览器中选择本地音频。默认立绘随呼吸、眨眼和三档口型变化，播放结束或断连后关闭口型。左键拖动，右键关闭。可通过 `--name` 和 `--portrait` 指定显示名称与本地 PNG。

可在 PC 端 Heart 配置 `widgetSocket`，值为 `ws://127.0.0.1:8766/clock?token=<挂件令牌>`。连接后挂件显示 Heart 的休息、倾听和思考状态，`heart_motion` 可提交点头、微笑、挥手意图。手机 QQ 对话通过现有链路运行。
