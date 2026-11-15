"""Serialize CUDA work and reclaim idle model allocations."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import os
import time

IDLE_RELEASE_SECS = 600
WAIT_SECONDS = 15
MIN_FREE_BYTES = 1_200_000_000
CUDA = 'CUDAExecutionProvider'
CPU = 'CPUExecutionProvider'


async def free_vram():
    """NVML-backed free memory for the default CUDA device on the gateway."""
    device = os.getenv('CUDA_VISIBLE_DEVICES', '0').split(',')[0].strip()
    if not device or device == '-1':
        return None
    try:
        process = await asyncio.create_subprocess_exec('nvidia-smi', f'--id={device}', '--query-gpu=memory.free',
            '--format=csv,noheader,nounits', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    except OSError:
        return None
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), 2)
        return int(stdout.strip()) * 1024**2 if process.returncode == 0 else None
    except (TimeoutError, ValueError):
        return None
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


@dataclass(frozen=True)
class ComputeAdmission:
    provider: str
    reason: str | None = None


class ResidentCuda:
    def __init__(self, release, *, probe=free_vram, clock=time.monotonic, sleep=asyncio.sleep):
        self.gpu_inference_mutex = asyncio.Lock()
        self._release = release
        self._probe = probe
        self._clock = clock
        self._sleep = sleep
        self._last_use = None

    @asynccontextmanager
    async def acquire(self):
        deadline = self._clock() + WAIT_SECONDS
        while True:
            remaining = deadline - self._clock()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(self.gpu_inference_mutex.acquire(), remaining)
            except TimeoutError:
                break
            try:
                available = await self._probe()
                if available is None:
                    yield ComputeAdmission(CPU, 'vram_unavailable')
                    return
                if available >= MIN_FREE_BYTES:
                    try:
                        yield ComputeAdmission(CUDA)
                    finally:
                        self._last_use = self._clock()
                    return
            finally:
                self.gpu_inference_mutex.release()
            await self._sleep(min(.5, max(0, deadline - self._clock())))
        yield ComputeAdmission(CPU, 'vram_wait_timeout')

    async def release_idle(self):
        if self.gpu_inference_mutex.locked():
            return False
        async with self.gpu_inference_mutex:
            if self._last_use is None or self._clock() - self._last_use < IDLE_RELEASE_SECS:
                return False
            await self._release()
            self._last_use = None
            return True

    async def watch_idle(self):
        while True:
            await self._sleep(1)
            await self.release_idle()
