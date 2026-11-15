import asyncio
from contextlib import aclosing

from fullawake.pipeline.stream_worker import stream_sentences


def test_sentence_stream_joins_fragments_and_bounds_unconsumed_output():
    async def scenario():
        rendered = []

        async def fragments():
            yield '一'
            yield '，二。三！！四？五；六\n末尾'

        async def render(sentence):
            rendered.append(sentence)
            return sentence

        async with aclosing(stream_sentences(fragments(), render)) as stream:
            assert await anext(stream) == '一，'
            await asyncio.sleep(0)
            assert rendered == ['一，', '二。', '三！！', '四？']
            assert [item async for item in stream] == ['二。', '三！！', '四？', '五；', '六\n', '末尾']

    asyncio.run(scenario())


def test_closing_output_cancels_inflight_synthesis():
    async def scenario():
        started = asyncio.Event()
        stopped = asyncio.Event()

        async def fragments():
            yield '一。二。'

        async def render(sentence):
            if sentence == '一。':
                return sentence
            started.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        async with aclosing(stream_sentences(fragments(), render)) as stream:
            assert await anext(stream) == '一。'
            await started.wait()
        assert stopped.is_set()

    asyncio.run(scenario())
