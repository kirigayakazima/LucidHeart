"""Cancellation-aware PC transport for the existing BreezeBlue voice."""

import asyncio
from urllib.parse import quote, urlsplit

import httpx

from fullawake.core.config import config

MAX_MP3_BYTES = 1024 * 1024


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
        return await asyncio.wait_for(self._request(url, payload), min(deadline_s, 8.0))

    async def _request(self, url, payload):
        client = self._get_client()
        try:
            async with client.stream('POST', url, params={'output_format': 'mp3'}, json=payload,
                                     headers={'xi-api-key': config.breeze_api_key, 'Accept': 'audio/mpeg'}) as reply:
                if not reply.is_success:
                    raise ValueError(f'BreezeBlue HTTP {reply.status_code}')
                data = bytearray()
                async for chunk in reply.aiter_bytes():
                    if len(data) + len(chunk) > MAX_MP3_BYTES:
                        raise ValueError('BreezeBlue audio exceeds size limit')
                    data.extend(chunk)
        except httpx.HTTPError:
            raise OSError('BreezeBlue transport failed') from None
        if not (data.startswith(b'ID3') or (len(data) >= 2 and data[0] == 0xff and data[1] & 0xe0 == 0xe0)):
            raise ValueError('BreezeBlue response is not MP3')
        return bytes(data)
