"""Local, persistent Silero ONNX worker. stdin carries f32le 16 kHz mono frames."""
import hashlib
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort


def main(model, expected):
    payload = Path(model).read_bytes()
    if hashlib.sha256(payload).hexdigest() != expected.lower():
        raise ValueError("Silero model SHA-256 does not match")
    options = ort.SessionOptions()
    options.inter_op_num_threads = options.intra_op_num_threads = 1
    session = ort.InferenceSession(payload, sess_options=options, providers=["CPUExecutionProvider"])
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros(64, dtype=np.float32)
    rate = np.array(16000, dtype=np.int64)
    source = sys.stdin.buffer
    print("ready", flush=True)
    while operation := source.read(1):
        if operation == b"R":
            state.fill(0)
            context.fill(0)
            print("reset", flush=True)
            continue
        if operation != b"F":
            raise ValueError("Invalid Silero worker frame type")
        frame = source.read(512 * 4)
        if len(frame) != 512 * 4:
            raise ValueError("Truncated Silero worker frame")
        samples = np.frombuffer(frame, dtype="<f4")
        if not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1.01:
            raise ValueError("Invalid microphone PCM")
        buffer = np.concatenate((context, samples)).reshape(1, 576)
        probability, state = session.run(["output", "stateN"], {
            "input": buffer, "state": state, "sr": rate,
        })
        context[:] = samples[-64:]
        print(float(probability.item()), flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:])
