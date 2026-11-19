# LucidHeart / HeartAwake Suite

自研核心源码 Monorepo：`packages/{heart,memory,qq-plus,rvc,sticker-look,fullawake,companion,evolution,voice-duplex,heart-wake,xhs-scroll}`，PC 节点 `apps/fullawake-pc`，只读工具 `tools/memory-shape`，预设与锁清单 `manifests/`。当前组合源码版本对应 **Suite 0.11.0 + `suite-full-20261118`**（清单不是手机实时加载探针，真实运行事实见工作区 `docs/STATUS.md`）。

| 模块 | 当前源码 | 职责 |
|---|---|---|
| `@dsh/heart` | `0.21.4` | 状态机、Mood 2.0、作息/23:00–07:00 安静时段（用户主动请求豁免）、Protocol v1 门控与 AgencyArbiter |
| `@dsh/memory` | `0.1.8` | 不可变 `journal.jsonl` 记忆真源、FTS5、出处溯源、跨会话首轮接力 `handoff.js`、独立视觉相册 `album.jsonl` |
| `@dsh/qq-plus` | `0.3.1` | 双角色（小满/阿醒）唤醒门控、情绪断句节奏、多目标隔离路由与方案 D 轻量能力路由 |
| `@dsh/rvc` | `0.2.19` | BreezeBlue 云端拟人少女音、自主发声心智、Feiyu RVC ONNX 本地回退、PC 桌宠默认直出与 GPU 异步点歌 |
| `dsh-fullawake` / `fullawake-pc` | `0.2.11` | PC 感官桥、游戏点播与被动守望、`region` 局部变焦、桌宠播放租约、`faster-whisper` 中文 ASR 与 `RCtrl` 按住说话（PTT） |
| `@dsh/voice-duplex` | `0.1.1` | 显式连麦通话开关、Epoch 物理打断、草稿/定稿分离与挂断三轮话题接力 |
| `dsh-sticker-look` | `0.2.4` | 零依赖 GIF 抽帧、384-token 接触表分镜与按需局部细节 |
| `dsh-heart-wake` | `0.1.0` | 防自激自唤醒工具（单轮锁、安静时段闸、SQLite 滚动配额） |
| `dsh-companion` | `0.1.0` | 活动骨架、20 问/成语接龙、点歌台、持续小项目、空闲/返回关怀与 SQLite 任务账本 |
| `dsh-evolution` | `0.1.0` | 姐妹签名协作信道、月度真实成长手账、40 场景防变笨回放、模型对照、技能沙箱与微调脱敏导出 |
| `@dsh/xhs-scroll` | `0.1.0` | 小红书单条图文点读、384-token 宫格接触表与分享卡片降级 |

小满主脑与私有记忆在手机，阿醒独立；`Memory` 不是 PC 算力桥的人格副本。模型资产、环境、凭据和私人 `local/` 不打进 npm 包或提交公开仓库。

研发工作区状态、手机实装记录与后续路线图统一维护在工作区 `docs/STATUS.md`、`docs/handoff/CURRENT.md` 与 `docs/roadmap/`。PC 开发使用 `pnpm` 与项目 `uv` 环境（清华源）；手机端一律走 PC 打包、SHA-256 校验与 Proot 原生事务安装，禁止公网 `git`/`npm` 和手工 `node_modules` 软链。

- [组件锁清单](manifests/components.lock.json)
- [Memory Shape 工具](tools/memory-shape/README.md)
- [Heart 协议](packages/heart/contracts/protocol.md)
- [Memory 当前契约](packages/memory/README.md)
- [RVC 实现](packages/rvc/README.md)
- [FullAwake PC](apps/fullawake-pc/README.md)
- [Voice Duplex](packages/voice-duplex/README.md)
- [Companion](packages/companion/README.md)
- [Evolution](packages/evolution/README.md)
