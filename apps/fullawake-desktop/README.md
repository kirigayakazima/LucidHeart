# FullAwake 桌面工作台

Windows 的 FullAwake 控制台。网关和手机插件均需 0.2.14。桌面窗口使用 Edge WebView2 与 x64 .NET Desktop Runtime 8 或更新版本，关闭窗口时收进托盘。托盘可重新打开界面、切换连麦与陪看，退出时释放该应用启动的网关及桌宠渲染器。

从 LucidHeart 根目录准备独立环境：

```powershell
uv sync --python 3.11 --project apps/fullawake-desktop
uv pip install --python apps/fullawake-pc/.venv/Scripts/python.exe --index-url https://pypi.tuna.tsinghua.edu.cn/simple dxcam==0.3.0
```

手机端把 FullAwake 的 `authToken`（或宿主的 `FULLAWAKE_AUTH_TOKEN`）设置为与 PC 一致的配对值。把 `duplexTarget` 设置为用户授权的私聊 DSH agent ID，PC 发起连麦及陪看时都绑定此会话。Phone 端继续执行 Heart 门控，深夜等状态下可能拒绝。使用 USB 调试连接一台已授权的手机。

在本机 `local/fullawake/desktop-config.json` 配置凭据和可选覆盖值，也可使用同名环境变量：

```json
{
  "FULLAWAKE_AUTH_TOKEN": "<手机和 PC 严格一致的私有配对值，至少 24 字符>",
  "FULLAWAKE_BREEZE_API_KEY": "<PC 的 BreezeBlue 凭据>",
  "adb_serial": "<多台设备时填写 USB 设备序列号>",
  "launch_renderer": true
}
```

`adb_path` 可覆盖 PATH 上的 adb.exe，`FULLAWAKE_ADB_SERIAL` 优先于配置文件中的序列号。已有桌宠渲染器时可设 `launch_renderer: false`。控制台另生成仅在当前进程间使用的桌面鉴权值。旧网关若占用 8765，App 会提示，关闭旧网关后点击日志区的「重启网关」。

双击 [launch_desktop.vbs](scripts/launch_desktop.vbs)。选屏/选窗同步影响普通 `pc_snapshot` 和桌面陪看。自动来源跟随前台窗所在屏。指定窗口被遮挡或不可见时，先把它移到前台。看不清或全黑时预览会显示后端和原因。受保护的画面仍可能全黑。

按右 Ctrl 录音并松开送入 ASR。语音面板支持运行时修改 PTT、切换自动检测和静音。最近对话保存在网关进程内存。关闭窗口后可继续使用托盘，选择「退出并关闭网关」结束守护。

现场验收时核对 USB/手机/网关灯，按「开启连麦」口述一句并确认桌宠发声，选择另一显示器比对预览和陪看画面，随后验证托盘常驻和退出释放 8765。手机安装与现场验收使用工作区交接记录。
