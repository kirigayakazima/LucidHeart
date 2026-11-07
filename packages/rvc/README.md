# @dsh/rvc

本地源码 0.2.11。默认声库为 Feiyu feiyu-rvc-v1，使用晓晓干声，日常音高 -4、语速 +0%。强正向兴奋时使用音高 0，疲惫时放慢至 -6%。Float64 NSF 相位修正、l2-8 索引与外置模型路径保留。Dv5 仍可显式选择。

## 实际链路

文字→配置的TTS→包内共享ONNX运行时→WAV→QQ语音发送。优先尝试FullAwake受控PC计算，校验资产hash/设置/音频SHA与格式，落到手机本地再发；失败回退同声库手机，取消不继续回退。Heart/QQ/pcBridge通过可选服务读取，实际结果报告mode/offload/sent_to_qq/heart_observation/activity_gate。生成成功不等于发送成功。

voiceProfile显式路径优先，无效/缺模型明确失败，不静默切声库或假成功。手机资产在/sdcard/rvc/models/feiyu-rvc-v1/voice-profile.json；profilePython填真实容器解释器。PC使用既有项目uv推理环境和受控profile。推理共享vendor/phone/rvc_onnx.py，无需Torch；导出依赖另管。

## 长语音

先生成整段 TTS，保留原韵律。长句优先在实际停顿切分，PC 分流优先匹配标点附近的停顿，无明显停顿时使用低能量区。每段中心不超过 8 秒，带上下文保持在连续声码器的 1000 帧保护范围内。PC 分流和手机本地路径按原时间轴合并，在接缝前后各 50 毫秒做 Hann 交叉淡入淡出。短句沿用单段路径。

配合手机/PC FullAwake0.2.1：WAV8MiB、JSON流式12MiB、PC/请求超时290/300秒。PC仍限制200字符及单任务，非无限资源。取消和QQ实际投递沿用原契约，不是音频边生成边播或实时通话。

已有本地证据：6.6秒短句新旧WAV相同；20.6秒完整输出；真实TTS/HTTP18.768秒、约1.5MB回包通过同款Node校验。手机ARM64长句、接缝听感和QQ长语音仍待用户验收，不能宣称已无杂音/通用时延达标。

## 其他边界

用户请求按宿主来源免自主配额。默认 Feiyu 路径将声学映射传给干声生成和 PC 分流，Build190 听感验收待完成。Edge 前置表达实验另见[试听说明](VOICE-AUDITION.md)和[表达实验](EDGE-EXPRESSION.md)。

rvc_sing目前not_supported，未接分离/RVC/混音/投递完整链。CosyVoice不是RVC checkpoint，不能混装或承诺同栈支持。默认插件测试不生成付费音频或向QQ发送。

测试：`node --test test/*.test.js`；Python回归用既有uv音频环境。发行通过PC闭包、SHA和Build190原生事务，当前工作区交付说明在docs/handoff/HEART-VOICE-UPDATE-20261104.md；不沿用手工链接安装器。
