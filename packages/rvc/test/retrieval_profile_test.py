"""CPU retrieval regression; run with the existing ONNX Python environment."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

path = Path(__file__).resolve().parents[1] / 'vendor/phone/rvc_onnx.py'
spec = importlib.util.spec_from_file_location('phone_runtime', path)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RetrievalTests(unittest.TestCase):
    def test_intonation_preserves_unvoiced_and_default_exactly(self):
        source = np.array([0, 110, 220, 440, 0], dtype=np.float32)
        np.testing.assert_array_equal(runtime.shape_intonation(source), source)
        result = runtime.shape_intonation(source, 1.5)
        np.testing.assert_array_equal(result[source == 0], 0)
        self.assertEqual(result[2], source[2])
        self.assertLess(result[1], source[1])
        self.assertGreater(result[3], source[3])
        shift = 12 * np.log2(result[source > 0] / source[source > 0])
        self.assertLessEqual(float(np.max(np.abs(shift))), 2.00001)
        np.testing.assert_array_equal(source, [0, 110, 220, 440, 0])

    def test_intonation_rejects_invalid_and_handles_silence(self):
        for scale in [float('nan'), 0, 2]:
            with self.assertRaises(ValueError): runtime.shape_intonation(np.zeros(4), scale)
        with self.assertRaises(ValueError): runtime.shape_intonation(np.array([float('nan')]), 1)
        np.testing.assert_array_equal(runtime.shape_intonation(np.zeros(4), 1.5), np.zeros(4))

    def test_continuous_mode_is_one_call_without_crossfading(self):
        class Session:
            def __init__(self): self.calls = []
            def run(self, names, inputs):
                self.calls.append(inputs)
                return [np.ones((1, 1, len(inputs['pitch'][0]) * 400), dtype=np.float32)]
        session = Session()
        n = 660
        phone = np.zeros((n, 768), dtype=np.float32)
        pitch = np.ones(n, dtype=np.int64)
        output = runtime.synthesize_segment(session, phone, pitch, pitch.astype(np.float32),
                                            mode='continuous', noise_scale=.66666)
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(session.calls[0]['phone'].shape[1], n)
        np.testing.assert_array_equal(output, np.ones(n * 400))
        with self.assertRaisesRegex(ValueError, 'split the utterance'):
            runtime.synthesize_segment(session, phone, pitch, pitch.astype(np.float32), mode='continuous', max_frames=600)

    def test_l2_eight_matches_reference_and_batch_boundaries(self):
        rng = np.random.default_rng(42)
        table = rng.normal(size=(23, 768)).astype(np.float32)
        query = rng.normal(size=(7, 768)).astype(np.float32)
        distance = np.sum((query[:, None] - table[None, :]) ** 2, axis=2)
        ids = np.argsort(distance, axis=1)[:, :8]
        weight = 1 / np.maximum(np.take_along_axis(distance, ids, axis=1), 1e-6) ** 2
        weight /= weight.sum(axis=1, keepdims=True)
        expected = (table[ids] * weight[..., None]).sum(axis=1) * .3 + query * .7
        actual = runtime.apply_index(query, table, .3, batch_size=2, method='l2-8')
        np.testing.assert_allclose(actual, expected, atol=1e-5, rtol=1e-5)

    def test_default_retrieval_is_unchanged(self):
        query = np.array([[1., 0.], [0., 2.]], dtype=np.float32)
        table = np.array([[1., 0.], [0., 1.]], dtype=np.float32)
        expected = np.array([[1., 0.], [0., 1.7]], dtype=np.float32)
        np.testing.assert_allclose(runtime.apply_index(query, table, .3), expected)

    def test_exact_match_has_finite_weights(self):
        table = np.ones((2, 768), dtype=np.float32)
        result = runtime.apply_index(table[:1], table, .3, method='l2-8')
        self.assertTrue(np.isfinite(result).all())
        np.testing.assert_allclose(result, table[:1])


if __name__ == '__main__':
    unittest.main()
