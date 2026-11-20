"""4-Layer PC Audio Front-End: CoreAudio Speaker Meter, Silero VAD, GTCRN Denoiser, and Context-Aware 3D-Speaker Gate."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import logging
import math
import os
from pathlib import Path
from threading import Lock
import numpy as np

log = logging.getLogger(__name__)

SUITE_ROOT = Path(__file__).resolve().parents[5]
DEFAULT_MODELS_DIR = SUITE_ROOT / 'local/fullawake/audio-models'
DEFAULT_VOICEPRINT_FILE = SUITE_ROOT / 'local/fullawake/owner-voiceprint.json'


class _GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', wintypes.DWORD),
        ('Data2', wintypes.WORD),
        ('Data3', wintypes.WORD),
        ('Data4', ctypes.c_ubyte * 8),
    ]

    def __init__(self, l, w1, w2, b1, b2, b3, b4, b5, b6, b7, b8):
        super().__init__(l, w1, w2, (ctypes.c_ubyte * 8)(b1, b2, b3, b4, b5, b6, b7, b8))


class SystemSpeakerMeter:
    """Zero-dependency Windows CoreAudio peak meter for the default render endpoint (0.0 to 1.0)."""

    def __init__(self):
        self._meter_ptr = None
        self._get_peak = None
        self._failed = False

    def _init_com(self):
        if self._failed or os.name != 'nt':
            self._failed = True
            return False
        try:
            clsid_enum = _GUID(0xBCDE0395, 0xE52F, 0x467C, 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E)
            iid_enum = _GUID(0xA95664D2, 0x9614, 0x4F35, 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6)
            iid_meter = _GUID(0xC02216F6, 0x8C67, 0x4B5B, 0x9D, 0x00, 0xD0, 0x08, 0xE7, 0x3E, 0x00, 0x64)
            ole32 = ctypes.windll.ole32
            ole32.CoInitialize(None)
            enum_ptr = ctypes.c_void_p()
            if ole32.CoCreateInstance(ctypes.byref(clsid_enum), None, 23, ctypes.byref(iid_enum), ctypes.byref(enum_ptr)) != 0:
                self._failed = True
                return False
            vt_enum = ctypes.cast(enum_ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            get_endpoint = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)
            )(vt_enum[4])
            dev_ptr = ctypes.c_void_p()
            if get_endpoint(enum_ptr, 0, 0, ctypes.byref(dev_ptr)) != 0:
                self._failed = True
                return False
            vt_dev = ctypes.cast(dev_ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            activate = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(_GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
            )(vt_dev[3])
            meter_ptr = ctypes.c_void_p()
            if activate(dev_ptr, ctypes.byref(iid_meter), 23, None, ctypes.byref(meter_ptr)) != 0:
                self._failed = True
                return False
            vt_meter = ctypes.cast(meter_ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            self._get_peak = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float)
            )(vt_meter[3])
            self._meter_ptr = meter_ptr
            return True
        except Exception:
            self._failed = True
            return False

    def peak(self) -> float:
        if self._get_peak is None and not self._init_com():
            return 0.0
        try:
            val = ctypes.c_float()
            if self._get_peak(self._meter_ptr, ctypes.byref(val)) == 0:
                return max(0.0, min(1.0, float(val.value)))
        except Exception:
            pass
        return 0.0


class HybridVadDetector:
    """Combines WebRTC VAD with Silero neural VAD when silero_vad.onnx is available to reject keyboard clicks."""

    def __init__(self, webrtc_vad, sample_rate: int = 16000, models_dir: Path | None = None):
        self.webrtc = webrtc_vad
        self.sample_rate = sample_rate
        self._silero_session = None
        self._state = None
        self._context = None
        self._buf = np.zeros(0, dtype=np.float32)
        self._last_prob = 0.0
        root = Path(os.environ.get('FULLAWAKE_AUDIO_MODELS_DIR') or models_dir or DEFAULT_MODELS_DIR)
        model_path = root / 'silero_vad.onnx'
        if sample_rate == 16000 and model_path.is_file():
            try:
                import onnxruntime as ort
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 1
                opts.inter_op_num_threads = 1
                self._silero_session = ort.InferenceSession(str(model_path), sess_options=opts, providers=['CPUExecutionProvider'])
                self.reset()
                log.info('Hybrid Silero neural VAD active (%s)', model_path.name)
            except Exception as exc:
                log.warning('Silero neural VAD init failed (%s); using WebRTC VAD only', type(exc).__name__)
                self._silero_session = None

    def reset(self):
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, 64), dtype=np.float32)
        self._buf = np.zeros(0, dtype=np.float32)
        self._last_prob = 0.0

    def is_speech(self, pcm: bytes, sample_rate: int) -> bool:
        if not self.webrtc.is_speech(pcm, sample_rate):
            if self._silero_session is not None:
                self._feed_silero(pcm)
            return False
        if self._silero_session is None or sample_rate != 16000:
            return True
        prob = self._feed_silero(pcm)
        return prob >= 0.42

    def _feed_silero(self, pcm: bytes) -> float:
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        self._buf = np.concatenate((self._buf, samples))
        while len(self._buf) >= 512:
            chunk = self._buf[:512].reshape(1, 512)
            self._buf = self._buf[512:]
            x = np.concatenate((self._context, chunk), axis=1)
            self._context = chunk[:, -64:]
            try:
                out, self._state = self._silero_session.run(
                    None,
                    {'input': x, 'state': self._state, 'sr': np.array(16000, dtype=np.int64)},
                )
                self._last_prob = float(np.asarray(out).flat[0])
            except Exception:
                self._silero_session = None
                return 1.0
        return self._last_prob


class AudioFrontEndProcessor:
    """GTCRN neural speech denoiser + context-aware 3D-Speaker CAM++ owner voiceprint verifier."""

    def __init__(self, models_dir: Path | None = None, voiceprint_file: Path | None = None):
        self.models_dir = Path(os.environ.get('FULLAWAKE_AUDIO_MODELS_DIR') or models_dir or DEFAULT_MODELS_DIR)
        self.voiceprint_file = Path(os.environ.get('FULLAWAKE_VOICEPRINT_FILE') or voiceprint_file or DEFAULT_VOICEPRINT_FILE)
        self._lock = Lock()
        self._denoiser = False
        self._extractor = False
        self._owner_embedding: np.ndarray | None = None
        self._owner_count: int = 0
        self._load_voiceprint()

    def _get_denoiser(self):
        if self._denoiser is False:
            model = self.models_dir / 'gtcrn_simple.onnx'
            if not model.is_file():
                self._denoiser = None
            else:
                try:
                    import sherpa_onnx as so
                    cfg = so.OfflineSpeechDenoiserConfig(
                        model=so.OfflineSpeechDenoiserModelConfig(
                            gtcrn=so.OfflineSpeechDenoiserGtcrnModelConfig(model=str(model)),
                            num_threads=2,
                        )
                    )
                    self._denoiser = so.OfflineSpeechDenoiser(cfg)
                    log.info('GTCRN neural speech denoiser loaded (%s)', model.name)
                except Exception as exc:
                    log.warning('GTCRN denoiser unavailable (%s)', type(exc).__name__)
                    self._denoiser = None
        return self._denoiser

    def _get_extractor(self):
        if self._extractor is False:
            model = self.models_dir / '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
            if not model.is_file():
                self._extractor = None
            else:
                try:
                    import sherpa_onnx as so
                    cfg = so.SpeakerEmbeddingExtractorConfig(model=str(model), num_threads=2)
                    self._extractor = so.SpeakerEmbeddingExtractor(cfg)
                    log.info('3D-Speaker CAM++ voiceprint extractor loaded (%s)', model.name)
                except Exception as exc:
                    log.warning('3D-Speaker extractor unavailable (%s)', type(exc).__name__)
                    self._extractor = None
        return self._extractor

    def _load_voiceprint(self):
        if not self.voiceprint_file.is_file():
            return
        try:
            data = json.loads(self.voiceprint_file.read_text(encoding='utf-8'))
            vec = np.asarray(data.get('embedding') or [], dtype=np.float32)
            norm = float(np.linalg.norm(vec))
            if vec.ndim == 1 and len(vec) >= 64 and norm > 0:
                self._owner_embedding = vec / norm
                self._owner_count = int(data.get('count') or 1)
        except Exception:
            pass

    def _save_voiceprint(self, vec: np.ndarray, count: int):
        try:
            self.voiceprint_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.voiceprint_file.with_suffix('.tmp')
            tmp.write_text(
                json.dumps({'embedding': [round(float(x), 6) for x in vec], 'count': count}) + '\n',
                encoding='utf-8',
            )
            tmp.replace(self.voiceprint_file)
        except Exception:
            pass

    def compute_embedding(self, samples: np.ndarray, sample_rate: int = 16000) -> np.ndarray | None:
        extractor = self._get_extractor()
        if extractor is None or len(samples) < int(sample_rate * 0.55):
            return None
        try:
            stream = extractor.create_stream()
            stream.accept_waveform(sample_rate, np.asarray(samples, dtype=np.float32))
            stream.input_finished()
            if not extractor.is_ready(stream):
                return None
            emb = np.asarray(extractor.compute(stream), dtype=np.float32)
            norm = float(np.linalg.norm(emb))
            return (emb / norm) if norm > 0 else None
        except Exception:
            return None

    def enroll_from_ptt(self, samples: np.ndarray, sample_rate: int = 16000) -> bool:
        """Automatically update owner voiceprint centroid from clean PTT utterances >= 1.2s (locked once count >= 5)."""
        if self._owner_count >= 5 and os.environ.get('FULLAWAKE_VOICEPRINT_UNLOCK', '') != '1':
            return False
        if len(samples) < int(sample_rate * 1.2):
            return False
        emb = self.compute_embedding(samples, sample_rate)
        if emb is None:
            return False
        with self._lock:
            if self._owner_embedding is None or len(self._owner_embedding) != len(emb):
                self._owner_embedding = emb
                self._owner_count = 1
            else:
                weight = min(self._owner_count, 7)
                merged = self._owner_embedding * weight + emb
                norm = float(np.linalg.norm(merged))
                if norm > 0:
                    self._owner_embedding = merged / norm
                    self._owner_count = min(self._owner_count + 1, 8)
            self._save_voiceprint(self._owner_embedding, self._owner_count)
        log.info('Updated owner voiceprint from PTT (samples=%d)', self._owner_count)
        return True

    def verify_barge_in_chunk(self, pcm_bytes: bytes, sample_rate: int = 16000) -> bool:
        """Verify a ~640ms candidate PCM16 chunk during active playback for early hard-cut promotion."""
        if not pcm_bytes:
            return False
        samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        if len(samples) < int(sample_rate * 0.55):
            return False
        cleaned, reject = self.process(samples, sample_rate, ptt=False, speaker_active=True)
        return cleaned is not None and not reject

    def process(self, samples: np.ndarray, sample_rate: int = 16000, *,
                ptt: bool = False, speaker_active: bool = False) -> tuple[np.ndarray | None, str]:
        """Run GTCRN speech denoising and context-aware voiceprint gating.

        Returns (cleaned_samples_or_None, reject_reason).
        """
        arr = np.asarray(samples, dtype=np.float32)
        if len(arr) == 0:
            return None, 'empty'

        raw_rms = float(np.sqrt(np.mean(np.square(arr))))
        denoiser = self._get_denoiser()
        if denoiser is not None:
            try:
                with self._lock:
                    cleaned = np.asarray(denoiser(arr, sample_rate).samples, dtype=np.float32)
                if len(cleaned) > 0:
                    arr = cleaned
            except Exception:
                pass

        clean_rms = float(np.sqrt(np.mean(np.square(arr))))
        # In Auto-VAD mode, if GTCRN stripped nearly all energy, the clip was pure non-vocal noise (e.g. keyboard clicks).
        if not ptt and denoiser is not None and (clean_rms < 0.0032 or (raw_rms > 0.01 and clean_rms / max(raw_rms, 1e-6) < 0.14)):
            return None, f'non_vocal_noise(raw={raw_rms:.4f},clean={clean_rms:.4f})'

        if ptt:
            if not speaker_active and clean_rms >= 0.012:
                self.enroll_from_ptt(arr, sample_rate)
            return arr, ''

        # Context-aware voiceprint check:
        # - When PC speakers are playing audio (video/music) and owner voiceprint is enrolled:
        #   require >= 0.6s and cosine similarity >= 0.38 so speaker bleed is blocked.
        # - When room is quiet: allow short replies (< 1.0s, e.g. "嗯/好") and check >= 1.0s with gentle threshold 0.28.
        if self._owner_embedding is not None:
            if speaker_active and len(arr) < int(sample_rate * 0.6):
                return None, 'short_speaker_bleed(<0.6s)'
            min_len = int(sample_rate * (0.6 if speaker_active else 1.0))
            if len(arr) >= min_len:
                emb = self.compute_embedding(arr, sample_rate)
                if emb is not None and len(emb) == len(self._owner_embedding):
                    sim = float(np.dot(self._owner_embedding, emb))
                    threshold = float(os.environ.get('FULLAWAKE_VOICEPRINT_THRESHOLD', '0.38' if speaker_active else '0.28'))
                    if sim < threshold:
                        return None, f'voiceprint_mismatch(sim={sim:.2f}<{threshold:.2f},speaker={speaker_active})'

        return arr, ''
