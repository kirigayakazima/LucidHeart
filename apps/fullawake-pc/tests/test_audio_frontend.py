"""Unit tests for the 4-layer PC audio front-end (CoreAudio ducking, Silero VAD, GTCRN denoiser, 3D-Speaker gate)."""

from types import SimpleNamespace
import numpy as np
from fullawake.capabilities.audio_frontend import AudioFrontEndProcessor
from fullawake.capabilities.voice_vad import SpeechGate


def test_speech_gate_ducks_when_system_speaker_is_playing():
    started = []
    detector = SimpleNamespace(is_speech=lambda pcm, sr: True)
    gate = SpeechGate(detector, 16000, lambda: started.append(True), lambda: None, device_mode='speaker')
    gate.system_speaker_peak = 0.65  # Loud video playing on PC speakers -> min_rms = 0.65 * 420 = 273

    # Background bleed at RMS ~160 should NOT trigger speech start while video is loud
    bleed_frame = (np.ones(320, dtype=np.int16) * 160).tobytes()
    for _ in range(6):
        gate.feed(bleed_frame)
    assert started == []

    # Near-field owner voice at RMS ~400 crosses dynamic speaker threshold after 4 frames
    near_voice = (np.ones(320, dtype=np.int16) * 400).tobytes()
    for _ in range(4):
        gate.feed(near_voice)
    assert len(started) == 1


