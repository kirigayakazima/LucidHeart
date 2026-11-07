import asyncio
import os
import time

from fastapi.testclient import TestClient

from fullawake.capabilities.voice import VoiceCompute
from fullawake.capabilities.voice_artifacts import DAY, VoiceArtifacts
from fullawake.core.config import config
from fullawake.gateway.mcp_server import gateway


def test_song_cache_reclaims_legacy_files_and_protects_active_downloads(tmp_path):
    cache = VoiceArtifacts(tmp_path, max_bytes=12)
    now = time.time()

    def put(task, name, days):
        file = cache.task_dir('singing', task) / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'1234')
        os.utime(file, (now - days * DAY,) * 2)
        return file

    expired = put('expired', 'song_expired.mp3', 8)
    playing = put('playing', 'song_playing.mp3', 5)
    oldest = put('oldest', 'song_oldest.mp3', 4)
    newest = put('newest', 'song_newest.mp3', 1)
    weights = put('oldest', 'model.onnx', 8)
    release = cache.pin(playing, 7 * DAY)
    assert release is not None
    assert cache.pin(expired, 7 * DAY) is None
    cache.sweep(now=now)
    assert not expired.exists() and not oldest.exists()
    assert playing.exists() and newest.exists() and weights.exists()
    release()
    assert not cache.readers


def test_gateway_singing_cleans_work_on_completion_or_cancel(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'voice_enabled', True)
    monkeypatch.setattr(config, 'voice_work_dir', str(tmp_path))
    voice = VoiceCompute()

    async def scenario():
        started = asyncio.Event()

        async def sing(task, audio, audio_format, pitch, work, destination, logger):
            chunks = work / '.rvc_work/chunks'
            chunks.mkdir(parents=True)
            (chunks / 'chunk_0000.wav').write_bytes(audio)
            (work / 'vocals.wav').write_bytes(audio)
            if task == 'cancel':
                started.set()
                await asyncio.Future()
            (destination / f'song_{task}.mp3').write_bytes(audio)

        monkeypatch.setattr(voice, '_sing', sing)
        await voice.process_singing_pipeline('success', b'x' * 100)
        assert [f.name for f in voice.artifacts.task_dir('singing', 'success').iterdir()] == ['song_success.mp3']
        job = asyncio.create_task(voice.process_singing_pipeline('cancel', b'x' * 100))
        await started.wait()
        job.cancel()
        await asyncio.gather(job, return_exceptions=True)
        assert not voice.artifacts.task_dir('singing', 'cancel').exists()
        assert not voice.artifacts.writers

    asyncio.run(scenario())


def test_singing_heartbeat_keeps_existing_json_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'voice_enabled', True)
    monkeypatch.setattr(config, 'voice_clients', ['testclient'])
    monkeypatch.setattr(config, 'voice_work_dir', str(tmp_path))

    async def sing(task, audio, audio_format, pitch):
        return {'ok': True, 'task': task}

    monkeypatch.setattr(gateway.voice, 'process_singing_pipeline', sing)
    with TestClient(gateway.app) as client:
        url = '/v1/voice/sing?task=demo'
        legacy = client.post(url, content=b'x' * 100)
        streamed = client.post(url + '&heartbeat=true', content=b'x' * 100)
        assert legacy.status_code == streamed.status_code == 200
        assert streamed.content.startswith(b'\n')
        assert streamed.json() == legacy.json() == {'ok': True, 'task': 'demo'}
