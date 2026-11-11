"""Local 20 ms microphone capture. PCM stays on the capture thread."""

import logging
import math
from threading import Event, Thread

log = logging.getLogger(__name__)
FRAME_MS = 20


class SpeechGate:
    """Debounce WebRTC decisions against the recent background energy with speaker ducking."""

    def __init__(self, detector, sample_rate, on_start, on_end, *, device_mode="headphone"):
        self.detector = detector
        self.sample_rate = sample_rate
        self.on_start = on_start
        self.on_end = on_end
        self.device_mode = device_mode
        self.playback_active = False
        self.noise = 40.0
        self.voiced = self.quiet = 0
        self.speaking = False

    def set_playback_active(self, active: bool):
        self.playback_active = bool(active)

    def feed(self, pcm):
        samples = memoryview(pcm).cast('h')
        rms = math.sqrt(sum(value * value for value in samples) / len(samples))
        voiced = self.detector.is_speech(pcm, self.sample_rate)

        is_ducked = self.playback_active and self.device_mode == "speaker"
        if is_ducked:
            min_rms = max(220.0, self.noise * 4.5)
            required_voiced = 4
        else:
            min_rms = max(80.0, self.noise * 2.5)
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
    def __init__(self, on_speech_start, on_speech_end=None, sample_rate=16000, *, device=None, device_mode="headphone"):
        self.on_start = on_speech_start
        self.on_end = on_speech_end or (lambda: None)
        self.sample_rate = sample_rate
        self.device = device
        self.device_mode = device_mode
        self._gate = None
        self._playback_active = False
        self._stop = Event()
        self._ready = Event()
        self._available = False
        self._thread = Thread(target=self._run, name='fullawake-vad', daemon=True)

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
            import sounddevice
            import webrtcvad

            if self._stop.is_set():
                return
            frames = self.sample_rate * FRAME_MS // 1000
            gate = SpeechGate(webrtcvad.Vad(2), self.sample_rate, self.on_start, self.on_end, device_mode=self.device_mode)
            gate.set_playback_active(self._playback_active)
            self._gate = gate
            with sounddevice.RawInputStream(device=self.device, samplerate=self.sample_rate,
                                           blocksize=frames, channels=1, dtype='int16', latency='low') as stream:
                self._available = True
                self._ready.set()
                while not self._stop.is_set():
                    pcm, overflowed = stream.read(frames)
                    if not overflowed and not self._stop.is_set():
                        gate.feed(bytes(pcm))
        except Exception as error:
            log.warning('Microphone VAD unavailable (%s)', type(error).__name__)
        finally:
            self._available = False
            self._ready.set()
            if not self._stop.is_set():
                self.on_end()
