"""Bounded song jobs and a dedicated, killable CUDA inference worker."""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import contextmanager, redirect_stdout
from dataclasses import dataclass
import json
import logging
import os
import re
from pathlib import Path
import signal
import sys
import uuid

LOG = logging.getLogger(__name__)
CUDA = "CUDAExecutionProvider"
STAGE_TIMEOUT = 300
PROGRESS = {"queued": 0, "demucs": 25, "rvc_convert": 60, "mastering": 90, "completed": 100}
STAGES = {"separation": "demucs", "rvc": "rvc_convert", "mixing": "mastering"}
TERMINAL = {"completed", "failed", "cancelled"}
PROTOCOL = b"FULLAWAKE_SING "
# Launch through the base interpreter so a Windows venv redirector cannot create a child
# before the parent attaches the launcher to its Job Object.
BOOTSTRAP = (
    "import subprocess,sys; sys.stdin.buffer.raw.read(1); "
    "raise SystemExit(subprocess.call(sys.argv[1:]))"
)


class SingQueueFull(Exception):
    pass


class SingQueueUnavailable(Exception):
    pass


@dataclass
class SingJob:
    job_id: str
    state: str = "queued"
    progress: int = 0
    cancel_requested: bool = False
    result: dict | None = None
    error: str | None = None
    slice_progress: dict | None = None
    eta_seconds: int | None = None

    def snapshot(self):
        result = {"jobId": self.job_id, "status": self.state, "stage": self.state,
                  "progress": self.progress, "cancelRequested": self.cancel_requested}
        if self.result is not None:
            result["result"] = self.result
        if self.error is not None:
            result["error"] = self.error
        if self.slice_progress is not None and self.state == 'rvc_convert':
            result["sliceProgress"] = self.slice_progress
            if self.eta_seconds is not None:
                result['etaSeconds'] = self.eta_seconds
                result['etaStage'] = self.state
        return result


class SingJobQueue:
    """Serialize accepted jobs on the gateway event loop, with three waiting slots."""

    def __init__(self, render):
        self._render = render
        self._pending = deque()
        self._jobs = {}
        self._history = deque()
        self._active = None
        self._uploads = 0
        self._accepting = False

    def start(self):
        self._accepting = True

    def _check_capacity(self):
        if not self._accepting:
            raise SingQueueUnavailable
        if len(self._pending) + self._uploads + (self._active is not None) >= 4:
            raise SingQueueFull

    @contextmanager
    def upload_slot(self):
        self._check_capacity()
        self._uploads += 1
        try:
            yield
        finally:
            self._uploads -= 1

    def submit(self, audio: bytes, audio_format: str, pitch: int):
        self._check_capacity()
        job = SingJob(uuid.uuid4().hex)
        self._jobs[job.job_id] = job
        self._pending.append((job, audio, audio_format, pitch))
        self._dispatch()
        return self.get(job.job_id)

    def get(self, job_id):
        result = self._jobs[job_id].snapshot()
        if result['status'] == 'queued':
            result['queuePosition'] = next((position for position, (job, *_) in enumerate(self._pending, 1)
                                            if job.job_id == job_id), 0)
        return result

    def _dispatch(self):
        if self._active is not None or not self._pending or not self._accepting:
            return
        job, audio, audio_format, pitch = self._pending.popleft()
        task = asyncio.create_task(self._run(job, audio, audio_format, pitch))
        self._active = (job, task)
        task.add_done_callback(self._release_active)

    async def _run(self, job, audio, audio_format, pitch):
        clock = asyncio.get_running_loop().time
        first_slice = None

        def progress(stage, slices=None):
            nonlocal first_slice
            job.state = STAGES[stage]
            job.slice_progress = slices
            job.progress = PROGRESS[job.state] + (int(29 * slices['current'] / slices['total']) if slices else 0)
            if not slices or job.state != 'rvc_convert':
                first_slice = job.eta_seconds = None
                return
            current, total = slices['current'], slices['total']
            if first_slice is None or first_slice[1] != total:
                first_slice = (current, total, clock())
                job.eta_seconds = None
            elif current > first_slice[0]:
                elapsed_per_slice = (clock() - first_slice[2]) / (current - first_slice[0])
                job.eta_seconds = round(elapsed_per_slice * (total - current))

        try:
            job.result = await self._render(job.job_id, audio, audio_format, pitch, progress=progress)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            LOG.exception("Song job %s failed", job.job_id)
            code = str(error)
            job.error = code if code.startswith("VOICE_") else "VOICE_SINGING_FAILED"
            job.state = "failed"
        else:
            job.state = "completed"
            job.progress = PROGRESS["completed"]

    def _archive(self, job):
        self._history.append(job.job_id)
        if len(self._history) > 256:
            del self._jobs[self._history.popleft()]

    def _release_active(self, task):
        job, _ = self._active
        if task.cancelled():
            job.state = "cancelled"
        self._archive(job)
        self._active = None
        self._dispatch()

    async def cancel(self, job_id):
        job = self._jobs[job_id]
        if job.state in TERMINAL:
            return job.snapshot()
        if self._active is not None and self._active[0] is job:
            _, task = self._active
            if not job.cancel_requested:
                job.cancel_requested = True
                task.cancel()
            await asyncio.shield(asyncio.gather(task, return_exceptions=True))
        else:
            self._pending = deque(item for item in self._pending if item[0] is not job)
            job.cancel_requested = True
            job.state = "cancelled"
            self._archive(job)
        return job.snapshot()

    async def close(self):
        self._accepting = False
        for job, *_ in tuple(self._pending):
            await self.cancel(job.job_id)
        if self._active is not None:
            await self.cancel(self._active[0].job_id)


