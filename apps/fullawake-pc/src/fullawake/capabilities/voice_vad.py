"""Local 20 ms microphone capture. PCM stays on the capture thread."""

import logging
import math
from io import BytesIO
import time
import wave
from threading import Event, Thread

log = logging.getLogger(__name__)
FRAME_MS = 20
PTT_VIRTUAL_KEYS = {
    'rctrl': 0xA3,
    'lctrl': 0xA2,
    'ctrl': 0x11,
    'ralt': 0xA5,
    'f8': 0x77,
    'f9': 0x78,
    'f10': 0x79,
    'capslock': 0x14,
}


def build_ptt_probe(ptt_key: str | None):
    """Return a callable polling whether the configured push-to-talk key is held, or None."""
    key = (ptt_key or '').strip().lower()
    if not key or key in ('none', 'off', 'false', '0'):
        return None
    vk = PTT_VIRTUAL_KEYS.get(key)
    if vk is None:
        log.warning('Unknown push-to-talk key %r; PTT disabled', ptt_key)
        return None
    try:
        import ctypes
        user32 = ctypes.windll.user32
        return lambda: bool(user32.GetAsyncKeyState(vk) & 0x8000)
    except Exception:
        log.warning('Push-to-talk key polling unavailable on this platform')
        return None


def playback_reference(wav_data):
    with wave.open(BytesIO(wav_data), 'rb') as source:
        return _mono_samples(source, source.getnframes())


