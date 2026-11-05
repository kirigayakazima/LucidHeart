# LucidHeart / HeartAwake Suite

自研核心源码monorepo：packages/{heart,memory,qq-plus,rvc,sticker-look,fullawake}，PC节点apps/fullawake-pc，只读工具tools/memory-shape。当前Suite0.3.2是组合源码/发行版本，不是DSH宿主或手机loaded证明。

| 模块 | 当前源码 | 职责 |
|---|---|---|
| Heart | 0.21.1 | 状态/节律/门控/原则/表达策略，Protocol1.0.0 |
| Memory | 0.1.1 | journal、FTS与薄适配；来源/提交可靠性仍需下一阶段 |
| QQ Plus | 0.3.0 | 双角色、完整回复语义气泡、按目标取消 |
| RVC | 0.2.4 | Feiyu语音、停顿分段长句、QQ自动投递与同声库回退 |
| FullAwake手机/PC | 0.2.1 | 受控PC感官/语音计算与音频回传；非通用远控 |
| Sticker Look | 0.2.3 | 动图抽帧、接触表和按需细节 |

小满主脑/私有记忆在手机，阿醒独立。Memory不是PC算力桥的人格副本。模型资产、环境、凭据和私人local不打进npm包或提交公开仓库。真实唱歌、GPU常驻、实时音视频、完整ContextPolicy及数字生活协调尚未完成。

当前事实、加载状态、测试边界与手机安装步骤统一维护在研发工作区docs/STATUS.md和docs/handoff/CURRENT.md；该工作区不是本仓库的父级公开内容。可独立阅读各package README/协议与manifests/components.lock.json，不能把manifest当实时探针。

PC开发用pnpm和项目uv环境（安装用清华源）；手机只接受PC闭包发行、SHA校验和Build190原生事务安装，禁止公网git/npm和手工node_modules链接。新增工具实际SDK输出校验必跑。不要为语音测试改自主6/6。

本轮237项检查/CPU长语音证据及上一轮表达验证是已跑快照，不是泛化性能/自然度分数；文档整理未重跑生产测试。代码更改后按影响范围重新测，真实手机/用户听感另验。旧发行件和其校验单不随README整理重写。

[Memory Shape工具](tools/memory-shape/README.md)、[Heart协议](packages/heart/contracts/protocol.md)、[Memory当前契约](packages/memory/README.md)、[RVC实现](packages/rvc/README.md)、[FullAwake PC](apps/fullawake-pc/README.md)。