def test_audio_frontend_rejects_keyboard_noise_and_gates_foreign_voiceprint(tmp_path):
    vp_file = tmp_path / 'owner-vp.json'
    proc = AudioFrontEndProcessor(models_dir=tmp_path / 'no-models', voiceprint_file=vp_file)

    # Mock GTCRN denoiser stripping pure keyboard click noise down to near-zero RMS
    proc._denoiser = lambda arr, sr: SimpleNamespace(samples=np.zeros_like(arr))
    noise = np.ones(8000, dtype=np.float32) * 0.05
    cleaned, reason = proc.process(noise, 16000, ptt=False, speaker_active=False)
    assert cleaned is None
    assert reason.startswith('non_vocal_noise')

    # Mock clean vocal speech through denoiser + 3D-Speaker embedding extractor
    proc._denoiser = lambda arr, sr: SimpleNamespace(samples=arr)
    owner_vec = np.array([1.0] + [0.0] * 191, dtype=np.float32)
    video_actor_vec = np.array([0.0, 1.0] + [0.0] * 190, dtype=np.float32)

    current_vec = owner_vec
    proc.compute_embedding = lambda samples, sr=16000: current_vec

    # 1. PTT utterance >= 1.2s auto-enrolls owner voiceprint and passes
    ptt_speech = np.ones(20000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(ptt_speech, 16000, ptt=True, speaker_active=False)
    assert cleaned is not None and reason == ''
    assert vp_file.is_file()

    # 2. Auto-VAD utterance >= 0.55s from foreign voice is rejected even in a quiet room
    current_vec = video_actor_vec
    short_reply = np.ones(10000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(short_reply, 16000, ptt=False, speaker_active=False)
    assert cleaned is None and reason.startswith('voiceprint_mismatch')

    # 2b. Ultra-short burst (< 0.55s) in Auto-VAD is blocked as short_unverified
    ultra_short_bleed = np.ones(6000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(ultra_short_bleed, 16000, ptt=False, speaker_active=True)
    assert cleaned is None and reason.startswith('short_unverified')

    # 2c. PTT utterance from foreign voice is also rejected and never pollutes enrollment
    cleaned, reason = proc.process(ptt_speech, 16000, ptt=True, speaker_active=False)
    assert cleaned is None and reason.startswith('ptt_voiceprint_mismatch')
    assert proc._owner_count == 1

    # 2d. Low-volume PTT utterance from owner passes verification but is NOT enrolled as voiceprint reference
    current_vec = owner_vec
    low_vol_ptt = np.ones(20000, dtype=np.float32) * 0.008
    cleaned, reason = proc.process(low_vol_ptt, 16000, ptt=True, speaker_active=False)
    assert cleaned is not None and reason == ''
    assert proc._owner_count == 1

    # 3. Long Auto-VAD utterance (>= 1.0s) from video actor while speakers are playing is rejected
    current_vec = video_actor_vec
    video_bleed = np.ones(20000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(video_bleed, 16000, ptt=False, speaker_active=True)
    assert cleaned is None
    assert reason.startswith('voiceprint_mismatch')

    # 4. Long Auto-VAD utterance (>= 1.0s) from owner passes even while speakers are playing
    current_vec = owner_vec
    owner_speech = np.ones(20000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(owner_speech, 16000, ptt=False, speaker_active=True)
    assert cleaned is not None and reason == ''


def test_voiceprint_locks_at_five_samples_and_verify_barge_in_chunk(tmp_path):
    vp_file = tmp_path / 'owner-vp.json'
    proc = AudioFrontEndProcessor(models_dir=tmp_path / 'no-models', voiceprint_file=vp_file)
    proc._denoiser = lambda arr, sr: SimpleNamespace(samples=arr)
    owner_vec = np.array([1.0] + [0.0] * 191, dtype=np.float32)
    other_vec = np.array([0.0, 1.0] + [0.0] * 190, dtype=np.float32)
    proc.compute_embedding = lambda samples, sr=16000: owner_vec

    speech = np.ones(20000, dtype=np.float32) * 0.08
    for _ in range(5):
        assert proc.enroll_from_ptt(speech, 16000) is True
    assert proc._owner_count == 5

    # 6th enrollment attempt is rejected by default lock so production voiceprint cannot be polluted
    proc.compute_embedding = lambda samples, sr=16000: other_vec
    assert proc.enroll_from_ptt(speech, 16000) is False
    assert np.allclose(proc._owner_embedding, owner_vec)

    # 640ms chunk verification rejects foreign speaker and accepts owner
    pcm_640ms = (np.ones(10240, dtype=np.int16) * 2000).tobytes()
    assert proc.verify_barge_in_chunk(pcm_640ms, 16000) is False
    proc.compute_embedding = lambda samples, sr=16000: owner_vec
    assert proc.verify_barge_in_chunk(pcm_640ms, 16000) is True


def test_barge_candidate_backchannel_restores_volume_while_directive_cuts():
    import asyncio
    from fullawake.capabilities.desktop_vision.watch import WatchCapability
    from fullawake.gateway.interrupt_controller import InterruptController

    watch = WatchCapability(token='x' * 32)
    q = asyncio.Queue()
    watch.subscribers.add(q)
    watch.player = q
    watch.bridge_output = 'utt-123'

    assert watch.duck_output(0.18) is True
    ev = q.get_nowait()
    assert ev == {'event': 'playback_duck', 'utteranceId': 'utt-123', 'volume': 0.18}

    sent = []
    cuts = []
    voice = SimpleNamespace(transcribe=lambda wav, **kw: {'ok': True, 'text': '嗯嗯。'})
    ctrl = InterruptController(watch, voice)
    peer = SimpleNamespace(
        call_active=True, capture_enabled=True, call_generation=1, trace=None,
        send=lambda kind, **payload: sent.append((kind, payload)),
    )
    ctrl.peer = peer
    ctrl.vad = SimpleNamespace(
        last_utterance_barge_candidate=True, last_utterance_ptt=False, last_utterance_speaker_active=True
    )
    ctrl.on_speech_start = lambda p: cuts.append(p)

    # 1. Backchannel ("嗯嗯。") restores volume to 1.0 without cutting or sending transcript
    asyncio.run(ctrl._transcribe_utterance(peer, b'wav'))
    assert cuts == []
    assert sent == []
    assert q.get_nowait() == {'event': 'playback_duck', 'utteranceId': 'utt-123', 'volume': 1.0}

    # 2. Directive interruption ("等一下") cuts playback and sends transcript to phone
    voice.transcribe = lambda wav, **kw: {'ok': True, 'text': '等一下'}
    ctrl.vad.last_utterance_barge_candidate = True
    asyncio.run(ctrl._transcribe_utterance(peer, b'wav'))
    assert len(cuts) == 1
    assert any(kind == 'audio.transcript' for kind, _ in sent)
