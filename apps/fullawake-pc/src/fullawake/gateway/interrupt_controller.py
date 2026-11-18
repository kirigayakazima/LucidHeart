"""The PC side of lucid.voice/1. All lease state lives on the gateway event loop."""

import asyncio
import base64
from contextlib import aclosing
from dataclasses import dataclass, field
import hmac
import inspect
from io import BytesIO
import json
import logging
from pathlib import Path
import time
from typing import Literal
from uuid import uuid4
import wave

from anyio import CancelScope
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, field_validator

from fullawake import __version__
from fullawake.capabilities.breezeblue_adapter import BreezeBlueAdapter
from fullawake.capabilities.desktop_vision.game_watcher import EVENT_SECONDS, GameEvent, GameWatcher, WatchSession, load_profiles
from fullawake.capabilities.desktop_vision.screen import active_game_window
from fullawake.capabilities.desktop_vision.watch import MAX_WAV_BYTES, native_loopback, wav_duration
from fullawake.capabilities.voice import ASSETS, DEFAULTS
from fullawake.capabilities.voice_vad import VoiceVadListener
from fullawake.core.config import config
from fullawake.core.session import is_desktop_locked
from fullawake.pipeline.stream_worker import stream_sentences

log = logging.getLogger(__name__)
PROTOCOL = 'lucid.voice/1'
INITIAL_EPOCH = 100
REVOKED_TTL = 60
RENDERER_ACK_TIMEOUT = 0.2
MAX_EPOCH = 2**53 - 1
MAX_AUDIO_BASE64 = 4 * ((MAX_WAV_BYTES + 2) // 3)


class StrictFrame(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Frame(StrictFrame):
    protocol: Literal['lucid.voice/1']
    type: Literal['session.handshake', 'audio.prepare', 'audio.speak', 'audio.play', 'audio.cancel', 'audio.interrupt_ack', 'pet.text', 'game.watch', 'voice.call']
    sessionId: str = Field(min_length=1, max_length=140)
    connectionId: str = Field(min_length=1, max_length=80)
    commandSeq: int = Field(ge=1, le=MAX_EPOCH)
    payload: dict


class Handshake(StrictFrame):
    clientVersion: str = Field(min_length=1, max_length=40)
    heartVersion: str = Field(min_length=1, max_length=40)
    device: str = Field(min_length=1, max_length=80)
    capture: bool = False


class Utterance(StrictFrame):
    epoch: int = Field(ge=INITIAL_EPOCH, le=MAX_EPOCH)
    utteranceId: str = Field(min_length=1, max_length=80)


class Prepare(Utterance):
    watchSessionId: str | None = Field(default=None, min_length=1, max_length=140)
    cueId: str | None = Field(default=None, min_length=1, max_length=40)
    gameProcess: str | None = Field(default=None, min_length=1, max_length=128)
    gameEventId: str | None = Field(default=None, min_length=32, max_length=32)


class GameWatchControl(StrictFrame):
    requestId: str = Field(min_length=1, max_length=64)
    action: Literal['start', 'stop']


class VoiceCallControl(StrictFrame):
    requestId: str = Field(min_length=1, max_length=64)
    active: bool


class PetText(Utterance):
    text: str = Field(min_length=1, max_length=120)
    intent: Literal['nod', 'smile', 'wave', 'shock']


class Speak(Utterance):
    text: str = Field(min_length=1, max_length=200)
    voiceProfile: Literal['feiyu-rvc-v1', 'breezeblue'] = 'feiyu-rvc-v1'
    pitchShift: int = 0
    instructions: str | None = Field(default=None, max_length=200)
    deadlineMs: int = Field(gt=0, le=30_000)

    @field_validator('pitchShift')
    @classmethod
    def approved_pitch(cls, value):
        if value not in (0, -4):
            raise ValueError('Unsupported pitch')
        return value


class InterruptAck(StrictFrame):
    abortedEpoch: int = Field(ge=INITIAL_EPOCH, le=MAX_EPOCH)
    currentEpoch: int = Field(gt=INITIAL_EPOCH, le=MAX_EPOCH)


class PlayAudio(Utterance):
    text: str = Field(min_length=1, max_length=40)
    audioBase64: str = Field(min_length=1, max_length=MAX_AUDIO_BASE64)
    deadlineMs: int = Field(gt=0, le=15_000)


async def game_audio_wav(encoded):
    """Accept bounded RVC WAV or BreezeBlue MP3, then use the existing WAV renderer."""
    audio = encoded if isinstance(encoded, bytes) else base64.b64decode(encoded, validate=True)
    if len(audio) > MAX_WAV_BYTES:
        raise ValueError('Audio too large')
    if audio.startswith(b'RIFF'):
        return base64.b64encode(audio).decode('ascii') if isinstance(encoded, bytes) else encoded
    if not (audio.startswith(b'ID3') or (len(audio) >= 2 and audio[0] == 0xff and audio[1] & 0xe0 == 0xe0)):
        raise ValueError('Unsupported audio format')
    process = await asyncio.create_subprocess_exec(
        'ffmpeg', '-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'mp3', '-i', 'pipe:0',
        '-vn', '-sn', '-dn', '-t', '10.1', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        pcm, _ = await asyncio.wait_for(process.communicate(audio), 4)
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.communicate()
    if process.returncode or not pcm or len(pcm) > 480_000 or len(pcm) % 2:
        raise ValueError('Invalid game audio')
    output = BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
        wav.writeframes(pcm)
    return base64.b64encode(output.getvalue()).decode('ascii')


@dataclass(eq=False)
class Lease:
    command: Utterance
    deadline: float
    renderer_id: str = field(default_factory=lambda: uuid4().hex)
    cue: Prepare | None = None
    timeline: str | None = None
    receipt: asyncio.Future | None = None
    worker: asyncio.Task | None = None
    streaming: bool = False
    elapsed_audio_ms: int = 0
    game: tuple | None = None
    game_session: WatchSession | None = None
    game_event: GameEvent | None = None


@dataclass(eq=False)
class Peer:
    session: str
    connection: str
    turn_lifecycle: bool = False
    capture_enabled: bool = False
    call_active: bool | None = None
    received_seq: int = 1
    sent_seq: int = 0
    highest_epoch: int = INITIAL_EPOCH - 1
    epoch_floor: int = INITIAL_EPOCH
    last_interrupted: int | None = None
    revoked_epochs: dict = field(default_factory=dict)
    speaking: bool = False
    lease: Lease | None = None
    speech_generation: int = 0
    game_offer: tuple[str, int] | None = None
    jobs: set = field(default_factory=set)
    outbound: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=16))

    def send(self, kind, /, **payload):
        self.sent_seq += 1
        self.outbound.put_nowait({'protocol': PROTOCOL, 'type': kind, 'sessionId': self.session,
                                 'connectionId': self.connection, 'commandSeq': self.sent_seq, 'payload': payload})

    def prune_revoked(self, now):
        for epoch, expires in tuple(self.revoked_epochs.items()):
            if now >= expires:
                del self.revoked_epochs[epoch]


class InterruptController:
    def __init__(self, watch_cap, voice, *, on_call_change=None):
        self.watch = watch_cap
        self.voice = voice
        self.on_call_change = on_call_change
        self._capture_epoch = 0
        self.breeze = BreezeBlueAdapter()
        try:
            profiles = load_profiles(config.game_watch_profiles)
        except (OSError, ValueError, TypeError, KeyError):
            log.warning('Game watch profiles could not be loaded')
            profiles = {}
        self.game_watch = GameWatcher(profiles)
        self.peer = None
        self.vad = None

    def on_speech_start(self, peer):
        if self.peer is not peer:
            return
        if self.vad and hasattr(self.vad, 'set_playback_active'):
            self.vad.set_playback_active(False)
        peer.speaking = True
        peer.speech_generation += 1
        lease = peer.lease
        if not lease:
            self.watch.interrupt_media()
            return
        if self.watch.bridge_output is None:
            self.watch.interrupt_media()
        if not lease.streaming and lease.receipt and lease.receipt.done() and lease.receipt.result() in ('played', 'text_delivered'):
            self._settle(peer, lease, self._outcome(lease))
            return
        # Revoke before posting to either socket. A completion running on this
        # same loop can no longer publish audio for this lease.
        peer.lease = None
        epoch = lease.command.epoch
        now = time.monotonic()
        peer.prune_revoked(now)
        peer.revoked_epochs[epoch] = now + REVOKED_TTL
        peer.last_interrupted = epoch
        receipt = self.watch.cancel_output(bridge_utterance=lease.renderer_id, interrupt_id=uuid4().hex)
        if peer.turn_lifecycle and lease.worker:
            lease.worker.cancel()
        self._spawn(peer, self._report_interrupt(peer, lease, receipt))

    def on_speech_end(self, peer):
        if self.peer is peer:
            peer.speaking = False

    async def _transcribe_utterance(self, peer, wav_bytes: bytes):
        log.info('VAD utterance (%d bytes), call_active=%s', len(wav_bytes), peer.call_active)
        if self.peer is not peer or not peer.call_active or not peer.capture_enabled:
            return
        try:
            result = await asyncio.to_thread(self.voice.transcribe, wav_bytes)
            text = str((result or {}).get('text') or '').strip() if result and result.get('ok') else ''
            if text and self.peer is peer and peer.call_active:
                self._capture_epoch += 1
                epoch = self._capture_epoch
                turn_id = uuid4().hex
                log.info('PC mic transcript (%d chars): %s', len(text), text[:60])
                peer.send('audio.capture', turnId=turn_id, audio_epoch=epoch)
                peer.send('audio.transcript', turnId=turn_id, audio_epoch=epoch,
                          text=text[:1500], is_final=True)
        except Exception as error:
            log.warning('PC mic transcription failed: %s', error)

    def game_candidate(self, session, event):
        peer = session.owner
        remaining = min(2500, int((event.timestamp + EVENT_SECONDS - time.monotonic()) * 1000))
        if (self.peer is peer and not peer.speaking and peer.lease is None and not peer.outbound.full()
                and remaining > 0 and config.breeze_api_key and self.watch.player is not None):
            peer.game_offer = (event.id, peer.speech_generation)
            peer.send('game.watch.event', watchId=session.id, eventId=event.id, kind=event.type,
                      outcome=event.outcome, remainingMs=remaining)

    def game_ended(self, session, reason):
        peer = session.owner
        peer.game_offer = None
        if peer.lease is not None and peer.lease.game_session is session:
            self._settle(peer, peer.lease, 'discarded')
        if self.peer is peer and not peer.outbound.full():
            peer.send('game.watch.ended', watchId=session.id, reason=reason)

    async def _control_game(self, peer, command):
        if command.action == 'start':
            available = peer.turn_lifecycle and config.breeze_api_key and self.watch.player is not None
            session = await self.game_watch.start(peer) if available else None
            peer.send('game.watch.status', requestId=command.requestId,
                      status='started' if session else 'unavailable', watchId=session.id if session else None)
        else:
            session = self.game_watch.stop(peer)
            if session:
                self.game_ended(session, 'stopped')
            peer.send('game.watch.status', requestId=command.requestId, status='stopped', watchId=None)

    async def _report_interrupt(self, peer, lease, receipt):
        elapsed = None
        if receipt is not None:
            try:
                elapsed = await asyncio.wait_for(receipt, RENDERER_ACK_TIMEOUT)
            except asyncio.TimeoutError:
                pass
        if self.peer is peer:
            try:
                peer.send('audio.interrupt', abortedEpoch=lease.command.epoch,
                          utteranceId=lease.command.utteranceId, reason='near_end_speech',
                          localAudioStopped=elapsed is not None,
                          elapsedAudioMs=min(60_000, lease.elapsed_audio_ms + (elapsed or 0)))
            except asyncio.QueueFull:
                # A phone that cannot drain notices must reconnect before
                # submitting more work. Local revocation has already happened.
                peer.epoch_floor = MAX_EPOCH + 1
                log.warning('Voice bridge interrupt backlog full')

    @staticmethod
    def _spawn(peer, coroutine):
        task = asyncio.create_task(coroutine)
        peer.jobs.add(task)
        task.add_done_callback(peer.jobs.discard)
        return task

    def _can_render(self, peer, lease):
        return (self.peer is peer and peer.lease is lease and lease.command.epoch not in peer.revoked_epochs
                and lease.command.epoch >= peer.epoch_floor
                and time.monotonic() < lease.deadline and self.watch.player is not None
                and not is_desktop_locked() and self._fresh_cue(lease))

    def _fresh_cue(self, lease):
        return (not lease.cue or not lease.cue.cueId or (self.watch.timeline == lease.timeline and
                self.watch.valid_cue(lease.cue.watchSessionId, lease.cue.cueId, time.monotonic())))

    def _settle(self, peer, lease, status):
        if peer.lease is not lease:
            return
        if self.vad and hasattr(self.vad, 'set_playback_active'):
            self.vad.set_playback_active(False)
        peer.lease = None
        self.watch.cancel_output(bridge_utterance=lease.renderer_id)
        if peer.turn_lifecycle and lease.worker and lease.worker is not asyncio.current_task():
            lease.worker.cancel()
        self._result(peer, lease.command, status)

    @staticmethod
    def _result(peer, command, status):
        if peer.turn_lifecycle:
            try:
                peer.send('audio.result', epoch=command.epoch, utteranceId=command.utteranceId, status=status)
            except asyncio.QueueFull:
                peer.epoch_floor = MAX_EPOCH + 1

    @staticmethod
    def _outcome(lease):
        expected = 'played' if isinstance(lease.command, (Speak, PlayAudio)) else 'text_delivered'
        return expected if lease.receipt.result() == expected else 'discarded'

    async def _expire_prepared(self, peer, lease):
        while peer.lease is lease and isinstance(lease.command, Prepare):
            if time.monotonic() >= lease.deadline or not self.watch.player or not self._fresh_cue(lease):
                self._settle(peer, lease, 'discarded')
                return
            await asyncio.sleep(0.1)

    async def _guard_game(self, peer, lease):
        while peer.lease is lease:
            try:
                game = await asyncio.to_thread(active_game_window)
            except (OSError, RuntimeError, ValueError):
                game = None
            if (game != lease.game or (lease.game_event is not None and
                    self.game_watch.event(peer, lease.game_event.id)[1] is not lease.game_event)):
                self._settle(peer, lease, 'discarded')
                return
            await asyncio.sleep(0.1)

    async def _stream_to_renderer(self, peer, lease, request, cancelled):
        async def fragments():
            yield request['text']

        async def render(sentence):
            result = await self.voice.synthesize({**request, 'text': sentence}, disconnected=cancelled)
            return sentence, result['audioBase64']

        lease.streaming = True
        previous = None
        async with aclosing(stream_sentences(fragments(), render)) as stream:
            async for sentence, audio in stream:
                if await cancelled():
                    return 'discarded'
                renderer_id = uuid4().hex
                duration = wav_duration(audio)
                receipt = self.watch.play_bridge(renderer_id, sentence, audio, duration, retain=True, previous=previous)
                if receipt is None:
                    return 'discarded'
                if previous is None:
                    lease.deadline = time.monotonic() + 30
                previous = lease.renderer_id = renderer_id
                lease.receipt = receipt
                end = time.monotonic() + duration / 1000 + 2
                while not receipt.done() and not await cancelled() and time.monotonic() < end:
                    await asyncio.wait({receipt}, timeout=.1)
                if not receipt.done() or receipt.result() != 'played':
                    return 'discarded'
                lease.elapsed_audio_ms += duration
        return 'played' if previous else 'discarded'

    async def _play(self, peer, lease):
        command = lease.command
        outcome = 'discarded'
        try:
            async def cancelled():
                return not self._can_render(peer, lease)

            if await cancelled():
                return
            audio, duration, intent = None, 4000, 'talk'
            if isinstance(command, Speak) and command.voiceProfile == 'breezeblue':
                started = time.monotonic()
                async def render_direct():
                    mp3 = await self.breeze.synthesize(command.text, command.instructions,
                                                       deadline_s=min(8, lease.deadline - started))
                    if not self._can_render(peer, lease):
                        return None
                    wav = await game_audio_wav(mp3)
                    if lease.game_event and not await self.game_watch.revalidate(lease.game_session, lease.game_event):
                        return None
                    return wav

                audio = await asyncio.wait_for(render_direct(), lease.deadline - started)
                if audio is None:
                    return
                duration = wav_duration(audio)
                log.info('BreezeBlue audio ready in %.0f ms', (time.monotonic() - started) * 1000)
            elif isinstance(command, Speak):
                profile = json.loads(Path(config.voice_profile).read_text(encoding='utf-8-sig'))
                request = {'text': command.text, 'voice': {
                    'id': command.voiceProfile,
                    'assets': {name: profile['assets'][name]['sha256'] for name in ASSETS},
                    'settings': {**DEFAULTS, **{key: profile[key] for key in DEFAULTS if key in profile},
                                 'pitch': command.pitchShift},
                }}
                if peer.capture_enabled:
                    outcome = await self._stream_to_renderer(peer, lease, request, cancelled)
                    return
                result = await self.voice.synthesize(request, disconnected=cancelled)
                if not self._can_render(peer, lease):
                    return
                audio = result['audioBase64']
                duration = wav_duration(audio)
            elif isinstance(command, PlayAudio):
                audio = await game_audio_wav(command.audioBase64)
                duration = wav_duration(audio)
            else:
                intent = command.intent
            if lease.game is not None and await asyncio.to_thread(active_game_window) != lease.game:
                return
            if not self._can_render(peer, lease):
                return
            lease.receipt = self.watch.play_bridge(lease.renderer_id, command.text, audio, duration, intent)
            if not lease.receipt:
                return
            if lease.game_event is not None:
                log.info('Game watch %s event to renderer in %.0f ms', lease.game_event.type,
                         (time.monotonic() - lease.game_event.timestamp) * 1000)
            if audio is not None and self.vad and hasattr(self.vad, 'set_playback_active'):
                self.vad.set_playback_active(True)
            end = time.monotonic() + (duration / 1000 + 2 if audio is not None else 2)
            while (not lease.receipt.done() and time.monotonic() < end and not is_desktop_locked() and
                   (not lease.timeline or (self.watch.timeline == lease.timeline and self.watch.playing(time.monotonic())))):
                await asyncio.sleep(0.1)
            if lease.receipt.done():
                outcome = self._outcome(lease)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, wave.Error, EOFError, asyncio.TimeoutError) as error:
            log.info('Voice bridge speech discarded (%s)', type(error).__name__)
        finally:
            if self.vad and hasattr(self.vad, 'set_playback_active'):
                self.vad.set_playback_active(False)
            self._settle(peer, lease, outcome)

    async def _receive(self, socket, peer):
        while True:
            frame = await self._read(socket, allow_audio=True)
            if (frame.sessionId != peer.session or frame.connectionId != peer.connection
                    or frame.type == 'session.handshake'):
                raise ValueError('Wrong voice connection')
            if frame.commandSeq <= peer.received_seq:
                continue
            peer.received_seq = frame.commandSeq
            if frame.type == 'voice.call':
                command = VoiceCallControl.model_validate(frame.payload)
                if not peer.turn_lifecycle or not peer.capture_enabled:
                    raise ValueError('Capture-capable peer required')
                peer.call_active = command.active
                log.info('Voice call state changed: active=%s', peer.call_active)
                if self.on_call_change is not None:
                    self.on_call_change()
                if not command.active:
                    self.on_speech_start(peer)
                    self.on_speech_end(peer)
                peer.send('voice.call.status', requestId=command.requestId, active=peer.call_active)
                continue
            if frame.type == 'game.watch':
                await self._control_game(peer, GameWatchControl.model_validate(frame.payload))
                continue
            if frame.type == 'audio.interrupt_ack':
                ack = InterruptAck.model_validate(frame.payload)
                if ack.abortedEpoch == peer.last_interrupted and ack.currentEpoch > ack.abortedEpoch:
                    peer.epoch_floor = max(peer.epoch_floor, ack.currentEpoch)
                    peer.last_interrupted = None
                    if peer.lease and peer.lease.command.epoch < peer.epoch_floor:
                        self._settle(peer, peer.lease, 'discarded')
                continue
            models = {'audio.prepare': Prepare, 'audio.speak': Speak, 'audio.play': PlayAudio,
                      'audio.cancel': Utterance, 'pet.text': PetText}
            command = models[frame.type].model_validate(frame.payload)
            now = time.monotonic()
            peer.prune_revoked(now)
            lease = peer.lease
            matches = lease and (lease.command.epoch, lease.command.utteranceId) == (command.epoch, command.utteranceId)
            if frame.type == 'audio.cancel':
                if matches:
                    self._settle(peer, lease, 'cancelled')
                continue
            if matches and isinstance(lease.command, Prepare) and isinstance(command, (Speak, PlayAudio, PetText)):
                direct = isinstance(command, Speak) and command.voiceProfile == 'breezeblue'
                if (now >= lease.deadline or not self._fresh_cue(lease)
                        or (lease.game_event is not None and (not direct or len(command.text) > 25))
                        or (direct and (not config.breeze_api_key or len(command.text) > 120))):
                    self._settle(peer, lease, 'discarded')
                else:
                    lease.command = command
                    seconds = command.deadlineMs / 1000 if isinstance(command, (Speak, PlayAudio)) else 2
                    lease.deadline = min(lease.deadline, now + seconds)
                    lease.worker = self._spawn(peer, self._play(peer, lease))
                continue
            if (command.epoch < peer.epoch_floor or command.epoch <= peer.highest_epoch
                    or command.epoch in peer.revoked_epochs):
                continue
            peer.highest_epoch = command.epoch
            if (peer.speaking or peer.lease or isinstance(command, (PetText, PlayAudio))
                    or (isinstance(command, Speak) and command.voiceProfile == 'breezeblue')):
                self._result(peer, command, 'discarded')
                continue
            if isinstance(command, Prepare):
                lease = Lease(command, now + 25, cue=command, timeline=self.watch.timeline if command.cueId else None)
                if (not peer.turn_lifecycle or not self.watch.player or is_desktop_locked() or
                        bool(command.cueId) != bool(command.watchSessionId) or not self._fresh_cue(lease)):
                    self._result(peer, command, 'discarded')
                    continue
                if command.gameProcess is not None:
                    game = await asyncio.to_thread(active_game_window)
                    if not game or game[2].casefold() != command.gameProcess.casefold():
                        self._result(peer, command, 'discarded')
                        continue
                    lease.game = game
                if command.gameEventId is not None:
                    session, event = self.game_watch.event(peer, command.gameEventId)
                    offer = (command.gameEventId, peer.speech_generation)
                    if (not config.breeze_api_key or command.cueId or command.gameProcess or not session or session.claimed
                            or peer.game_offer != offer or now >= event.timestamp + EVENT_SECONDS
                            or not await self.game_watch.revalidate(session, event) or peer.speech_generation != offer[1]):
                        self._result(peer, command, 'discarded')
                        continue
                    session.claimed = True
                    lease.game, lease.game_session, lease.game_event = session.game, session, event
                    lease.deadline = event.timestamp + EVENT_SECONDS
                peer.lease = lease
                peer.send('audio.prepared', epoch=command.epoch, utteranceId=command.utteranceId)
                self._spawn(peer, self._expire_prepared(peer, lease))
                if lease.game is not None:
                    self._spawn(peer, self._guard_game(peer, lease))
            else:
                lease = peer.lease = Lease(command, now + command.deadlineMs / 1000)
                lease.worker = self._spawn(peer, self._play(peer, lease))

    @staticmethod
    async def _read(socket, *, allow_audio=False):
        message = await socket.receive()
        if message['type'] == 'websocket.disconnect':
            raise WebSocketDisconnect(message['code'])
        raw = message.get('text')
        if raw is None or len(raw) > (MAX_AUDIO_BASE64 + 4096 if allow_audio else 4096):
            raise ValueError('Invalid voice frame size or encoding')
        frame = Frame.model_validate_json(raw)
        if len(raw) > 4096 and frame.type != 'audio.play':
            raise ValueError('Invalid voice control frame size')
        return frame

    def mount(self, app):
        @app.websocket('/ws/bridge')
        async def bridge(socket: WebSocket):
            token = config.auth_token.strip()
            authorization = socket.headers.get('authorization', '').split()
            if (not config.epoch_revocation_enabled or not self.watch.enabled or not native_loopback(socket)
                    or not token or len(authorization) != 2 or authorization[0].lower() != 'bearer'
                    or not hmac.compare_digest(authorization[1].encode(), token.encode())):
                await socket.close(code=1008)
                return
            await socket.accept()
            peer = vad = None
            readers = []
            try:
                first = await asyncio.wait_for(self._read(socket), 5)
                if first.type != 'session.handshake' or first.commandSeq != 1 or self.peer is not None:
                    raise ValueError('Voice bridge requires an exclusive handshake')
                handshake = Handshake.model_validate(first.payload)
                version = handshake.clientVersion.split('.')
                lifecycle = len(version) == 3 and all(part.isascii() and part.isdecimal() for part in version)
                lifecycle = lifecycle and tuple(map(int, version)) >= (0, 2, 6)
                peer = self.peer = Peer(first.sessionId, first.connectionId, turn_lifecycle=lifecycle,
                                        capture_enabled=handshake.capture)
                if lifecycle and tuple(map(int, version)) >= (0, 2, 10):
                    peer.call_active = False
                supported = False
                if config.voice_vad_enabled:
                    loop = asyncio.get_running_loop()
                    mode = getattr(config, 'vad_device_mode', 'headphone')
                    vad_kwargs = {'device': config.voice_vad_device}
                    try:
                        sig = inspect.signature(VoiceVadListener.__init__)
                        if 'device_mode' in sig.parameters or any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()):
                            vad_kwargs['device_mode'] = mode
                        if 'ptt_key' in sig.parameters or any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()):
                            vad_kwargs['ptt_key'] = getattr(config, 'ptt_key', '')
                        if handshake.capture and ('on_utterance' in sig.parameters or any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values())):
                            vad_kwargs['on_utterance'] = lambda wav: loop.call_soon_threadsafe(
                                self._spawn, peer, self._transcribe_utterance(peer, wav)
                            )
                    except (ValueError, TypeError):
                        pass
                    vad = VoiceVadListener(lambda: loop.call_soon_threadsafe(self.on_speech_start, peer),
                                           lambda: loop.call_soon_threadsafe(self.on_speech_end, peer),
                                           **vad_kwargs)
                    if hasattr(vad, 'reference_provider'):
                        vad.reference_provider = self.watch.microphone_reference
                    supported = await asyncio.to_thread(vad.start)
                    self.vad = vad
                peer.send('session.handshake_ack', status='ready', gatewayVersion=__version__,
                          initialEpoch=INITIAL_EPOCH, vadSupported=supported, **({'turnLifecycle': True} if lifecycle else {}),
                          **({'gameVoice': bool(config.breeze_api_key)} if lifecycle and tuple(map(int, version)) >= (0, 2, 9) else {}))

                async def send():
                    while True:
                        await socket.send_json(await peer.outbound.get())

                readers = [asyncio.create_task(self._receive(socket, peer)), asyncio.create_task(send())]
                done, _ = await asyncio.wait(readers, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            except (WebSocketDisconnect, OSError):
                pass
            except (ValueError, asyncio.TimeoutError):
                await socket.close(code=1008)
            finally:
                # ASGI disconnect may cancel the handler while a worker is
                # still holding the microphone or a renderer lease.
                with CancelScope(shield=True):
                    for task in readers:
                        task.cancel()
                    if peer is not None:
                        self.game_watch.stop(peer)
                        lease, peer.lease = peer.lease, None
                        if lease is not None:
                            self.watch.cancel_output(bridge_utterance=lease.renderer_id)
                        for job in peer.jobs:
                            job.cancel()
                        readers.extend(peer.jobs)
                        if vad is not None:
                            if hasattr(vad, 'set_playback_active'):
                                vad.set_playback_active(False)
                            readers.append(asyncio.create_task(asyncio.to_thread(vad.stop)))
                    try:
                        await asyncio.gather(*readers, return_exceptions=True)
                    finally:
                        self.vad = None
                        if peer is not None:
                            self.peer = None
