import array
import os
import pytest

from fullawake.capabilities.voice_vad import SpeechGate, VoiceVadListener
from fullawake.core.config import FullAwakeConfig


class DummyDetector:
    def __init__(self, is_speech=True):
        self._is_speech = is_speech

    def is_speech(self, pcm, sample_rate):
        return self._is_speech


def make_pcm(rms_val: int, length: int = 320) -> bytes:
    # 320 int16 samples = 20ms @ 16kHz
    return array.array('h', [rms_val] * length).tobytes()


def test_speech_gate_headphone_mode_normal_trigger():
    starts = []
    ends = []
    gate = SpeechGate(
        detector=DummyDetector(True),
        sample_rate=16000,
        on_start=lambda: starts.append(True),
        on_end=lambda: ends.append(True),
        device_mode="headphone",
    )

    # Frame 1: voiced, RMS 100 (> 80)
    gate.feed(make_pcm(100))
    assert len(starts) == 0

    # Frame 2: voiced -> triggers on_start
    gate.feed(make_pcm(100))
    assert len(starts) == 1
    assert gate.speaking is True

    # Playback active in headphone mode does not alter sensitivity
    gate.speaking = False
    gate.voiced = 0
    gate.set_playback_active(True)
    gate.feed(make_pcm(100))
    assert len(starts) == 1
    gate.feed(make_pcm(100))
    assert len(starts) == 2


def test_speech_gate_speaker_mode_ducks_playback_leak():
    starts = []
    ends = []
    gate = SpeechGate(
        detector=DummyDetector(True),
        sample_rate=16000,
        on_start=lambda: starts.append(True),
        on_end=lambda: ends.append(True),
        device_mode="speaker",
    )

    gate.set_playback_active(True)

    # Simulate speaker sound leaking into microphone:
    # RMS 130 is voiced by detector, but under the ducking floor (220)
    for _ in range(10):
        gate.feed(make_pcm(130))

    # Self-interruption must be completely blocked!
    assert len(starts) == 0
    assert gate.speaking is False


def test_speech_gate_speaker_mode_allows_loud_interrupt_during_playback():
    starts = []
    ends = []
    gate = SpeechGate(
        detector=DummyDetector(True),
        sample_rate=16000,
        on_start=lambda: starts.append(True),
        on_end=lambda: ends.append(True),
        device_mode="speaker",
    )

    gate.set_playback_active(True)

    # User speaks loudly near the microphone (RMS 350 >= 220)
    # Speaker mode requires 4 consecutive frames (80ms)
    gate.feed(make_pcm(350))
    assert len(starts) == 0
    gate.feed(make_pcm(350))
    assert len(starts) == 0
    gate.feed(make_pcm(350))
    assert len(starts) == 0
    gate.feed(make_pcm(350))
    # 4th frame triggers deliberate interrupt!
    assert len(starts) == 1
    assert gate.speaking is True


def test_speech_gate_speaker_mode_recovers_sensitivity_when_playback_stops():
    starts = []
    ends = []
    gate = SpeechGate(
        detector=DummyDetector(True),
        sample_rate=16000,
        on_start=lambda: starts.append(True),
        on_end=lambda: ends.append(True),
        device_mode="speaker",
    )

    gate.set_playback_active(True)
    # Blocked during playback
    gate.feed(make_pcm(110))
    gate.feed(make_pcm(110))
    assert len(starts) == 0

    # Playback finishes
    gate.set_playback_active(False)

    # Next 2 frames of normal speech immediately trigger on_start
    gate.feed(make_pcm(110))
    assert len(starts) == 0
    gate.feed(make_pcm(110))
    assert len(starts) == 1


def test_vad_listener_playback_active_propagation():
    listener = VoiceVadListener(lambda: None, lambda: None, device_mode="speaker")
    assert listener._playback_active is False

    listener.set_playback_active(True)
    assert listener._playback_active is True

    # When gate is attached, state is in sync
    gate = SpeechGate(DummyDetector(True), 16000, lambda: None, lambda: None, device_mode="speaker")
    listener._gate = gate
    listener.set_playback_active(False)
    assert gate.playback_active is False
    listener.set_playback_active(True)
    assert gate.playback_active is True


def test_config_vad_device_mode(monkeypatch):
    cfg = FullAwakeConfig()
    assert cfg.vad_device_mode == "headphone"

    monkeypatch.setenv("FULLAWAKE_VAD_DEVICE_MODE", "speaker")
    cfg_speaker = FullAwakeConfig()
    assert cfg_speaker.vad_device_mode == "speaker"

    monkeypatch.setenv("FULLAWAKE_VAD_DEVICE_MODE", "unsupported_xyz")
    cfg_fallback = FullAwakeConfig()
    assert cfg_fallback.vad_device_mode == "headphone"
