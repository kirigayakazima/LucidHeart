import asyncio

from fullawake.capabilities.resident_cuda import CPU, CUDA, MIN_FREE_BYTES, ResidentCuda


def test_resident_idle_deadline_and_inference_mutex():
    async def scenario():
        now = 0
        released = []

        async def probe():
            return MIN_FREE_BYTES

        async def close():
            released.append(now)

        guard = ResidentCuda(close, probe=probe, clock=lambda: now)
        async with guard.acquire() as slot:
            assert slot.provider == CUDA
            now = 600
            assert not await guard.release_idle()
        now = 1199
        assert not await guard.release_idle()
        now = 1200
        assert await guard.release_idle()
        assert not await guard.release_idle()
        assert released == [1200]

    asyncio.run(scenario())


def test_low_vram_waits_fifteen_seconds_then_reports_cpu_reason():
    async def scenario():
        now = 0

        async def sleep(seconds):
            nonlocal now
            now += seconds

        async def probe():
            return MIN_FREE_BYTES - 1

        guard = ResidentCuda(sleep, probe=probe, clock=lambda: now, sleep=sleep)
        async with guard.acquire() as slot:
            assert (slot.provider, slot.reason, now) == (CPU, 'vram_wait_timeout', 15)
            assert not guard.gpu_inference_mutex.locked()

    asyncio.run(scenario())


def test_gpu_work_never_overlaps_after_memory_recovers():
    async def scenario():
        async def probe():
            return MIN_FREE_BYTES

        guard = ResidentCuda(asyncio.sleep, probe=probe)
        order = []

        async def use(task):
            async with guard.acquire():
                order.append((task, 'begin'))
                await asyncio.sleep(0)
                order.append((task, 'end'))

        await asyncio.gather(use(1), use(2))
        assert order == [(1, 'begin'), (1, 'end'), (2, 'begin'), (2, 'end')]

    asyncio.run(scenario())
