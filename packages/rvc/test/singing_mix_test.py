"""Round-trip the shared singing mix through actual WAV and MP3 codecs."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

MIXER = Path(__file__).resolve().parents[1] / "vendor" / "phone" / "mix.py"


class SingingMixTest(unittest.TestCase):
    def test_overlapping_stems_resample_and_remain_under_peak_ceiling(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            vocal = folder / "vocal.wav"
            music = folder / "music.wav"
            output = folder / "mix.mp3"
            for path, rate, hz in ((vocal, 40000, 997), (music, 44100, 110)):
                signal = np.sin(np.arange(rate) * (2 * np.pi * hz / rate)) * 0.98
                sf.write(path, signal, rate, subtype="FLOAT")
            subprocess.run([sys.executable, str(MIXER), str(vocal), str(music), str(output),
                            "--vocal-gain", "1.2", "--inst-gain", "1.2"], check=True)
            for path in (output, output.with_suffix(".wav")):
                audio, rate = sf.read(path, always_2d=True)
                self.assertEqual(rate, 44100)
                self.assertEqual(audio.shape, (rate, 2))
                peak = float(np.max(np.abs(audio)))
                self.assertGreater(peak, 0.5)
                self.assertLessEqual(peak, 10 ** (-0.5 / 20))
                spectrum = np.abs(np.fft.rfft(audio[:, 0]))
                self.assertGreater(spectrum[997], 3000)
                self.assertGreater(spectrum[110], 3000)


if __name__ == "__main__":
    unittest.main()
