# FullAwake 开发与运维规范

## 1. 核心定位与原则

FullAwake 是专为手机端小满（DSHA）构建的 PC 端感官与具身能力扩展框架（Body & Sensor Gateway）。
- **唯一主脑**：手机 DSHA 是小满唯一的推理、记忆（Heart/Mnemon）与人格中枢。FullAwake 绝不把小满的灵魂迁移至 PC，也不复制或分裂小满的人格。
- **姐姐阿醒数据隔离**：PC 上的姐姐（阿醒）拥有独立的 DSH、Heart 与记忆。FullAwake 严禁以任何方式越界读写、注入或影响阿醒的进程、数据目录和私人凭证。
- **只读先行，安全围栏**：第一阶段（v0.1）只提供安全只读能力（`pc_status`, `pc_list_windows`, `pc_snapshot`, `pc_read_file`）。所有文件访问必须经过严格沙箱校验，禁止执行任意 Shell 或不受控的鼠标键盘输入。
- **交互桌面会话**：PC Gateway 必须运行在真实 Windows 交互式用户会话中，绝不能以 SYSTEM 服务身份运行。遇到锁屏或离线时，必须诚实返回状态，严禁伪造。

## 2. Python 环境与规范

- 统一使用 `uv` 管理（严禁 `python -m venv` 或全局 `pip`）。
- 虚拟环境必须位于 `projects/fullawake/.venv`，不得提交至 Git。
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
