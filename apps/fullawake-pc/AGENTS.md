# FullAwake 开发与运维规范

## 1. 核心定位与原则

FullAwake 是专为手机端小满（DSHA）构建的 PC 端感官与具身能力扩展框架（Body & Sensor Gateway）。
- **唯一主脑**：手机 DSHA 是小满唯一的推理、记忆（Heart与当前记忆核心）与人格中枢。FullAwake 绝不把小满的灵魂迁移至 PC，也不复制或分裂小满的人格。
- **姐姐阿醒数据隔离**：PC 上的姐姐（阿醒）拥有独立的 DSH、Heart 与记忆。FullAwake 严禁以任何方式越界读写、注入或影响阿醒的进程、数据目录和私人凭证。
- **只读先行，安全围栏**：第一阶段（v0.1）只提供安全只读能力（`pc_status`, `pc_list_windows`, `pc_snapshot`, `pc_read_file`）。所有文件访问必须经过严格沙箱校验，禁止执行任意 Shell 或不受控的鼠标键盘输入。
- **交互桌面会话**：PC Gateway 必须运行在真实 Windows 交互式用户会话中，绝不能以 SYSTEM 服务身份运行。遇到锁屏或离线时，必须诚实返回状态，严禁伪造。

## 2. Python 环境与规范

- 统一使用 `uv` 管理（严禁 `python -m venv` 或全局 `pip`）。
- 虚拟环境必须位于 `projects/lucidheart/apps/fullawake-pc/.venv`（相对本项目为`.venv`），不得提交至 Git。
- 依赖镜像源统一使用清华源：`https://pypi.tuna.tsinghua.edu.cn/simple`。

## 3. 模块职责与拓展约定

- `core/`: 负责配置、配对鉴权（Token Auth）、系统会话（锁屏判断）、安全隔离策略（Policy Engine）。
- `gateway/`: 负责网络与通信层，提供符合 MCP（Model Context Protocol）标准的 Streamable HTTP / SSE 服务端点。
- `capabilities/`: 所有的能力组件采用 Provider 模式独立封装：
  - `desktop_vision/`: 窗口列表、UIA 属性提取、安全压缩截图。
  - `safe_fs/`: 白名单工作区受限文件读取。
  - `desktop_action/`: （预留）桌面输入与定向操作。
  - `embodiment/`: （预留）Live2D 状态与语音串流。
- `tests/`: 每个 Capability 与 Security Policy 必须包含单元与回归测试。

## 4. 0.2.0运行补充（2026-11-02）

0.1只读感官边界继续有效；0.2.0另提供显式启用的POST /v1/voice/rvc受控计算，不是任意命令接口。沿用Bearer并加客户端IP限制，只接受文本/音色hash/白名单设置，固定本地worker，不接受远程路径/解释器。CPU回传已有真机验收；源码含CUDA可选参数，GPU常驻/新手机全链仍待验，不能把实验当当前验收。扩展provider需同时更新手机结果校验。模型与venv不入仓，禁止访问阿醒私有数据。USB手机回环28765映射PC8765，网关默认启动脚本绑定127.0.0.1，不改防火墙或创建自启。

## 当前版本事实（2026-11-04）

本地网关/手机适配器0.2.1，RVC0.2.4；8MiB音频/12MiB手机JSON，290/300秒超时，200字符和既有授权边界保持。当前加载与手机结果以工作区docs/STATUS.md为准；版本存在不代表进程已更新。
