"""Rule-based Edge-TTS phrasing experiment, followed by the phone ONNX worker.

Only numeric speaking rates and silence gaps are controlled. No custom SSML,
emotion labels, pitch shifts, or text rewriting are sent to Edge TTS.
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
import numpy as np
import soundfile as sf

SAMPLE_RATE = 16000
ENDS = '。！？!?；;\n'
CLOSERS = '”’」』）)]"\''


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def normalized(text):
    return re.sub(r'\s+', '', text)


def split_phrases(text):
    """Preserve words/punctuation; do not split tiny comma-separated greetings."""
    phrases, start, index = [], 0, 0
    while index < len(text):
        if text[index] not in ENDS:
            index += 1
            continue
        end = index + 1
        while end < len(text) and text[end] in ENDS + CLOSERS:
            end += 1
        if text[start:end].strip():
            phrases.append(text[start:end].strip())
        start = index = end
    if text[start:].strip():
        phrases.append(text[start:].strip())
    return phrases


def build_plan(text, base_rate=6):
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise ValueError('Use a nonempty short spoken text of at most 500 characters')
    if not isinstance(base_rate, int) or not -10 <= base_rate <= 15:
        raise ValueError('Base rate must be an integer within -10..15')
    phrases = split_phrases(text)
    parts = []
    for index, phrase in enumerate(phrases):
        if '？' in phrase or '?' in phrase:
            rate, gap, reason = base_rate - 2, 180, 'question: slightly slower'
        elif '！' in phrase or '!' in phrase:
            rate, gap, reason = base_rate + 3, 140, 'exclamation: slightly quicker'
        elif '…' in phrase:
            rate, gap, reason = base_rate - 4, 240, 'ellipsis: leave space'
        elif index == 0 and re.match(r'^(你好|嗨|欸|哎|你回来)', phrase):
            rate, gap, reason = base_rate + 2, 130, 'greeting: quicker opening'
        elif index == len(phrases) - 1:
            rate, gap, reason = base_rate - 2, 0, 'ending: slightly slower'
        else:
            rate, gap, reason = base_rate, 160, 'sentence boundary'
        parts.append({'text': phrase, 'rate': f'{rate:+d}%',
                      'gapMs': gap if index < len(phrases) - 1 else 0, 'reason': reason})
    return {'schema': 'lucidheart-edge-expression-v1', 'text': text,
            'baseRate': f'{base_rate:+d}%', 'parts': parts,
            'scope': 'punctuation/greeting heuristics, not semantic emotion recognition'}


def validate_plan(plan, text):
    if plan.get('schema') != 'lucidheart-edge-expression-v1' or not plan.get('parts'):
        raise ValueError('Invalid expression plan')
    if normalized(plan.get('text', '')) != normalized(text):
        raise ValueError('Plan text differs from requested text')
    parts = plan['parts']
    if len(parts) > 24 or normalized(''.join(p.get('text', '') for p in parts)) != normalized(text):
        raise ValueError('Plan must preserve the complete spoken text exactly')
    for part in parts:
        if not isinstance(part.get('text'), str) or not part['text'].strip():
            raise ValueError('Each phrase needs spoken text')
        rate, gap = part.get('rate'), part.get('gapMs')
        if not isinstance(rate, str) or not re.fullmatch(r'[+-]\d+%', rate) or not -20 <= int(rate[:-1]) <= 20:
            raise ValueError('Phrase rate must be within -20%..+20%')
        if isinstance(gap, bool) or not isinstance(gap, int) or not 0 <= gap <= 600:
            raise ValueError('Extra gap must be within 0..600 milliseconds')
    if parts[-1]['gapMs'] != 0:
        raise ValueError('Last phrase must have no extra trailing gap')
    return plan


def decode_audio(path):
    result = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(path),
                             '-vn', '-ac', '1', '-ar', str(SAMPLE_RATE), '-f', 'f32le', '-'],
                            check=True, capture_output=True, timeout=60)
    audio = np.frombuffer(result.stdout, dtype='<f4').copy()
    if len(audio) < SAMPLE_RATE * .05 or not np.isfinite(audio).all() or np.max(abs(audio)) < 1e-5:
        raise ValueError('TTS produced invalid/silent audio')
    return audio


def trim_outer_silence(audio):
    """Trim silence only, keeping 30/50ms margins. Never normalize phrase volume."""
    width = SAMPLE_RATE // 50
    padded = np.pad(audio, (0, (-len(audio)) % width))
    rms = np.sqrt(np.mean(padded.reshape(-1, width).astype(np.float64) ** 2, axis=1))
    active = np.flatnonzero(rms >= max(1e-4, float(rms.max()) * .01))
    if not len(active):
        raise ValueError('No speech detected in TTS phrase')
    start = max(0, int(active[0]) * width - int(SAMPLE_RATE * .03))
    end = min(len(audio), (int(active[-1]) + 1) * width + int(SAMPLE_RATE * .05))
    return audio[start:end].copy(), {'originalSamples': len(audio), 'startSample': start, 'endSample': end}


async def render_plan(plan, voice, directory):
    import edge_tts
    directory.mkdir()
    chunks, records = [], []
    for index, part in enumerate(plan['parts']):
        source = directory / f'phrase_{index:02d}.mp3'
        print(f'Edge phrase {index + 1}/{len(plan["parts"])}: rate={part["rate"]}', flush=True)
        await edge_tts.Communicate(part['text'], voice, rate=part['rate']).save(str(source))
        audio, trim = trim_outer_silence(decode_audio(source))
        chunks.append(audio)
        gap_samples = round(part['gapMs'] * SAMPLE_RATE / 1000)
        if gap_samples:
            chunks.append(np.zeros(gap_samples, dtype=np.float32))
        records.append({**part, 'file': source.name, 'sha256': sha(source), 'trim': trim,
                        'speechSamples': len(audio), 'insertedSilenceSamples': gap_samples})
    combined = np.concatenate(chunks)
    if len(combined) >= 10 * SAMPLE_RATE:
        raise ValueError('Combined dry audio must be shorter than 10 seconds for the current RVC mode')
    return combined, records


def convert(profile, dry, output, env):
    worker = Path(__file__).with_name('voice_profile_speak.py')
    command = [sys.executable, str(worker), '--profile', str(profile), '--input', str(dry),
               '--output', str(output), '--intonation-scale', '1.0', '--seed', '42']
    completed = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=300)
    if completed.returncode:
        raise RuntimeError(f'RVC worker failed: {completed.stderr[-3000:]}')
    return json.loads(output.with_suffix('.result.json').read_text(encoding='utf8'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--text', required=True)
    parser.add_argument('--output-dir', required=True, type=Path, help='Must not exist')
    parser.add_argument('--base-rate', type=int, default=6)
    parser.add_argument('--plan', type=Path, help='Optional editable expression-plan JSON')
    parser.add_argument('--control-dry', type=Path, help='Reuse exactly matching text at the base rate')
    args = parser.parse_args()
    profile_path = args.profile.resolve()
    profile = json.loads(profile_path.read_text(encoding='utf-8-sig'))
    if (profile.get('engine') != 'rvc-onnx' or profile.get('synthesisMode') != 'continuous'
            or profile.get('validation', {}).get('nsfPhaseAccumulator') != 'float64-v1'):
        raise ValueError('Use the accepted continuous phase-fixed voice profile')
    if profile.get('ttsCommand') or profile.get('pitch') not in (0, -4):
        raise ValueError('This experiment requires direct Edge TTS and 0/-4 RVC pitch')
    automatic = build_plan(args.text, args.base_rate)
    plan = json.loads(args.plan.read_text(encoding='utf-8-sig')) if args.plan else automatic
    validate_plan(plan, args.text)
    out = args.output_dir.resolve()
    models = (profile_path.parent / profile['modelsDir']).resolve()
    if out.exists() or out.is_relative_to(models):
        raise ValueError('Output directory must be new and outside modelsDir')
    if args.control_dry and not args.control_dry.is_file():
        raise FileNotFoundError(args.control_dry)
    out.mkdir(parents=True)
    plan_file = out / 'expression-plan.json'
    plan_file.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf8')
    manifest = {'schema': 'lucidheart-edge-expression-audition-v1', 'state': 'running', 'text': args.text,
                'baseRate': f'{args.base_rate:+d}%', 'profile': str(profile_path), 'profileSha256': sha(profile_path),
                'planSha256': sha(plan_file), 'frontendSha256': sha(__file__), 'intonationScale': 1.0, 'seed': 42,
                'voice': profile.get('ttsVoice', 'zh-CN-XiaoxiaoNeural'), 'outputs': {}}
    manifest_file = out / 'manifest.json'

    def save():
        manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')

    save()
    try:
        import edge_tts
        control = out / 'control.dry.mp3'
        if args.control_dry:
            shutil.copyfile(args.control_dry, control)
            manifest['controlDrySource'] = str(args.control_dry.resolve())
        else:
            print('Edge whole-text control', flush=True)
            asyncio.run(edge_tts.Communicate(args.text, manifest['voice'], rate=manifest['baseRate']).save(str(control)))
        expression = out / 'expression.dry.wav'
        audio, records = asyncio.run(render_plan(plan, manifest['voice'], out / 'phrases'))
        sf.write(expression, audio, SAMPLE_RATE, subtype='PCM_16')
        manifest['phrases'] = records
        manifest['drySha256'] = {'control': sha(control), 'expression': sha(expression)}
        manifest['expressionDrySeconds'] = len(audio) / SAMPLE_RATE
        save()
        env = os.environ.copy()
        if profile.get('pythonPath'):
            env['PYTHONPATH'] = os.pathsep.join(filter(None, [profile['pythonPath'], env.get('PYTHONPATH')]))
        for name, dry in [('control', control), ('expression', expression)]:
            print(f'RVC converting {name}', flush=True)
            result = convert(profile_path, dry, out / f'{name}.wav', env)
            manifest['outputs'][name] = {'file': f'{name}.wav', 'sha256': result['outputSha256'],
                                          'result': f'{name}.result.json', 'runtimeSha256': result['runtimeSha256']}
            save()
        manifest['state'] = 'completed'
        save()
    except Exception as error:
        manifest['state'], manifest['error'] = 'failed', str(error)
        save()
        raise
    print(str(manifest_file), flush=True)


if __name__ == '__main__':
    main()
