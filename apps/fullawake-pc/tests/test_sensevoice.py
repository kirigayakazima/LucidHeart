import io
import sys
import wave
from types import SimpleNamespace
import numpy as np
import pytest
from fullawake.capabilities.voice import VoiceCompute, AUDIO_UNCLEAR

def audio(silent=False):
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', ''))
        wav.writeframes((np.zeros(1600, dtype=np.int16) if silent else np.full(1600, 1000, dtype=np.int16)).tobytes())
    return out.getvalue()

def test_sensevoice_selection_clean_tags_and_silence(monkeypatch):
    monkeypatch.setenv('FULLAWAKE_ASR_BACKEND', 'auto')
    stream = SimpleNamespace(result=SimpleNamespace(text='<|zh|><|NEUTRAL|><|Speech|>你好 Claude<|woitn|>'), accept_waveform=lambda rate, samples: None)
    voice = VoiceCompute()
    voice.__dict__['sensevoice_model'] = SimpleNamespace(create_stream=lambda: stream, decode_stream=lambda _: None)
    assert voice.transcribe(audio())['text'] == '你好 Claude'
    assert voice.transcribe(audio(True)) == AUDIO_UNCLEAR
    stream.result.text = '<|zh|><|Speech|>'
    assert voice.transcribe(audio()) == AUDIO_UNCLEAR

@pytest.mark.parametrize('backend', ['auto', 'sensevoice', 'whisper'])
def test_missing_sensevoice_falls_back_to_local_whisper(tmp_path, monkeypatch, backend):
    monkeypatch.setenv('FULLAWAKE_ASR_BACKEND', backend)
    monkeypatch.setenv('FULLAWAKE_SENSEVOICE_MODEL_DIR', str(tmp_path))
    voice = VoiceCompute()
    voice.__dict__['asr_model'] = SimpleNamespace(transcribe=lambda *a, **kw: ([SimpleNamespace(text='回退成功')], SimpleNamespace(language='zh')))
    assert voice.transcribe(audio())['text'] == '回退成功'

def test_sensevoice_local_model_factory_contract(tmp_path, monkeypatch):
    (tmp_path / 'model.int8.onnx').touch()
    (tmp_path / 'tokens.txt').touch()
    monkeypatch.setenv('FULLAWAKE_SENSEVOICE_MODEL_DIR', str(tmp_path))
    calls = []
    def create(**options):
        calls.append(options)
        return object()
    monkeypatch.setitem(sys.modules, 'sherpa_onnx', SimpleNamespace(OfflineRecognizer=SimpleNamespace(from_sense_voice=create)))
    assert VoiceCompute().sensevoice_model is not None
    assert calls[0] == {'model': str(tmp_path / 'model.int8.onnx'), 'tokens': str(tmp_path / 'tokens.txt'),
        'language': 'zh', 'use_itn': True, 'num_threads': 4}