class SingProcess:
    """Own one subprocess tree, including Demucs' audio decoder children."""

    def __init__(self, process):
        self.process = process
        self._job = None

    @classmethod
    async def start(cls, command, *, env=None, stderr=asyncio.subprocess.PIPE):
        args = tuple(map(str, command))
        if os.name == "nt":
            args = (sys._base_executable, "-u", "-c", BOOTSTRAP, *args)
        spawn = asyncio.create_task(asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr,
            env=env, **({"start_new_session": True} if os.name != "nt" else {}),
        ))
        try:
            worker = cls(await asyncio.shield(spawn))
        except asyncio.CancelledError:
            worker = cls(await spawn)
            await worker.close()
            raise
        try:
            if os.name == "nt":
                worker._attach_job()
                worker.process.stdin.write(b"\n")
                await worker.process.stdin.drain()
        except BaseException:
            await worker.close()
            raise
        return worker

    def _attach_job(self):
        if hasattr(os, "add_dll_directory"):
            for p in sys.path:
                d = Path(p) / "pywin32_system32"
                if d.is_dir():
                    try:
                        os.add_dll_directory(str(d))
                    except Exception:
                        pass
        import win32api
        import win32con
        import win32job

        job = win32job.CreateJobObject(None, "")
        try:
            limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
            limits["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
            child = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE,
                                         False, self.process.pid)
            try:
                win32job.AssignProcessToJobObject(job, child)
            finally:
                child.Close()
        except BaseException:
            job.Close()
            raise
        self._job = job

    def terminate(self):
        if self._job is not None:
            import win32job

            win32job.TerminateJobObject(self._job, 1)
        elif os.name != "nt":
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif self.process.returncode is None:
            try:
                self.process.kill()
            except ProcessLookupError:
                pass

    async def close(self):
        self.terminate()
        try:
            await self.process.communicate()
        finally:
            await self.wait_tree()

    async def wait_tree(self):
        if self._job is None:
            return
        import win32job

        try:
            while win32job.QueryInformationJobObject(
                self._job, win32job.JobObjectBasicAccountingInformation,
            )["ActiveProcesses"]:
                await asyncio.sleep(0.01)
        finally:
            self._job.Close()
            self._job = None


async def run_sing_stage(command, env):
    worker = await SingProcess.start(command, env=env)
    io = asyncio.create_task(worker.process.communicate())
    try:
        stdout, stderr = await asyncio.wait_for(asyncio.shield(io), STAGE_TIMEOUT)
        return worker.process.returncode, stdout, stderr
    except TimeoutError as error:
        raise TimeoutError("VOICE_TIMEOUT") from error
    finally:
        worker.terminate()
        try:
            await io
        finally:
            await worker.wait_tree()


async def run_song_mastering(python, vocals, accompaniment, mp3, wav, env):
    # Keep FFmpeg in the managed job tree so cancelling the mastering stage
    # terminates both the Python worker and its encoder.
    script = Path(__file__).with_name("audio_mastering.py")
    code, stdout, stderr = await run_sing_stage([python, script, vocals, accompaniment, mp3, "--wav", wav], env)
    if code != 0 or not mp3.is_file() or not wav.is_file():
        LOG.error("Song mastering failed: %s", stderr.decode("utf-8", "replace")[-1200:])
        raise ValueError("VOICE_MASTERING_FAILED")
    return json.loads(stdout)


