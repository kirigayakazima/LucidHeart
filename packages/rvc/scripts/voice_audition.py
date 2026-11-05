"""Generate controlled short-clip auditions through the bundled phone CPU worker.

Uses a new output directory; never edits the profile, models or accepted audio.
Edge TTS is online. Existing dry input is reused for unchanged-rate comparisons.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

DEFAULT_TEXT = '你好呀，我是小满。这个是新声库的测试，先听听自然不自然。'


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def validate_presets(presets):
    if not isinstance(presets, list) or not presets:
        raise ValueError('Presets must be a nonempty list')
    ids = set()
    for preset in presets:
        name = preset.get('id', '')
        rate, scale = preset.get('rate'), preset.get('intonationScale')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name) or name in ids:
            raise ValueError('Preset IDs must be unique safe file names')
        ids.add(name)
        if not isinstance(rate, str) or not re.fullmatch(r'[+-]\d+%', rate) or not -20 <= int(rate[:-1]) <= 20:
            raise ValueError('Preset rate must be within -20%..+20%')
        if isinstance(scale, bool) or not isinstance(scale, (float, int)) or not .8 <= scale <= 1.6:
            raise ValueError('Preset intonationScale must be within 0.8..1.6')
    return presets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path, help='Must not exist')
    parser.add_argument('--text', default=DEFAULT_TEXT, help='Spoken text; continuous runtime splits long audio at pauses')
    parser.add_argument('--dry-input', type=Path, help='Existing +0%% dry audio for exactly this text')
    parser.add_argument('--reference-audio', type=Path, help='Copy an already accepted WAV unchanged')
    parser.add_argument('--presets', type=Path, default=Path(__file__).with_name('voice_audition_presets.json'))
    parser.add_argument('--only', nargs='+', help='Generate selected preset IDs only')
    parser.add_argument('--rate', help='Generate one custom case, e.g. --rate=+8%%')
    parser.add_argument('--intonation-scale', type=float, help='One custom case, e.g. 1.3')
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    profile_path = args.profile.resolve()
    profile = json.loads(profile_path.read_text(encoding='utf-8-sig'))
    if profile.get('engine') != 'rvc-onnx' or profile.get('synthesisMode') != 'continuous':
        raise ValueError('Use the accepted continuous phase-fixed RVC profile')
    models = (profile_path.parent / profile['modelsDir']).resolve()
    if profile.get('pitch') not in (0, -4) or profile.get('ttsCommand'):
        raise ValueError('Audition requires 0/-4 pitch and direct Edge TTS; ttsCommand is not supported here')
    if profile.get('validation', {}).get('nsfPhaseAccumulator') != 'float64-v1':
        raise ValueError('Profile must identify the phase precision fix; do not audition the rejected old export')
    if not args.text.strip() or not 0 <= args.seed < 2 ** 32:
        raise ValueError('Text must be nonempty and seed must be within 0..2**32-1')
    custom = args.rate is not None or args.intonation_scale is not None
    if custom:
        if args.only:
            raise ValueError('--only cannot be combined with custom parameters')
        presets = [{'id': 'custom', 'label': '自定义', 'rate': args.rate or '+0%',
                    'intonationScale': args.intonation_scale if args.intonation_scale is not None else 1.0}]
    else:
        presets = json.loads(args.presets.read_text(encoding='utf-8-sig'))
        validate_presets(presets)
        if args.only:
            if set(args.only) - {p['id'] for p in presets}:
                raise ValueError('Unknown preset ID')
            presets = [p for p in presets if p['id'] in args.only]
    validate_presets(presets)
    out = args.output_dir.resolve()
    if out.exists() or out.is_relative_to(models):
        raise ValueError('Output directory must be new and outside modelsDir')
    dry_input = args.dry_input.resolve() if args.dry_input else None
    reference = args.reference_audio.resolve() if args.reference_audio else None
    for source in [dry_input, reference]:
        if source is not None and not source.is_file():
            raise FileNotFoundError(source)
    out.mkdir(parents=True)
    (out / 'dry').mkdir()
    manifest = {'schema': 'lucidheart-voice-audition-v1', 'text': args.text,
                'profile': str(profile_path), 'profileSha256': sha(profile_path),
                'seed': args.seed, 'presets': presets, 'cases': [], 'state': 'running',
                'scope': 'PC phone-code CPU audition; not ARM64 or emotion-model acceptance'}
    manifest_file = out / 'manifest.json'

    def save():
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')

    save()
    try:
        if reference:
            copied = out / 'reference_accepted.wav'
            shutil.copyfile(reference, copied)
            manifest['acceptedReference'] = {'source': str(reference), 'output': copied.name, 'sha256': sha(copied)}
            save()
        dry_cache = {}
        if dry_input:
            dry_cache['+0%'] = dry_input
        env = os.environ.copy()
        if profile.get('pythonPath'):
            env['PYTHONPATH'] = os.pathsep.join(filter(None, [profile['pythonPath'], env.get('PYTHONPATH')]))
        worker = Path(__file__).with_name('voice_profile_speak.py')
        for preset in presets:
            name, rate = preset['id'], preset['rate']
            print(f'Generating {name}: rate={rate}, intonation={preset["intonationScale"]}', flush=True)
            if rate not in dry_cache:
                import edge_tts
                dry = out / 'dry' / f'rate_{int(rate[:-1]):+d}.mp3'
                asyncio.run(edge_tts.Communicate(args.text, profile.get('ttsVoice', 'zh-CN-XiaoxiaoNeural'), rate=rate).save(str(dry)))
                dry_cache[rate] = dry
            dry = dry_cache[rate]
            output = out / f'{name}.wav'
            command = [sys.executable, str(worker), '--profile', str(profile_path), '--input', str(dry),
                       '--output', str(output), '--intonation-scale', str(preset['intonationScale']), '--seed', str(args.seed)]
            completed = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=300)
            if completed.returncode:
                raise RuntimeError(f'{name} failed: {completed.stderr[-3000:]}')
            result = json.loads(output.with_suffix('.result.json').read_text(encoding='utf8'))
            manifest['cases'].append({**preset, 'output': output.name, 'input': str(dry), 'inputSha256': sha(dry),
                                      'outputSha256': result['outputSha256'], 'durationSeconds': result['duration_seconds'],
                                      'elapsedTotalMs': result['elapsedTotalMs'], 'seed': args.seed,
                                      'runtimeSha256': result['runtimeSha256'], 'result': output.with_suffix('.result.json').name})
            save()
            print(f'Done {name}: {result["duration_seconds"]}s audio', flush=True)
        manifest['state'] = 'completed'
        save()
    except Exception as error:
        manifest['state'], manifest['error'] = 'failed', str(error)
        save()
        raise
    print(str(manifest_file), flush=True)


if __name__ == '__main__':
    main()
