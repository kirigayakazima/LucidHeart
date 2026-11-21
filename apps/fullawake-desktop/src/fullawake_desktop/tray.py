from pathlib import Path
from PIL import Image, ImageDraw
import pystray

ICON_PATH = Path(__file__).parent / 'assets/dafeiyu.ico'


def _load_tray_image():
    if ICON_PATH.is_file():
        try:
            return Image.open(ICON_PATH).convert('RGBA').resize((64, 64), Image.Resampling.LANCZOS)
        except Exception:
            pass
    image = Image.new('RGBA', (64, 64))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3, 3, 61, 61), radius=15, fill='#262638')
    draw.polygon([(36, 8), (17, 35), (32, 35), (27, 55), (48, 26), (34, 26)], fill='#b5a4ff')
    return image


def make_tray(window, api, quit_app):
    image = _load_tray_image()

    def toggle(key, operation):
        def run():
            state = api.state()
            result = operation(not state.get(key))
            if result.get('error') or not result.get('accepted'):
                icon.notify(result.get('error') or '请检查手机连接、绑定会话及 Heart 状态。', 'FullAwake')
        return run

    def toggle_pet():
        result = api.toggle_pet()
        if result.get('error'):
            icon.notify(result['error'], 'FullAwake')

    def show():
        window.show()
        window.restore()

    icon = pystray.Icon('FullAwake', image, 'FullAwake · 小满工作台', pystray.Menu(
        pystray.MenuItem('显示主界面', show, default=True),
        pystray.MenuItem('启动或关闭桌宠', toggle_pet),
        pystray.MenuItem('开启或挂断连麦', toggle('call_active', api.call)),
        pystray.MenuItem('开启或停止陪看', toggle('watch_active', api.watch)),
        pystray.MenuItem('退出并关闭网关', quit_app),
    ))
    return icon
