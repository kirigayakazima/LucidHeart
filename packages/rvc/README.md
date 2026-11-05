# @dsh/rvc

本地源码0.2.4。当前默认声库Feiyu feiyu-rvc-v1，经用户短句听感认可；Float64 NSF相位修正与l2-8索引保留。Dv5只作显式后备，不自动换声库。音高政策0/-4，禁止-2。大模型/索引外置，不在npm包。

## 实际链路

文字→配置的TTS→包内共享ONNX运行时→WAV→QQ语音发送。优先尝试FullAwake受控PC计算，校验资产hash/设置/音频SHA与格式，落到手机本地再发；失败回退同声库手机，取消不继续回退。Heart/QQ/pcBridge通过可选服务读取，实际结果报告mode/offload/sent_to_qq/heart_observation/activity_gate。生成成功不等于发送成功。

voiceProfile显式路径优先，无效/缺模型明确失败，不静默切声库或假成功。手机资产在/sdcard/rvc/models/feiyu-rvc-v1/voice-profile.json；profilePython填真实容器解释器。PC使用既有项目uv推理环境和受控profile。推理共享vendor/phone/rvc_onnx.py，无需Torch；导出依赖另管。

## 长语音

0.2.4移除整段干声>=10秒拦截。保留整段TTS的韵律，按实际停顿分段，无明显停顿低能量兜底。每段中心<=8秒、带上下文低于连续声码器1000帧保护；同一组模型/索引会话内处理后按原时间轴合并，边界5ms斜坡，不重叠混音有声区域。短句<=8秒保留原路径，不靠删字或截尾过关。

配合手机/PC FullAwake0.2.1：WAV8MiB、JSON流式12MiB、PC/请求超时290/300秒。PC仍限制200字符及单任务，非无限资源。取消和QQ实际投递沿用原契约，不是音频边生成边播或实时通话。

已有本地证据：6.6秒短句新旧WAV相同；20.6秒完整输出；真实TTS/HTTP18.768秒、约1.5MB回包通过同款Node校验。手机ARM64长句、接缝听感和QQ长语音仍待用户验收，不能宣称已无杂音/通用时延达标。

## 其他边界

用户请求按宿主来源免自主配额；不为测试改6/6。现有profile值与Mood/显式声学映射是否逐项生效仍需验证，不把输出参数展示当引擎已动态应用。Edge前置表达是可选实验，按[试听说明](VOICE-AUDITION.md)、[表达实验](EDGE-EXPRESSION.md)比较，不自动替换用户认可基线。

rvc_sing目前not_supported，未接分离/RVC/混音/投递完整链。CosyVoice不是RVC checkpoint，不能混装或承诺同栈支持。默认插件测试不生成付费音频或向QQ发送。

测试：`node --test test/*.test.js`；Python回归用既有uv音频环境。发行通过PC闭包、SHA和Build190原生事务，当前工作区交付说明在docs/handoff/HEART-VOICE-UPDATE-20261104.md；不沿用手工链接安装器。
