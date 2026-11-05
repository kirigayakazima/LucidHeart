# @dsh/heart

本地源码0.21.1，Heart Protocol1.0.0。DSH负责模型/会话/工具，Heart负责Mood（valence/arousal/energy三个维度）、presence、自我原则、表达偏好与节律；执行器和记忆核心保持独立。

## 现有接口

getSnapshot只读冻结状态；evaluateActivity进行活动适宜性判断；observe接收type/source/confidence/evidence；heart/state-changed通知变化。可选服务用宿主ctx.get读取，未声明inject不能直接访问ctx.heart。协议细节见[contracts/protocol.md](contracts/protocol.md)。

用户请求来源从宿主执行上下文推断，免自主总额/类别额度，但静音等其他门控保留；unknown仍受自主限制。模型不能自报user_request，测试不可重置6/6。heart_next排下一次机会而非承诺兑现；0.21.1补齐origin/categoryQuotaRecorded输出schema。旧版先执行后校验，报错时也可能已写nextIdleAt，不盲重试。

expressionEnabled/expressionMode/expressionExamples控制conversation-v1可关闭场景策略，一次主模型生成，不改Notebook或追加润色模型。与QQ语义气泡的体验需真实验收。

## 记忆职责

memoryMode在Heart数据根config.json配置。external时保留Mood/Voice/Notebook/Body/Sense/Trigger及受控Dream，关闭旧facts/MEMORY新增修订删除和自动注入；旧档案只读、不自动迁移。当前生态外部记忆为自研@dsh/memory，不再指导安装Mnemon。

模式切换涉及写入权威，先核对实际数据根/当前运行配置与备份，不能为表达或新装直接切legacy、导入覆盖配置或双写。Notebook原则仍走显式确认；Dream确认/晋升不等于Memory目标已落地。

## 运行证据

runtimeDiagnostics可关闭；加载后每60秒在heart/logs/runtime.jsonl记录Node进程元数据，卸载清理/重新加载恢复。runtime-faults.jsonl单独留致命异常元数据；pulse.log仅500行节律窗口。观察uncaughtExceptionMonitor，不吞异常、不自动重启，不保存聊天正文/口令。

这些记录不是整个Proot的RSS或Android生命周期控制，停更/无退出行不证明唯一死因。样本/轮转与源码定义为准，实际加载和设备结论另留证。

测试：`node --test test/*.test.js`。工具需经过实际SDK校验参数与输出，单测直接execute不够。状态/策略/协议和真实加载分开记录，源码版本不是生产验收。
