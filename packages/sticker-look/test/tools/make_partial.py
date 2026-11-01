# 生成 D：尽量触发 Pillow 的局部帧（带 left/top 偏移）编码，验证合成逻辑
import os
from PIL import Image, ImageDraw

out = os.path.dirname(os.path.abspath(__file__))
im = Image.new("P", (160, 100), 0)
im.putpalette([i for i in range(256) for _ in range(3)][:768])
frames = []
for i in range(6):
    f = im.copy()
    d = ImageDraw.Draw(f)
    d.rectangle([4 + i * 10, 4, 18 + i * 10, 14], fill=10)      # 上方移动
    d.rectangle([120, 60 + i * 2, 150, 80 + i * 2], fill=20)     # 下方移动
    frames.append(f)
frames[0].save(os.path.join(out, "fixtures", "d_partial.gif"), save_all=True,
               append_images=frames[1:], duration=60, loop=0, optimize=True, disposal=1)
print("d written")
