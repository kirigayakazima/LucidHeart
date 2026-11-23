"""Cancellation-aware PC transport for the existing BreezeBlue voice."""

import asyncio
import logging
import time
from urllib.parse import quote, urlsplit

import httpx

from fullawake.core.config import config

MAX_MP3_BYTES = 1024 * 1024
_RETRY_429_DELAYS = (0.6, 1.2)


class _RateLimitedError(ValueError):
    def __init__(self, retry_after: float | None = None) -> None:
        super().__init__('BreezeBlue HTTP 429')
        self.retry_after = retry_after


class BreezeBlueAdapter:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._client_loop: asyncio.AbstractEventLoop | None = None

    def _get_client(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if self._client is None or self._client.is_closed or self._client_loop is not loop:
            self._client = httpx.AsyncClient(follow_redirects=False)
            self._client_loop = loop
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None
        self._client_loop = None

    async def synthesize(self, text: str, instructions: str | None = None, deadline_s: float = 8.0) -> bytes:
        if not text.strip() or len(text) > 120 or len(instructions or '') > 200 or not config.breeze_api_key:
            raise ValueError('Invalid BreezeBlue request or missing PC credential')
        endpoint = urlsplit(config.breeze_endpoint)
        if (endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password
                or endpoint.query or endpoint.fragment):
            raise ValueError('Invalid BreezeBlue HTTPS endpoint')
        url = f"{config.breeze_endpoint.rstrip('/')}/{quote(config.breeze_voice_id, safe='')}"
        payload = {'text': text, 'instructions': instructions or '', 'voice_settings': {'guidance_scale': 2}}
        deadline = time.monotonic() + min(deadline_s, 8.0)
        for attempt in range(len(_RETRY_429_DELAYS) + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError('BreezeBlue deadline exceeded')
            try:
                return await asyncio.wait_for(self._request(url, payload), min(remaining, 8.0))
            except _RateLimitedError as error:
                if attempt >= len(_RETRY_429_DELAYS):
                    raise
                delay = _RETRY_429_DELAYS[attempt]
                if error.retry_after is not None and 0.1 <= error.retry_after <= 4.0:
                    delay = max(delay, error.retry_after)
                if time.monotonic() + delay + 0.5 >= deadline:
                    raise
                logging.getLogger(__name__).warning(
                    'BreezeBlue HTTP 429, retrying attempt=%d in %.1fs', attempt + 1, delay
                )
                await asyncio.sleep(delay)

    async def _request(self, url, payload):
        client = self._get_client()
        try:
            async with client.stream('POST', url, params={'output_format': 'mp3'}, json=payload,
                                     headers={'xi-api-key': config.breeze_api_key, 'Accept': 'audio/mpeg'}) as reply:
                if reply.status_code == 429:
                    retry_raw = reply.headers.get('retry-after', '').strip()
                    try:
                        retry_after = float(retry_raw) if retry_raw else None
                    except ValueError:
                        retry_after = None
                    raise _RateLimitedError(retry_after)
                if not reply.is_success:
                    raise ValueError(f'BreezeBlue HTTP {reply.status_code}')
                data = bytearray()
                async for chunk in reply.aiter_bytes():
                    if len(data) + len(chunk) > MAX_MP3_BYTES:
                        raise ValueError('BreezeBlue audio exceeds size limit')
                    data.extend(chunk)
        except httpx.HTTPError as error:
            if self._client is client:
                self._client = self._client_loop = None
            try:
                await client.aclose()
            except httpx.HTTPError:
                pass
            status = getattr(getattr(error, 'response', None), 'status_code', None)
            logging.getLogger(__name__).warning('BreezeBlue transport failed type=%s status=%s', type(error).__name__, status)
            raise OSError(f'BreezeBlue transport failed ({type(error).__name__}, status={status})') from error
        if not (data.startswith(b'ID3') or (len(data) >= 2 and data[0] == 0xff and data[1] & 0xe0 == 0xe0)):
            raise ValueError('BreezeBlue response is not MP3')
        return bytes(data)
