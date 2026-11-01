"""Export a v2/40k RVC checkpoint and its ContentVec encoder for the phone runtime.

Runs on the PC only. Dependencies: the existing rvc-python export environment,
transformers, faiss, onnx and onnxruntime. No model downloads or deployment.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

import torch
import faiss
import numpy as np
import onnx
import onnxruntime as ort
from rvc_python.lib.infer_pack.models_onnx import SynthesizerTrnMsNSFsidM
from transformers import HubertConfig, HubertModel
from onnx_phase import stabilize_nsf_phase


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else _sha(stream)


def _sha(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()


class Encoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, source, padding_mask):
        return self.model(source, attention_mask=(~padding_mask).long()).last_hidden_state


def load_contentvec(directory):
    model = HubertModel(HubertConfig.from_json_file(str(directory / 'config.json')))
    state = torch.load(directory / 'pytorch_model.bin', map_location='cpu', weights_only=True)
    expected = model.state_dict()
    mapped = {}
    for key, value in state.items():
        target = key
        # PyTorch weight_norm serialization changed; never accept randomly initialized encoder weights.
        for old, new in [('.weight_g', '.parametrizations.weight.original0'),
                         ('.weight_v', '.parametrizations.weight.original1')]:
            if target.endswith(old) and target[:-len(old)] + new in expected:
                target = target[:-len(old)] + new
        if target not in expected and target.startswith('final_proj.'):
            continue  # v1 projection is not used by the v2/768-dimensional path.
        mapped[target] = value
    model.load_state_dict(mapped, strict=True)
    return model


def validate_voiced_phase(generator, session, names):
    """Check long voiced input separately from a random-input export smoke check."""
    checks = []
    for frames in [200, 660]:
        torch.manual_seed(43)
        voiced_f0 = 220 + 40 * torch.sin(torch.arange(frames) * .037)
        voiced_f0[frames // 3:frames // 3 + 20] = 0
        inputs = (torch.randn(1, frames, 768), torch.tensor([frames]),
                  torch.full((1, frames), 180, dtype=torch.long), voiced_f0[None],
                  torch.tensor([0]), torch.randn(1, 192, frames) * .66666)
        with torch.no_grad():
            reference = generator(*inputs).numpy().ravel()
            repeat = generator(*inputs).numpy().ravel()
        actual = session.run(None, {k: v.numpy() for k, v in zip(names, inputs)})[0].ravel()
        for start in range(0, len(reference), 40000):
            a, b, c = reference[start:start + 40000], actual[start:start + 40000], repeat[start:start + 40000]
            corr = float(np.corrcoef(a, b)[0, 1])
            mae = float(np.mean(abs(a - b)))
            repeat_mae = float(np.mean(abs(a - c)))
            if not np.isfinite(b).all() or not np.isfinite(corr) or corr < .98 or mae > max(1e-4, repeat_mae * 3):
                raise ValueError(f'Voiced phase comparison failed: frames={frames}, sample={start}, {corr}, {mae}, {repeat_mae}')
            checks.append({'frames': frames, 'startSample': start, 'correlation': corr,
                           'meanError': mae, 'repeatMeanError': repeat_mae})
    return checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', required=True, type=Path)
    parser.add_argument('--index', required=True, type=Path)
    parser.add_argument('--contentvec', required=True, type=Path)
    parser.add_argument('--rmvpe', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    out = args.output_dir.resolve()
    if out.exists() and any(out.iterdir()):
        raise ValueError('Output directory must be new or empty; existing model assets are never overwritten')
    out.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    torch.manual_seed(42)
    checkpoint = torch.load(args.checkpoint, map_location='cpu', weights_only=True)
    if checkpoint.get('version') != 'v2' or not checkpoint.get('f0') or checkpoint['config'][-1] != 40000:
        raise ValueError('This phone exporter supports v2 / F0 / 40k only')
    generator = SynthesizerTrnMsNSFsidM(*checkpoint['config'], version='v2', is_half=False)
    loaded = generator.load_state_dict(checkpoint['weight'], strict=False)
    if loaded.unexpected_keys or any(not k.startswith('enc_q.') for k in loaded.missing_keys):
        raise ValueError(f'Inference weights mismatch: {loaded}')
    generator.eval()
    generator.dec.remove_weight_norm()
    generator.flow.remove_weight_norm()
    inputs = (torch.randn(1, 200, 768), torch.tensor([200]), torch.randint(1, 255, (1, 200)),
              torch.rand(1, 200) * 250 + 100, torch.tensor([0]), torch.randn(1, 192, 200))
    names = ['phone', 'phone_lengths', 'pitch', 'pitchf', 'ds', 'rnd']
    torch.onnx.export(generator, inputs, str(out / 'model.onnx'), input_names=names, output_names=['audio'],
                      dynamic_axes={'phone': {1: 'time'}, 'pitch': {1: 'time'}, 'pitchf': {1: 'time'},
                                    'rnd': {2: 'time'}, 'audio': {2: 'samples'}},
                      opset_version=17, dynamo=False)
    # Only the two phase sums use float64, not the neural network or model weights.
    onnx.save(stabilize_nsf_phase(onnx.load(str(out / 'model.onnx'))), str(out / 'model.onnx'))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    onnx.checker.check_model(str(out / 'model.onnx'))
    session = ort.InferenceSession(str(out / 'model.onnx'), options, providers=['CPUExecutionProvider'])
    with torch.no_grad():
        reference = generator(*inputs).numpy()
        repeat = generator(*inputs).numpy()
    actual = session.run(None, {k: v.numpy() for k, v in zip(names, inputs)})[0]
    error = float(np.max(np.abs(reference - actual)))
    mean_error = float(np.mean(np.abs(reference - actual)))
    repeat_error = float(np.mean(np.abs(reference - repeat)))
    correlation = float(np.corrcoef(reference.ravel(), actual.ravel())[0, 1])
    # NSF injects its own RandomNormalLike noise, independently of the explicit rnd
    # latent input. Compare against PyTorch's own repeat variation, not fake exact parity.
    if (not np.isfinite(actual).all() or not np.isfinite(correlation) or correlation < .98
            or mean_error > max(1e-4, repeat_error * 3)):
        raise ValueError(f'Generator stochastic comparison failed: {mean_error}, {repeat_error}, {correlation}')
    print(f'Generator stochastic comparison: mean {mean_error}, repeat {repeat_error}, correlation {correlation}', flush=True)
    # Sustained / changing voiced F0 exposes phase drift hidden by random F0.
    speech_checks = validate_voiced_phase(generator, session, names)
    print(f'Voiced phase comparisons: {speech_checks}', flush=True)
    del session, generator

    encoder = Encoder(load_contentvec(args.contentvec)).eval()
    source = torch.randn(1, 32000)
    mask = torch.zeros_like(source, dtype=torch.bool)
    torch.onnx.export(encoder, (source, mask), str(out / 'hubert.onnx'),
                      input_names=['source', 'padding_mask'], output_names=['features'],
                      dynamic_axes={'source': {1: 'samples'}, 'padding_mask': {1: 'samples'},
                                    'features': {1: 'frames'}}, opset_version=17, dynamo=False)
    session = ort.InferenceSession(str(out / 'hubert.onnx'), options, providers=['CPUExecutionProvider'])
    encoder_errors = []
    for length in [32000, 48000]:
        source = torch.randn(1, length)
        mask = torch.zeros_like(source, dtype=torch.bool)
        with torch.no_grad():
            ref = encoder(source, mask).numpy()
        result = session.run(None, {'source': source.numpy(), 'padding_mask': mask.numpy()})[0]
        np.testing.assert_allclose(ref, result, atol=1e-3, rtol=1e-3)
        encoder_errors.append(float(np.max(np.abs(ref - result))))
    print(f'ContentVec CPU parity: {encoder_errors}', flush=True)

    index = faiss.read_index(str(args.index))
    vectors = index.reconstruct_n(0, index.ntotal).astype('<f4')
    if vectors.ndim != 2 or vectors.shape[1] != 768 or not len(vectors):
        raise ValueError('Expected nonempty 768-dimensional index')
    with (out / 'voice.mobile.index').open('wb') as stream:
        stream.write(b'URVCIDX1' + struct.pack('<I', len(vectors)))
        stream.write(vectors.tobytes())
    # Copy, never source-to-mirror hardlink.
    import shutil
    shutil.copyfile(args.rmvpe, out / 'rmvpe.onnx')
    assets = {name: {'sha256': sha(out / name), 'bytes': (out / name).stat().st_size}
              for name in ['model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index']}
    profile = {'schema': 'lucidheart-voice-profile-v1', 'id': 'feiyu-rvc-v1', 'engine': 'rvc-onnx',
               'modelsDir': '.', 'index': 'voice.mobile.index', 'indexMethod': 'l2-8',
               'synthesisMode': 'continuous', 'noiseScale': 0.66666,
               'pitch': 0, 'brightness': 0, 'indexRatio': 0.3, 'protect': 0.33,
               'ttsVoice': 'zh-CN-XiaoxiaoNeural', 'assets': assets,
               'sourceCheckpointSha256': sha(args.checkpoint), 'sourceIndexSha256': sha(args.index),
               'contentvecSha256': sha(args.contentvec / 'pytorch_model.bin'),
               'validation': {'generatorMaxError': error, 'generatorMeanError': mean_error,
                              'generatorRepeatMeanError': repeat_error, 'generatorCorrelation': correlation,
                              'generatorComparison': 'stochastic, not sample-exact parity', 'encoderMaxErrors': encoder_errors,
                              'nsfPhaseAccumulator': 'float64-v1', 'voicedPhaseChecks': speech_checks,
                              'provider': 'CPUExecutionProvider', 'indexVectors': len(vectors)},
               'qualityScope': 'PC export checks only; phone runtime and listening require separate validation'}
    (out / 'voice-profile.json').write_text(json.dumps(profile, indent=2), encoding='utf8')
    print(str(out / 'voice-profile.json'), flush=True)


if __name__ == '__main__':
    main()
