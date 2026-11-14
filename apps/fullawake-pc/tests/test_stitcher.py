from io import BytesIO
import wave

from fullawake.acoustic_stitcher import join_speech_segments, utterance_sync
from fullawake.lease_arbiter import LeaseArbiter, PlaybackLease


def test_hann_keeps_equal_aligned_samples_and_tail():
    import numpy as np

    spans = [(0, 6000), (2000, 8000)]
    chunks = [np.full(6000, .6, dtype=np.float32)] * 2
    output = join_speech_segments(spans, chunks, 3200, lambda span, _total: span)
    assert len(output) == 8000
    np.testing.assert_allclose(output, .6, atol=1e-7)


def test_rms_frames_and_subtitle_offsets():
    buffer = BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setparams((1, 2, 8000, 0, 'NONE', ''))
        wav.writeframes(b'\0\0' * 160 + b'\0\x40' * 160)
    result = utterance_sync(buffer.getvalue(), '一，二')
    assert result['durationMs'] == 40
    assert result['visemes'][0]['mouthShape'] == 'closed'
    assert result['visemes'][1]['mouthShape'] == 'open_wide'
    assert [frame['subtitleText'] for frame in result['visemes']] == ['一，', '二']


def test_audio_lease_queues_song_then_revokes_without_releasing_stale_token():
    events = []
    arbiter = LeaseArbiter()
    make = lambda token, kind: PlaybackLease(token, kind, lambda: events.append(token), lambda: events.append('stop:' + token))
    assert arbiter.acquire(make('voice', 'speech')) == 'playing'
    assert arbiter.acquire(make('song', 'song')) == 'queued'
    assert not arbiter.finish('old')
    assert arbiter.finish('voice')
    arbiter.revoke()
    assert events == ['voice', 'song', 'stop:song']
