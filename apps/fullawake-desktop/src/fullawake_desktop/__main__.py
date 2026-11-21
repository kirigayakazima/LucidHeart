from pathlib import Path
from threading import Event
import os

import webview

from .api_bridge import ConsoleApi
from .supervisor import LOCAL, Supervisor
from .tray import make_tray


ICON_PATH = Path(__file__).parent / 'assets/dafeiyu.ico'
_ICON_HANDLES = []


def _apply_window_icon(title, icon_path):
    if os.name != 'nt' or not icon_path.is_file():
        return
    try:
        import ctypes
        from ctypes import wintypes
        # Use a private WinDLL handle and async PostMessageW so we never mutate global windll
        # or deadlock the WinForms/WebView2 UI thread.
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user32.FindWindowW.restype = wintypes.HWND
        user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                                      ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user32.LoadImageW.restype = wintypes.HANDLE
        user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.PostMessageW.restype = wintypes.BOOL
        hwnd = user32.FindWindowW(None, title)
        if not hwnd:
            return
        # IMAGE_ICON=1, LR_LOADFROMFILE=0x0010, WM_SETICON=0x0080
        small = user32.LoadImageW(None, str(icon_path), 1, 16, 16, 0x0010)
        big = user32.LoadImageW(None, str(icon_path), 1, 48, 48, 0x0010)
        if small:
            _ICON_HANDLES.append(small)
            user32.PostMessageW(hwnd, 0x0080, 0, small)
        if big:
            _ICON_HANDLES.append(big)
            user32.PostMessageW(hwnd, 0x0080, 1, big)
    except Exception:
        pass


def main():
    import ctypes
    import pythonnet
    if os.name == 'nt':
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('LucidHeart.FullAwake.Desktop')
        except Exception:
            pass
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
                                   width=1170, height=820, min_size=(820, 620), background_color='#111218',
                                   minimized=False, focus=True)
    api._select_home_export = lambda: window.create_file_dialog(
        webview.SAVE_DIALOG, save_filename='xiaoman-home.png', file_types=('PNG (*.png)',))

    def bring_to_front():
        from threading import Timer
        def _finish():
            _apply_window_icon('FullAwake · 桌面工作台', ICON_PATH)
            try:
                window.restore()
                window.on_top = True
                window.on_top = False
            except Exception:
                pass
        t = Timer(0.35, _finish)
        t.daemon = True
        t.start()

    window.events.shown += bring_to_front

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
