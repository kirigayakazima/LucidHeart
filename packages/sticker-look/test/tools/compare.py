import json, os, sys
from PIL import Image, ImageSequence

out = os.path.dirname(os.path.abspath(__file__))

for name in ("a_move", "c_alpha", "d_partial"):
    gif_path = os.path.join(out, "fixtures", f"{name}.gif")
    meta = json.load(open(os.path.join(out, "out", name, "meta.json"), encoding="utf-8"))
    im = Image.open(gif_path)
    w, h = im.size
    mine = [open(os.path.join(out, "out", name, f"frame-{i}.raw"), "rb").read()
            for i in range(meta["frames"])]
    pills = []
    for page in ImageSequence.Iterator(im):
        pills.append(page.convert("RGBA").tobytes())
    print(f"[{name}] size={w}x{h} mine={len(mine)} pillow={len(pills)} "
          f"delays={meta['delays']} pillow_delays={[im.info.get('duration')]}")
    if len(mine) != len(pills):
        print("  FRAME COUNT MISMATCH"); continue
    for i, (a, b) in enumerate(zip(mine, pills)):
        diff = [j for j in range(0, len(a), 4)
                if a[j:j+4] != b[j:j+4]]
        if diff:
            k = diff[0] * 1
            print(f"  frame {i}: {len(diff)} px differ; first at "
                  f"({(k//4)%w},{(k//4)//w}) mine={list(a[j:j+4]) if False else list(a[k:k+4])} "
                  f"pillow={list(b[k:k+4])}")
        else:
            print(f"  frame {i}: identical ({len(a)//4} px)")
