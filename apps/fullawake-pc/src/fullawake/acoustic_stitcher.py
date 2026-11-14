"""PCM envelope and timeline-aligned half-Hann speech stitching."""

from array import array
from io import BytesIO
import math
import re
import sys
import wave


def utterance_sync(data, text=''):
    with wave.open(BytesIO(data), 'rb') as wav:
        channels, rate, count = wav.getnchannels(), wav.getframerate(), wav.getnframes()
        if wav.getsampwidth() != 2:
            raise ValueError('Expected PCM16 waveform')
        samples = array('h', wav.readframes(count))
    if len(samples) != count * channels:
        raise ValueError('Truncated PCM')
    if sys.byteorder != 'little':
        samples.byteswap()
    duration = math.ceil(count * 1000 / rate)
    frames = []
    phrases = [part.strip() for part in re.findall(r'[^，。！？、,.!?\n]+[，。！？、,.!?]?', text) if part.strip()]
    total = sum(map(len, phrases))
    cumulative = 0
    subtitles = {}
    for phrase in phrases:
        offset = min((duration - 1) // 20 * 20, round(cumulative * duration / total / 20) * 20)
        subtitles[offset] = subtitles.get(offset, '') + phrase
        cumulative += len(phrase)
    for offset in range(0, duration, 20):
        segment = samples[offset * rate // 1000 * channels:(offset + 20) * rate // 1000 * channels]
        rms = math.sqrt(sum(value * value for value in segment) / max(1, len(segment))) / 32768
        frame = {'offsetMs': offset, 'intensity': round(rms, 4),
                 'mouthShape': 'open_wide' if rms >= .08 else 'open_narrow' if rms >= .018 else 'closed'}
        if offset in subtitles:
            frame['subtitleText'] = subtitles[offset]
        frames.append(frame)
    return {'durationMs': duration, 'visemes': frames}


def join_speech_segments(spans, chunks, total_samples, bounds):
    """Blend aligned context over 50 ms at 40 kHz, preserving the utterance length."""
    import numpy as np

    output = np.empty(round(total_samples * 2.5), dtype=np.float32)
    previous_end = 0
    for span, chunk in zip(spans, chunks, strict=True):
        start, end = bounds(span, total_samples)
        if not 0 <= start <= previous_end <= end <= len(output) or len(chunk) != end - start:
            raise ValueError('Invalid speech segment boundaries')
        overlap = previous_end - start
        if overlap:
            width = min(2000, overlap)
            first = (overlap - width) // 2
            gain = np.zeros(overlap, dtype=np.float32)
            gain[first:first + width] = .5 - .5 * np.cos(np.linspace(0, np.pi, width)) if width > 1 else .5
            gain[first + width:] = 1
            output[start:previous_end] = output[start:previous_end] * (1 - gain) + chunk[:overlap] * gain
        output[previous_end:end] = chunk[overlap:]
        previous_end = end
    if previous_end != len(output):
        raise ValueError('Speech segment tail missing')
    return output
