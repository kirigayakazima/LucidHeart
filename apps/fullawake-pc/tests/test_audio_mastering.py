from array import array
import json
import re
import subprocess
import wave

import pytest

from fullawake.capabilities.audio_mastering import master_audio


def run(tool, *args):
    return subprocess.run([tool, *map(str, args)], capture_output=True, check=True)


def stem(path, expression, rate=44_100, duration=5):
    run("ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        f"aevalsrc=exprs='{expression}':s={rate}:d={duration}", "-c:a", "pcm_f32le", path)
    return path


def samples(path):
    decoded = run("ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-c:a", "pcm_f32le", "-").stdout
    return array("f", decoded)


def meter(path):
    log = run("ffmpeg", "-hide_banner", "-nostats", "-i", path,
              "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-").stderr.decode()
    summary = log.rsplit("Summary:", 1)[1]
    return (float(re.search(r"\bI:\s+(-?\d+\.\d+) LUFS", summary)[1]),
            float(re.search(r"Peak:\s+(-?\d+\.\d+) dBFS", summary)[1]))


def test_overloaded_dynamic_mix_meets_loudness_and_decoded_true_peak(tmp_path):
    vocal = stem(tmp_path / "vocal.wav",
                 "(0.14+0.08*sin(2*PI*0.45*t))*sin(2*PI*733*t)"
                 "+if(lt(mod(t,0.7),0.007),1.95*sin(2*PI*6183*t),0)")
    inst = stem(tmp_path / "inst.wav",
                "0.12*sin(2*PI*131*t)+if(lt(mod(t,0.7),0.007),0.8*sin(2*PI*6183*t),0)")
    assert max(map(abs, samples(vocal))) > 1.0  # Preserve the input overload in floating-point PCM.

    output = tmp_path / "song.mp3"
    levels = master_audio(vocal, inst, output)
    loudness, true_peak = meter(output)
    assert loudness == pytest.approx(-14.0, abs=1.0)
    assert true_peak <= -0.8
    assert levels.integrated_lufs == pytest.approx(loudness, abs=0.25)
    assert levels.true_peak_dbtp <= -0.8
    decoded = samples(output)[::2]
    assert 0.75 < max(map(abs, decoded)) < 1.0
    assert not any(abs(a) > 0.75 and max(abs(a - b), abs(a - c), abs(a - d)) < 1e-6
                   for a, b, c, d in zip(decoded, decoded[1:], decoded[2:], decoded[3:]))


@pytest.mark.parametrize("amplitude", [0, 1e-10])
def test_silence_and_sub_gate_inputs_are_not_amplified(tmp_path, amplitude):
    vocal = stem(tmp_path / "vocal.wav", f"{amplitude}*sin(2*PI*440*t)", rate=24_000, duration=1)
    inst = stem(tmp_path / "inst.wav", "0", rate=48_000, duration=1)
    output = tmp_path / "song.mp3"
    levels = master_audio(vocal, inst, output)
    assert levels.integrated_lufs is None
    decoded_peak = max(map(abs, samples(output)))
    assert decoded_peak <= 3 * amplitude


def test_quiet_but_measurable_audio_is_normalized(tmp_path):
    vocal = stem(tmp_path / "vocal.wav", "0.001*sin(2*PI*440*t)", duration=1)
    inst = stem(tmp_path / "inst.wav", "0", duration=1)
    output = tmp_path / "song.mp3"
    master_audio(vocal, inst, output)
    loudness, true_peak = meter(output)
    assert loudness == pytest.approx(-14.0, abs=1.0)
    assert true_peak <= -0.8


def test_resamples_different_stems_and_writes_decodable_id3_mp3_and_pcm(tmp_path):
    vocal = stem(tmp_path / "vocal.wav", "0.13*sin(2*PI*443*t)", rate=24_000, duration=2)
    inst = stem(tmp_path / "inst.wav", "0.12*sin(2*PI*131*t)|0.05*sin(2*PI*197*t)", rate=48_000, duration=3)
    output = tmp_path / "song.mp3"
    pcm = tmp_path / "song.wav"
    levels = master_audio(vocal, inst, output, vocal_gain=0.7, inst_gain=1.2, output_wav_path=pcm)

    header = output.read_bytes()[:10]
    assert header[:5] == b"ID3\x03\x00"
    assert all(byte < 128 for byte in header[6:10])  # ID3v2 synchsafe size.
    probe = run("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_streams", "-of", "json", output)
    stream = json.loads(probe.stdout)["streams"][0]
    assert (stream["codec_name"], stream["sample_rate"], stream["channels"], stream["bit_rate"]) == (
        "mp3", "44100", 2, "192000",
    )
    decoded = samples(output)
    assert len(decoded) == 3 * 44_100 * 2
    assert any(decoded[2 * 44_100 * 2:])
    assert max(abs(left - right) for left, right in zip(decoded[::2], decoded[1::2])) > 0.1
    assert levels.integrated_lufs == pytest.approx(-14.0, abs=1.0)
    with wave.open(str(pcm), "rb") as audio:
        assert (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getnframes()) == (
            24_000, 1, 2, 3 * 24_000,
        )
