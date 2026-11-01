import sys, time, wave
import sherpa_onnx

D = "/root/.dsh/voice/models/vits-melo-tts-zh_en"
text = sys.argv[1] if len(sys.argv) > 1 else "你好，我是住在这台手机里的大肥鱼。"
out = sys.argv[2] if len(sys.argv) > 2 else "/root/.dsh/voice/local.wav"

t0 = time.time()
cfg = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=f"{D}/model.onnx",
            lexicon=f"{D}/lexicon.txt",
            tokens=f"{D}/tokens.txt",
            dict_dir=f"{D}/dict",
        ),
        num_threads=4,
        provider="cpu",
    ),
    rule_fsts=f"{D}/date.fst,{D}/number.fst,{D}/phone.fst",
    max_num_sentences=1,
)
tts = sherpa_onnx.OfflineTts(cfg)
t1 = time.time()

audio = tts.generate(text, sid=0, speed=1.0)
t2 = time.time()

import array

pcm = array.array("h", (int(max(-1.0, min(1.0, s)) * 32767) for s in audio.samples))
with wave.open(out, "wb") as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(audio.sample_rate)
    f.writeframes(pcm.tobytes())

dur = len(audio.samples) / audio.sample_rate
print(f"加载 {t1-t0:.1f}s  合成 {t2-t1:.1f}s  音频 {dur:.1f}s  RTF {(t2-t1)/dur:.2f}")
print(out)
