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

    # 2. Short Auto-VAD utterance (< 1.0s, e.g. "嗯/好") in a quiet room is NEVER swallowed by voiceprint check
    current_vec = video_actor_vec
    short_reply = np.ones(10000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(short_reply, 16000, ptt=False, speaker_active=False)
    assert cleaned is not None and reason == ''

    # 2b. Ultra-short burst (< 0.6s) while speakers ARE actively playing is blocked as short_speaker_bleed
    ultra_short_bleed = np.ones(6000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(ultra_short_bleed, 16000, ptt=False, speaker_active=True)
    assert cleaned is None and reason.startswith('short_speaker_bleed')

    # 3. Long Auto-VAD utterance (>= 1.0s) from video actor while speakers are playing is rejected
    video_bleed = np.ones(20000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(video_bleed, 16000, ptt=False, speaker_active=True)
    assert cleaned is None
    assert reason.startswith('voiceprint_mismatch')

    # 4. Long Auto-VAD utterance (>= 1.0s) from owner passes even while speakers are playing
    current_vec = owner_vec
    owner_speech = np.ones(20000, dtype=np.float32) * 0.08
    cleaned, reason = proc.process(owner_speech, 16000, ptt=False, speaker_active=True)
    assert cleaned is not None and reason == ''
