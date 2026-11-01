"""Regression for long voiced NSF phase accumulation in ONNX CPU.

Run in the PC export environment with onnx/onnxruntime/numpy installed.
"""
import sys
from pathlib import Path
import unittest
import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from onnx_phase import stabilize_nsf_phase


def graph():
    # Sample-rate increments include negative wrap corrections, as in NSF.
    nodes = [helper.make_node('CumSum', ['steps', 'axis'], ['phase'], name='/dec/m_source/l_sin_gen/CumSum'),
             helper.make_node('CumSum', ['steps', 'axis'], ['other'], name='/dec/m_source/l_sin_gen/CumSum_1')]
    model = helper.make_model(helper.make_graph(nodes, 'phase-regression',
        [helper.make_tensor_value_info('steps', TensorProto.FLOAT, ['samples'])],
        [helper.make_tensor_value_info('phase', TensorProto.FLOAT, ['samples']),
         helper.make_tensor_value_info('other', TensorProto.FLOAT, ['samples'])],
        [numpy_helper.from_array(np.array(0, dtype=np.int64), name='axis')]),
        opset_imports=[helper.make_opsetid('', 17)])
    model.ir_version = 9
    return model


class PhaseTests(unittest.TestCase):
    def test_long_phase_matches_high_precision_reference(self):
        steps = np.full(264000, 220 / 40000, dtype=np.float32)
        steps[181::182] -= 1
        expected = np.cumsum(steps, dtype=np.float64).astype(np.float32)
        source = graph()
        patched = stabilize_nsf_phase(source)
        self.assertEqual(len(source.graph.node), 2)  # Original asset is untouched.
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        session = ort.InferenceSession(patched.SerializeToString(), opts, providers=['CPUExecutionProvider'])
        actual = session.run(None, {'steps': steps})
        for phase in actual:
            np.testing.assert_array_equal(phase, expected)

    def test_unknown_graph_and_double_patch_are_rejected(self):
        source = graph()
        source.graph.node[0].name = 'unrelated/cumsum'
        with self.assertRaisesRegex(ValueError, 'exactly two'):
            stabilize_nsf_phase(source)
        with self.assertRaisesRegex(ValueError, 'already applied'):
            stabilize_nsf_phase(stabilize_nsf_phase(graph()))


if __name__ == '__main__':
    unittest.main()