def _mono_samples(source, frames):
    rate, channels = source.getframerate(), source.getnchannels()
    pcm = memoryview(source.readframes(frames)).cast('h')
    total = len(pcm) // channels
    return tuple(sum(pcm[start:start + channels]) / channels for start in
                 (index * rate // 16000 * channels for index in range(total * 16000 // rate)))


def song_reference_window(path, cursor):
    with wave.open(str(path), 'rb') as source:
        if source.getsampwidth() != 2:
            return (), 0
        rate = source.getframerate()
        start = max(0, cursor - 5000)
        frame = start * rate // 16000
        if frame >= source.getnframes():
            return (), 0
        source.setpos(frame)
        return _mono_samples(source, 9000 * rate // 16000), cursor - start


def correlated_echo(samples, reference, offset):
    mic = samples[::4]
    mic_power = sum(value * value for value in mic)
    if mic_power == 0:
        return False
    for lag in range(0, 4001, 8):
        start = offset - lag
        if start < 0 or start + len(samples) > len(reference):
            continue
        window = reference[start:start + len(samples):4]
        power = sum(value * value for value in window)
        if power and mic_power < 4 * power:
            cross = sum(left * right for left, right in zip(mic, window))
            if abs(cross) > .65 * math.sqrt(mic_power * power):
                return True
    return False


class SpeechGate:
    """Debounce WebRTC decisions against the recent background energy with speaker ducking."""

    def __init__(self, detector, sample_rate, on_start, on_end, *, device_mode="headphone"):
        self.detector = detector
        self.sample_rate = sample_rate
        self.on_start = on_start
        self.on_end = on_end
        self.device_mode = device_mode
        self.playback_active = False
        self.system_speaker_peak = 0.0
        self.noise = 40.0
        self.voiced = self.quiet = 0
        self.speaking = False
        self.reference = None

    def set_playback_active(self, active: bool):
        self.playback_active = bool(active)

    def feed(self, pcm):
        samples = memoryview(pcm).cast('h')
        rms = math.sqrt(sum(value * value for value in samples) / len(samples))
        speaker_playing = self.playback_active or self.system_speaker_peak >= 0.025
        is_ducked = speaker_playing and self.device_mode == "speaker"
        reference = self.reference if (self.playback_active and self.device_mode == "speaker") else None
        echo = False
        if reference is not None and self.sample_rate == 16000:
            waveform, at, position = reference
            offset = position * 16 + round((time.monotonic() - at) * 16000) - len(samples)
            echo = correlated_echo(samples, waveform, offset)
        voiced = not echo and self.detector.is_speech(pcm, self.sample_rate)
        if is_ducked:
            min_rms = max(220.0, self.noise * 4.5, self.system_speaker_peak * 420.0)
            required_voiced = 4
        else:
            min_rms = max(55.0, self.noise * 2.5)
            required_voiced = 2

        if voiced and rms >= min_rms:
            self.quiet = 0
            self.voiced += 1
            if self.voiced == required_voiced and not self.speaking:
                self.speaking = True
                self.on_start()
            return
        if not voiced and not self.speaking:
            if not is_ducked:
                self.noise += 0.05 * (min(rms, self.noise * 2 + 40) - self.noise)
        self.voiced = 0
        self.quiet += 1
        if self.speaking and self.quiet == 12:
            self.speaking = False
            self.on_end()


class VoiceVadListener:
    def __init__(self, on_speech_start, on_speech_end=None, sample_rate=16000, *, device=None,
                 device_mode="headphone", on_utterance=None, ptt_key=None, ptt_probe=None):
        self.on_start = on_speech_start
        self.on_end = on_speech_end or (lambda: None)
        self.on_utterance = on_utterance
        self.sample_rate = sample_rate
        self.device = device
        self.device_mode = device_mode
        self.ptt_key = (ptt_key or '').strip().lower()
        self.ptt_probe = ptt_probe if ptt_probe is not None else build_ptt_probe(self.ptt_key)
        self._gate = None
        self._playback_active = False
        self.reference_provider = None
        self._stop = Event()
        self._ready = Event()
        self._available = False
        self._thread = Thread(target=self._run, name='fullawake-vad', daemon=True)
        self._settings = None
        self.rms = 0.0
        self.ptt_active = False
        self.last_utterance_ptt = False
        self.last_utterance_speaker_active = False

    def configure(self, key, muted):
        self._settings = (key, muted, build_ptt_probe(key))

    def set_playback_active(self, active: bool):
        self._playback_active = bool(active)
        if self._gate is not None:
            self._gate.set_playback_active(active)

    def start(self):
        if self._stop.is_set():
            return False
        self._thread.start()
        if not self._ready.wait(2):
            self._stop.set()
            log.warning('Microphone capture did not start within two seconds')
            return False
        return self._available

    def stop(self):
        self._stop.set()
        if self._thread.ident is not None:
            self._thread.join(timeout=2)
        if self._thread.is_alive():
            log.warning('Microphone capture did not stop within two seconds')

    def _run(self):
        try:
            from collections import deque
            import sounddevice
            import webrtcvad
            from fullawake.capabilities.audio_frontend import HybridVadDetector, SystemSpeakerMeter

            if self._stop.is_set():
                return
            frames = self.sample_rate * FRAME_MS // 1000
            pre_roll = deque(maxlen=15)
            utterance = []
            capturing = False
            utterance_had_speaker = False
            speaker_meter = SystemSpeakerMeter()

            def _handle_start():
                nonlocal capturing, utterance, utterance_had_speaker
                capturing = True
                utterance = list(pre_roll)
                utterance_had_speaker = bool(gate.playback_active or gate.system_speaker_peak >= 0.025)
                self.on_start()

            def _handle_end():
                nonlocal capturing, utterance, utterance_had_speaker
                was_capturing = capturing
                captured = utterance
                had_speaker = utterance_had_speaker
                capturing = False
                utterance = []
                utterance_had_speaker = False
                self.on_end()
                min_frames = 10 if self.ptt_probe is not None else 12
                if was_capturing and self.on_utterance and len(captured) >= min_frames:
                    self.last_utterance_ptt = self.ptt_probe is not None
                    self.last_utterance_speaker_active = had_speaker
                    buf = BytesIO()
                    with wave.open(buf, 'wb') as out:
                        out.setnchannels(1)
                        out.setsampwidth(2)
                        out.setframerate(self.sample_rate)
                        out.writeframes(b''.join(captured))
                    self.on_utterance(buf.getvalue())

            detector = HybridVadDetector(webrtcvad.Vad(2), self.sample_rate)
            gate = SpeechGate(detector, self.sample_rate, _handle_start, _handle_end, device_mode=self.device_mode)
            gate.set_playback_active(self._playback_active)
            self._gate = gate
            ptt_was_active = False
            applied = None
            muted = False
            playback_cooldown_until = 0.0
            barge_in_probe = build_ptt_probe(self.ptt_key or 'rctrl')
            if self.ptt_probe is not None:
                log.info('Push-to-talk enabled (key=%s): hold key to speak', self.ptt_key or 'custom')
            with sounddevice.RawInputStream(device=self.device, samplerate=self.sample_rate,
                                           blocksize=frames, channels=1, dtype='int16', latency='low') as stream:
                self._available = True
                self._ready.set()
                log.info('Microphone input stream active (rate=%d, device=%s)', self.sample_rate, self.device)
                while not self._stop.is_set():
                    pcm, overflowed = stream.read(frames)
                    if not self._stop.is_set():
                        raw = bytes(pcm)
                        settings = self._settings
                        if settings is not applied and settings is not None:
                            applied = settings
                            self.ptt_key, muted, self.ptt_probe = settings
                            self.ptt_active = ptt_was_active = False
                            capturing = False
                            utterance.clear()
                            pre_roll.clear()
                            gate.voiced = gate.quiet = 0
                            gate.speaking = False
                            self.on_end()
                        samples = memoryview(raw).cast('h')
                        self.rms = math.sqrt(sum(value * value for value in samples) / max(1, len(samples))) / 32768 if not muted else 0
                        gate.system_speaker_peak = speaker_meter.peak()
                        if gate.playback_active or gate.system_speaker_peak >= 0.025:
                            utterance_had_speaker = True
                        if muted:
                            continue
                        if self.ptt_probe is not None:
                            ptt_active = bool(self.ptt_probe())
                            self.ptt_active = ptt_active
                            if ptt_active != ptt_was_active:
                                ptt_was_active = ptt_active
                                if ptt_active:
                                    log.info('PTT pressed: mic gate open')
                                    if not capturing:
                                        _handle_start()
                                else:
                                    log.info('PTT released: mic gate closed (%d frames)', len(utterance))
                                    if capturing:
                                        _handle_end()
                            if ptt_active and capturing and not overflowed and len(utterance) < 1500:
                                utterance.append(raw)
                            pre_roll.clear()
                            continue
                        if overflowed:
                            continue
                        if capturing:
                            if len(utterance) < 750:
                                utterance.append(raw)
                        else:
                            pre_roll.append(raw)
                        if self.reference_provider:
                            active, gate.reference = self.reference_provider()
                            gate.set_playback_active(active)
                        now_mono = time.monotonic()
                        if gate.playback_active:
                            playback_cooldown_until = now_mono + 0.65
                        # In Auto-VAD speaker mode, shield the mic while Xiao Man herself is speaking (+650ms tail)
                        # so her own voice never interrupts herself or feeds back into ASR. Holding RCtrl still barges in.
                        if self.device_mode == "speaker" and now_mono < playback_cooldown_until:
                            if barge_in_probe is not None and barge_in_probe():
                                playback_cooldown_until = 0.0
                            else:
                                if not capturing:
                                    pre_roll.clear()
                                    gate.voiced = gate.quiet = 0
                                    continue
                        gate.feed(raw)
        except Exception as error:
            log.warning('Microphone VAD unavailable (%s)', type(error).__name__)
        finally:
            self._available = False
            self._ready.set()
            if not self._stop.is_set():
                self.on_end()