class ResidentSingProvider:
    """Keep three CUDA sessions alive in a single dedicated worker process."""

    def __init__(self, python, profile):
        self.python = Path(python or sys.executable)
        self.profile = Path(profile)
        self.worker = None
        self._warmup = None

    @property
    def ready(self):
        return self.worker is not None and self.worker.process.returncode is None

    def start(self):
        self._warmup = asyncio.create_task(self._prewarm())

    async def _prewarm(self):
        try:
            await self._ensure_worker()
        except Exception:
            LOG.exception("Song CUDA warm-up failed")

    async def _ensure_worker(self):
        if self.ready:
            return
        await self._stop_worker()
        if not self.profile.is_file():
            raise ValueError("VOICE_PROFILE_UNAVAILABLE")
        vendor = Path(__file__).resolve().parents[5] / "packages/rvc/vendor/phone"
        try:
            self.worker = await SingProcess.start(
                [self.python, "-u", __file__, vendor, self.profile.resolve().parent],
                stderr=None,
            )
            await asyncio.wait_for(self._receive(), STAGE_TIMEOUT)
        except TimeoutError as error:
            await self._stop_worker()
            raise TimeoutError("VOICE_RVC_WARMUP_TIMEOUT") from error
        except BaseException:
            await self._stop_worker()
            raise

    async def _receive(self, progress=None):
        while line := await self.worker.process.stdout.readline():
            if line.startswith(PROTOCOL):
                message = json.loads(line[len(PROTOCOL):])
                if "sliceProgress" in message:
                    if progress:
                        progress(message["sliceProgress"])
                    continue
                if message.get("executionProvider") == CUDA:
                    return
                raise ValueError(message.get("error", "VOICE_RVC_CUDA_UNAVAILABLE"))
        raise ValueError("VOICE_RVC_WORKER_EXITED")

    async def prepare(self):
        if self._warmup is not None:
            await asyncio.shield(self._warmup)
        await self._ensure_worker()

    async def convert(self, vocals, output, work, pitch, *, progress=None):
        await self.prepare()
        try:
            payload = json.dumps([str(vocals), str(output), str(work), pitch]).encode()
            self.worker.process.stdin.write(payload + b"\n")
            await self.worker.process.stdin.drain()
            await asyncio.wait_for(self._receive(progress), STAGE_TIMEOUT)
        except asyncio.CancelledError:
            await self._stop_worker()
            self.start()
            raise
        except TimeoutError as error:
            await self._stop_worker()
            raise TimeoutError("VOICE_TIMEOUT") from error
        except BaseException:
            await self._stop_worker()
            raise
        return CUDA

    async def _stop_worker(self):
        worker, self.worker = self.worker, None
        if worker is not None:
            await worker.close()

    async def close(self):
        if self._warmup is not None:
            self._warmup.cancel()
            await asyncio.gather(self._warmup, return_exceptions=True)
            self._warmup = None
        await self._stop_worker()


def _serve_worker(vendor, models_dir):
    protocol = sys.stdout.buffer

    def reply(**message):
        protocol.write(PROTOCOL + json.dumps(message).encode() + b"\n")
        protocol.flush()

    sys.path.insert(0, vendor)
    with redirect_stdout(sys.stderr):
        import numpy as np
        import rvc_onnx as rvc

        sessions = rvc.create_sessions(models_dir, [CUDA, "CPUExecutionProvider"])
        if any(session.get_providers()[0] != CUDA for session in sessions):
            reply(error="VOICE_RVC_CUDA_UNAVAILABLE")
            return
        for session in sessions:
            session.disable_fallback()
        probe = np.zeros(32_000, dtype=np.float32)
        phone = rvc.extract_hubert_features(sessions[0], probe)
        pitchf, pitch = rvc.extract_rmvpe_pitch(sessions[1], probe, len(phone))
        rvc.synthesize_segment(sessions[2], phone, pitch, pitchf)
        reply(executionProvider=CUDA)

        index = Path(models_dir) / "voice.mobile.index"
        def report_progress(_percent, message):
            match = re.search(r'chunk (\d+)/(\d+)', message, re.IGNORECASE)
            if match:
                current, total = map(int, match.groups())
                reply(sliceProgress={"current": current, "total": total})

        for line in sys.stdin.buffer:
            vocals, output, work, pitch = json.loads(line)
            try:
                result = rvc.convert_audio(
                    vocals, models_dir, output, work_dir=work, pitch_change=pitch,
                    index_path=str(index) if index.is_file() else "", index_ratio=0.3,
                    sessions=sessions, progress_callback=report_progress,
                )
                reply(executionProvider=result["executionProvider"])
            except Exception:
                LOG.exception("Resident CUDA conversion failed")
                reply(error="VOICE_RVC_CONVERSION_FAILED")


if __name__ == "__main__":
    _serve_worker(*sys.argv[1:])
