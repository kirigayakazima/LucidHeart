import wave

import numpy as np

from fullawake.capabilities.sing_mastering import master_audio


def test_song_mastering_handles_overload_with_verified_delivery_formats(tmp_path):
    vocal = tmp_path / 'vocals.wav'
    accompaniment = tmp_path / 'accompaniment.wav'
    mp3 = tmp_path / 'song.mp3'
    wav = tmp_path / 'song.wav'
    rate = 44100
    clock = np.arange(12 * rate) / rate
    samples = .94 * np.sin(2 * np.pi * 263 * clock) * np.where(clock < 6, .15, 1)
    for path in (vocal, accompaniment):
        with wave.open(str(path), 'wb') as output:
            output.setparams((1, 2, rate, 0, 'NONE', ''))
            output.writeframes((samples * 32767).astype('<i2').tobytes())
    result = master_audio(vocal, accompaniment, mp3, output_wav_path=wav)
    assert abs(result.integrated_lufs + 14) <= 1
    assert result.true_peak_dbtp <= -.8
    assert result.loudness_range_lu <= 8
    assert mp3.read_bytes().startswith(b'ID3')
    with wave.open(str(wav), 'rb') as audio:
        assert (audio.getframerate(), audio.getsampwidth(), audio.getnchannels()) == (rate, 2, 2)
        pcm = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
    assert max(abs(pcm.min().item()), pcm.max().item()) < 32767
