"""Bound sentence generation by downstream demand."""

import asyncio
import re

SENTENCE_END = re.compile(r'([，。！？；\n,.!?;]+)')
MAX_BUFFERED = 3


async def stream_sentences(fragments, render):
    """Yield rendered sentences with at most three unconsumed sentences in flight."""
    queue = asyncio.Queue(MAX_BUFFERED)
    capacity = asyncio.Semaphore(MAX_BUFFERED)

    async def publish(text):
        if not text.strip() or SENTENCE_END.fullmatch(text.strip()):
            return
        await capacity.acquire()
        audio = await render(text)
        queue.put_nowait(audio)

    async def produce():
        tail = ''
        try:
            async for fragment in fragments:
                parts = SENTENCE_END.split(tail + fragment)
                for index in range(0, len(parts) - 1, 2):
                    await publish(parts[index] + parts[index + 1])
                tail = parts[-1]
                if len(tail) > 200:
                    raise ValueError('VOICE_TEXT_INVALID')
            await publish(tail)
        except Exception as error:
            await queue.put(error)
        await queue.put(None)

    producer = asyncio.create_task(produce())
    try:
        while (item := await queue.get()) is not None:
            if isinstance(item, Exception):
                raise item
            capacity.release()
            yield item
    finally:
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)
