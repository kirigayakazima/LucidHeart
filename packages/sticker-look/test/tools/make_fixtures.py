# 生成两个测试 GIF：A=8 帧全画布无透明，C=4 帧全画布带透明索引
import json, os
from PIL import Image, ImageDraw

out = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(out, "fixtures"), exist_ok=True)

# A：8 帧，红色方块移动 + 帧号
frames = []
for i in range(8):
    im = Image.new("RGB", (120, 80), (24, 24, 32))
    d = ImageDraw.Draw(im)
    d.rectangle([10 + i * 12, 20, 30 + i * 12, 45], fill=(220, 40, 60))
    d.text((6, 60), f"frame {i}", fill=(230, 230, 230))
    frames.append(im)
durations = [80, 120, 80, 160, 80, 100, 200, 80]
frames[0].save(os.path.join(out, "fixtures", "a_move.gif"), save_all=True,
               append_images=frames[1:], duration=durations, loop=0, disposal=1)
with open(os.path.join(out, "fixtures", "a_move.meta.json"), "w") as f:
    json.dump({"frames": 8, "durations": durations, "size": [120, 80], "loop": 0}, f)

# C：4 帧，画布上叠一个带透明底的圆，圆位置变化
cframes = []
for i in range(4):
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([8 + i * 6, 12, 30 + i * 6, 34], fill=(80, 200, 255, 255))
    cframes.append(im)
cframes[0].save(os.path.join(out, "fixtures", "c_alpha.gif"), save_all=True,
                append_images=cframes[1:], duration=100, loop=0, transparency=0, disposal=2)
print("fixtures written")
