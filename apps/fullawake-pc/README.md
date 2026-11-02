# FullAwake (全觉)

FullAwake 是为手机端小满（DSHA）构建的 PC 端感官与具身能力扩展矩阵（Body & Sensor Gateway）。

## 核心设计理念

1. **唯一主脑**：小满的人格、情绪（Heart）、长期记忆（Mnemon）与 QQ 交互永久驻留在手机端。
2. **PC 身体外设**：PC 端作为外设感知节点，通过标准 MCP（Model Context Protocol）协议向手机提供视觉、文件和操作能力。
3. **姐姐阿醒数据隔离**：PC 上的姐姐阿醒保留完全独立的 DSH 与 Heart 数据，FullAwake 底层策略引擎严格禁止越界访问阿醒的任何私有目录与会话。
4. **安全只读先行 (v0.1)**：第一阶段仅开放受控只读感知，所有高危动作均受安全网关拦截。

## v0.1 能力清单

- `pc_status`: 检测 PC 是否在线、当前交互桌面状态、分辨率与能力清单。
- `pc_list_windows`: 列出 Windows 当前可见顶层窗口（标题、进程名、坐标、窗口句柄 ID）。
- `pc_snapshot`: 拍摄指定窗口或全屏画面，经压缩适配小满多模态视觉 Prompt。
- `pc_read_file`: 在受限白名单工作区内读取文件，支持行范围与大小限制。

## v0.2 可选语音算力

新增 `POST /v1/voice/rvc`，默认关闭，沿用Bearer鉴权，并额外限制客户端IP。只接受短文本、固定音色ID/资产hash及有界声学设置；执行PC本地配置的RVC worker，不接受远程命令或路径。一次只运行一个任务，超时/断连会终止推理子进程，临时文件在核验过的工作目录内清理。

PC返回40k WAV内容、SHA和实际CPU运行方式；手机校验并落盘后由RVC投递QQ。PC不读取手机的记忆/人格，不访问阿醒的DSH数据。当前方式是 `pc_onnx_offload` / CPUExecutionProvider，尚未将此接口接到GPU。

从仓库目录启动，使用本项目uv环境和现有RVC uv环境：

```powershell
& ./apps/fullawake-pc/scripts/start_voice_gateway.ps1 -Background
```

默认绑定PC回环地址。连接已授权USB设备后，建立独立的反向TCP通道：

```powershell
uv run --no-project python apps/fullawake-pc/scripts/connect_usb.py --serial <ADB设备序列号>
```

手机 FullAwake 的 `gatewayUrl` 设置为 `http://127.0.0.1:28765`，保留双方匹配的 `authToken`，由手机Proot侧更新配置并热重载。PC端口8765、手机回环端口28765，不占用手机已有8765服务。USB断开/ADB重启后重新执行connect_usb；它拒绝覆盖另一个已有映射。USB不通时RVC回退手机，普通局域网方式仍可按实际IP配置。

如需LAN，应显式传 `-BindAddress <PC局域网IP> -VoiceClients <手机IP>,127.0.0.1`，配置自己的Bearer token，并在本机按实际网络策略开放受限端口；不要把LAN未通误判成合成失败。启动脚本不更改防火墙、不创建开机计划、不输出token。PC重启后需重新启动网关。

可使用 `-VoiceProfile` 和 `-VoicePython` 指定受控本地配置/解释器；环境变量为 `FULLAWAKE_VOICE_ENABLED`、`FULLAWAKE_VOICE_PROFILE`、`FULLAWAKE_VOICE_PYTHON`、`FULLAWAKE_VOICE_CLIENTS`、`FULLAWAKE_VOICE_WORK_DIR`。模型完全独立于代码包，客户端模型hash不同会拒绝分流，不能默默换音色。

## 启动方式

```powershell
# 1. 运行网关
.\scripts\start_gateway.ps1

# 2. 运行测试
.\scripts\run_tests.ps1
```
