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

## 启动方式

```powershell
# 1. 运行网关
.\scripts\start_gateway.ps1

# 2. 运行测试
.\scripts\run_tests.ps1
```
