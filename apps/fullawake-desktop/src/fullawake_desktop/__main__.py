from pathlib import Path
from threading import Event
import os

import webview

from .api_bridge import ConsoleApi
from .supervisor import LOCAL, Supervisor
from .tray import make_tray


def main():
    import ctypes
    import pythonnet
    try:
        supervisor = Supervisor()
    except (OSError, ValueError):
        ctypes.windll.user32.MessageBoxW(None, '无法读取 desktop-config.json。请检查文件格式。', 'FullAwake', 0x10)
        return
    try:
        runtime = Path(__file__).with_name('fullawake.runtimeconfig.json')
        pythonnet.load('coreclr', runtime_config=str(runtime))
        import clr
        clr.AddReference('Microsoft.Win32.SystemEvents')
    except (RuntimeError, OSError):
        ctypes.windll.user32.MessageBoxW(None, '请安装 x64 .NET Desktop Runtime 8 或更新版本。', 'FullAwake', 0x10)
        return
    api = ConsoleApi(supervisor)
    exiting = Event()
    ui = Path(__file__).parent / 'ui/index.html'
    LOCAL.mkdir(parents=True, exist_ok=True)
    os.chdir(LOCAL)  # Keep renderer diagnostics and temporary browser data out of the source tree.
    window = webview.create_window('FullAwake · 桌面工作台', str(ui), js_api=api,
                                   width=1170, height=820, min_size=(820, 620), background_color='#111218')

    def quit_app():
        exiting.set()
        window.destroy()

    def closing():
        if exiting.is_set():
            return True
        window.hide()
        return False

    window.events.closing += closing
    tray = make_tray(window, api, quit_app)
    tray.run_detached()
    supervisor.start()
    api._start()
    try:
        webview.start(gui='edgechromium', private_mode=True)
    except (RuntimeError, webview.WebViewException):
        ctypes.windll.user32.MessageBoxW(None, '无法启动 WebView2 窗口。请检查 Edge WebView2 Runtime。', 'FullAwake', 0x10)
    finally:
        tray.stop()
        supervisor.close()
        api._close()


if __name__ == '__main__':
    main()
