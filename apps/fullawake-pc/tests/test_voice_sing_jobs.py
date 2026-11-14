import asyncio
import json
import os
import sys
import time

from fastapi.testclient import TestClient

from fullawake.capabilities.voice_sing_provider import run_sing_stage
from fullawake.core.config import config
from fullawake.gateway.mcp_server import FullAwakeMCPGateway


JOBS = "/v1/voice/sing/jobs"
AUDIO = b"synthetic audio" * 10


def gateway_client(monkeypatch, tmp_path, render):
    monkeypatch.setattr(config, "voice_enabled", True)
    monkeypatch.setattr(config, "voice_profile", "")
    monkeypatch.setattr(config, "voice_work_dir", str(tmp_path))
    monkeypatch.setattr(config, "voice_clients", ["127.0.0.1"])
    monkeypatch.setattr(config, "auth_token", "test-singing")
    monkeypatch.setattr(FullAwakeMCPGateway, "_render_sing_job", staticmethod(render))
    return TestClient(FullAwakeMCPGateway().app, client=("127.0.0.1", 49152))


def submit(client):
    response = client.post(JOBS + "?format=wav&pitch=-4", content=AUDIO)
    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    return JOBS + "/" + response.json()["jobId"]


def poll(client, url, stage):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = client.get(url).json()
        if status["status"] == stage:
            return status
        if status["status"] in {"failed", "cancelled"}:
            raise AssertionError(status)
        time.sleep(0.01)
    raise AssertionError(f"Expected {stage}; last response was {status}")


def test_song_job_reports_pipeline_stages(monkeypatch, tmp_path):
    gates = [asyncio.Event() for _ in range(3)]

    async def render(job_id, audio, audio_format, pitch, *, progress):
        assert (audio, audio_format, pitch) == (AUDIO, "wav", -4)
        for stage, gate in zip(("separation", "rvc", "mixing"), gates):
            progress(stage)
            await gate.wait()
        return {"ok": True, "downloadUrl": f"/v1/voice/sing/download/{job_id}"}

    with gateway_client(monkeypatch, tmp_path, render) as client:
        url = submit(client)
        for stage, percent, gate in zip(("demucs", "rvc_convert", "mastering"), (25, 60, 90), gates):
            assert poll(client, url, stage)["progress"] == percent
            client.portal.call(gate.set)
        result = poll(client, url, "completed")
        assert result["progress"] == 100
        assert result["result"]["downloadUrl"].endswith(result["jobId"])
        assert client.post(url + "/cancel").json() == result
        assert client.get(JOBS + "/missing").status_code == 404


def test_one_active_plus_three_waiting_and_queued_cancel_reclaims_slot(monkeypatch, tmp_path):
    runs = []

    async def render(job_id, audio, audio_format, pitch, *, progress):
        runs.append(job_id)
        progress("separation")
        await asyncio.Future()

    with gateway_client(monkeypatch, tmp_path, render) as client:
        running = submit(client)
        poll(client, running, "demucs")
        queued = [submit(client) for _ in range(3)]
        assert all(client.get(url).json()["status"] == "queued" for url in queued)
        assert client.post(JOBS, content=AUDIO).status_code == 429
        assert client.post(queued[1] + "/cancel").json()["status"] == "cancelled"
        replacement = submit(client)
        assert client.post(running + "/cancel").json()["status"] == "cancelled"
        poll(client, queued[0], "demucs")
        assert client.get(replacement).json()["status"] == "queued"
        assert runs == [running.rsplit("/", 1)[-1], queued[0].rsplit("/", 1)[-1]]


def test_song_rvc_eta_requires_two_observed_slices(monkeypatch, tmp_path):
    next_slice = asyncio.Event()

    async def render(job_id, audio, audio_format, pitch, *, progress):
        progress('rvc', {'current': 1, 'total': 4})
        await next_slice.wait()
        progress('rvc', {'current': 2, 'total': 4})
        await asyncio.Future()

    with gateway_client(monkeypatch, tmp_path, render) as client:
        url = submit(client)
        assert 'etaSeconds' not in poll(client, url, 'rvc_convert')
        client.portal.call(next_slice.set)
        status = client.get(url).json()
        assert status['sliceProgress'] == {'current': 2, 'total': 4}
        assert status['etaSeconds'] >= 0
        assert status['etaStage'] == 'rvc_convert'
        assert 'etaSeconds' not in client.post(url + '/cancel').json()


def test_cancel_terminates_active_process_tree_before_reporting_cancelled(monkeypatch, tmp_path):
    ready = tmp_path / "ready.json"
    child_program = "import time; time.sleep(60)"
    program = (
        "import json,os,pathlib,subprocess,sys,time;"
        f"p=subprocess.Popen([sys.executable,'-c',{child_program!r}]);"
        "pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(),p.pid]));"
        "time.sleep(60)"
    )

    async def render(job_id, audio, audio_format, pitch, *, progress):
        progress("rvc")
        await run_sing_stage([sys.executable, "-c", program, ready], None)
        raise AssertionError("cancelled process returned normally")

    with gateway_client(monkeypatch, tmp_path, render) as client:
        url = submit(client)
        poll(client, url, "rvc_convert")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                pids = json.loads(ready.read_text())
                break
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.01)
        else:
            raise AssertionError("stage never spawned its child")

        if os.name == "nt":
            import win32api
            import win32con
            import win32event

            handles = [win32api.OpenProcess(win32con.SYNCHRONIZE, False, pid) for pid in pids]
            try:
                response = client.post(url + "/cancel")
                assert all(win32event.WaitForSingleObject(h, 1000) == win32event.WAIT_OBJECT_0 for h in handles)
            finally:
                for handle in handles:
                    handle.Close()
        else:
            response = client.post(url + "/cancel")
            from pathlib import Path

            for pid in pids:
                state = Path(f"/proc/{pid}/stat")
                assert not state.exists() or state.read_text().split(") ", 1)[1].startswith("Z ")
        assert response.json()["status"] == "cancelled"
        assert "result" not in response.json()
        assert client.post(url + "/cancel").json() == response.json()
