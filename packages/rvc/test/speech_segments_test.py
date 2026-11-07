"""Pause-aware long speech tests using the shared mobile runtime, no network."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

SOURCE = Path(__file__).resolve().parents[1] / 'vendor/phone/rvc_onnx.py'
spec = importlib.util.spec_from_file_location('speech_runtime', SOURCE)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class SpeechSegmentsTests(unittest.TestCase):
    def assert_partition(self, audio, spans):
        self.assertEqual(spans[0]['start_16k'], 0)
        self.assertEqual(spans[-1]['end_16k'], len(audio))
        for i, seg in enumerate(spans):
            self.assertGreater(seg['end_16k'], seg['start_16k'])
            self.assertLessEqual(seg['end_16k'] - seg['start_16k'], 8 * 16000)
            # Includes extra last-context padding used by the converter.
            self.assertLess(seg['ctx_end_16k'] - seg['ctx_start_16k'] + 640, 1000 * 160)
            if i:
                self.assertEqual(seg['start_16k'], spans[i - 1]['end_16k'])
                self.assertEqual(seg['start_16k'] % 160, 0)
        np.testing.assert_array_equal(np.concatenate([audio[s['start_16k']:s['end_16k']] for s in spans]), audio)

    def test_short_path_is_unchanged(self):
        audio = np.ones(660 * 160, dtype=np.float32) * .1
        spans = runtime.plan_speech_segments(audio)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]['ctx_end_16k'], len(audio))

    def test_prefers_middle_of_real_pause(self):
        audio = np.ones(20 * 16000 + 73, dtype=np.float32) * .1
        for second in (5, 11, 17):
            audio[second * 16000:(second * 16000 + 4000)] = 0
        spans = runtime.plan_speech_segments(audio)
        self.assert_partition(audio, spans)
        self.assertEqual([s['boundary'] for s in spans], ['pause', 'pause', 'pause', 'end'])
        for seg in spans[:-1]:
            self.assertEqual(audio[seg['end_16k']], 0)

    def test_no_pause_uses_low_energy_fallback(self):
        audio = np.full(25 * 16000 + 1, .1, dtype=np.float32)
        spans = runtime.plan_speech_segments(audio)
        self.assert_partition(audio, spans)
        self.assertTrue(all(s['boundary'] == 'low_energy' for s in spans[:-1]))

    def test_silence_and_boundary_lengths_terminate(self):
        for n in (1, 160, 128000, 128001, 160000, 320013, 2 * 60 * 16000):
            with self.subTest(n=n):
                audio = np.zeros(n, dtype=np.float32)
                self.assert_partition(audio, runtime.plan_speech_segments(audio))

    def test_invalid_audio_fails_before_model_loading(self):
        for audio in (np.array([]), np.array([np.nan]), np.ones((2, 2))):
            with self.assertRaises(ValueError):
                runtime.plan_speech_segments(audio)

    def test_hann_overlap_preserves_timeline_and_fractional_tail(self):
        total = 200003
        first = {'start_16k': 0, 'end_16k': 128000, 'ctx_start_16k': 0}
        second = {'start_16k': 128000, 'end_16k': total, 'ctx_start_16k': 120000}
        left = runtime.crop_speech_segment(np.ones(325000, dtype=np.float32), first, total)
        right = runtime.crop_speech_segment(np.full(210000, 3, dtype=np.float32), second, total)
        result = runtime.join_speech_segments([first, second], [left, right], total)
        self.assertEqual(len(result), round(total * 2.5))
        np.testing.assert_array_equal(result[:318001], 1)
        np.testing.assert_array_equal(result[321999:], 3)
        self.assertAlmostEqual(result[319000], 1.293, places=3)
        self.assertAlmostEqual(result[320000], 2, places=3)
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            runtime.crop_speech_segment(np.zeros(20), second, total)

    def test_real_conversion_loop_reuses_sessions_and_keeps_all_samples(self):
        audio = np.full(21 * 16000 + 73, .1, dtype=np.float32)
        audio[5 * 16000:6 * 16000] = 0
        audio[12 * 16000:13 * 16000] = 0
        sessions, frames_seen, written = [], [], {}

        class Session:
            def __init__(self, path, *args, **kw): sessions.append(path)
            def get_providers(self): return ['CPUExecutionProvider']

        def features(session, clip):
            # Mimic the real receptive-field loss (padding must protect the tail).
            return np.zeros((len(clip) // 160 - 2, 768), dtype=np.float32)

        def synth(session, phone, pitch, pitchf, **kw):
            frames_seen.append(len(pitch))
            self.assertLessEqual(len(pitch), 1000)
            self.assertEqual(kw['mode'], 'continuous')
            return np.ones(len(pitch) * 400, dtype=np.float32) * .1

        def save(filename, data, sr): written[str(filename)] = np.array(data)

        class Reader:
            @staticmethod
            def read(filename): return written[str(filename)], 40000

        with tempfile.TemporaryDirectory(prefix='speech-segments-') as tmp:
            root = Path(tmp)
            for name in ('hubert.onnx', 'rmvpe.onnx', 'model.onnx'):
                (root / name).touch()
            with patch.object(runtime, 'load_audio', return_value=audio), \
                 patch.object(runtime.ort, 'InferenceSession', Session), \
                 patch.object(runtime, 'extract_hubert_features', features), \
                 patch.object(runtime, 'extract_rmvpe_pitch', side_effect=lambda s, a, n, *x: (np.ones(n), np.ones(n))), \
                 patch.object(runtime, 'synthesize_segment', synth), \
                 patch.object(runtime, 'save_wav', save), patch.object(runtime, 'sf', Reader):
                result = runtime.convert_audio('not-read.wav', tmp, str(root / 'out.wav'), synthesis_mode='continuous')
        self.assertEqual(len(sessions), 3)  # Not 3 sessions per piece.
        self.assertGreater(len(frames_seen), 2)
        self.assertEqual(len(written[str(root / 'out.wav')]), round(len(audio) * 2.5))
        self.assertTrue(result['segmentation']['split'])

    def test_legacy_continuous_frame_guard_still_rejects_unbounded_forward(self):
        with self.assertRaisesRegex(ValueError, 'split the utterance'):
            runtime.synthesize_segment(None, None, np.ones(1001), None, mode='continuous')


if __name__ == '__main__':
    unittest.main()
