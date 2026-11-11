"""The PC side of lucid.voice/1. All lease state lives on the gateway event loop."""

import asyncio
from dataclasses import dataclass, field
import hmac
import inspect
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
from fullawake.capabilities.desktop_vision.watch import native_loopback, wav_duration
from fullawake.capabilities.voice import ASSETS, DEFAULTS
from fullawake.capabilities.voice_vad import VoiceVadListener
from fullawake.core.config import config
from fullawake.core.session import is_desktop_locked

log = logging.getLogger(__name__)
PROTOCOL = 'lucid.voice/1'
INITIAL_EPOCH = 100
REVOKED_TTL = 60
RENDERER_ACK_TIMEOUT = 0.2
MAX_EPOCH = 2**53 - 1


class StrictFrame(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Frame(StrictFrame):
    protocol: Literal['lucid.voice/1']
    type: Literal['session.handshake', 'audio.prepare', 'audio.speak', 'audio.cancel', 'audio.interrupt_ack', 'pet.text']
    sessionId: str = Field(min_length=1, max_length=140)
    connectionId: str = Field(min_length=1, max_length=80)
    commandSeq: int = Field(ge=1, le=MAX_EPOCH)
    payload: dict


class Handshake(StrictFrame):
    clientVersion: str = Field(min_length=1, max_length=40)
    heartVersion: str = Field(min_length=1, max_length=40)
    device: str = Field(min_length=1, max_length=80)


class Utterance(StrictFrame):
    epoch: int = Field(ge=INITIAL_EPOCH, le=MAX_EPOCH)
    utteranceId: str = Field(min_length=1, max_length=80)


class Prepare(Utterance):
    watchSessionId: str | None = Field(default=None, min_length=1, max_length=140)
    cueId: str | None = Field(default=None, min_length=1, max_length=40)


class PetText(Utterance):
    text: str = Field(min_length=1, max_length=120)
    intent: Literal['nod', 'smile', 'wave', 'shock']


class Speak(Utterance):
    text: str = Field(min_length=1, max_length=200)
    voiceProfile: Literal['feiyu-rvc-v1']
    pitchShift: int
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


@dataclass(eq=False)
class Lease:
    command: Utterance
    deadline: float
    renderer_id: str = field(default_factory=lambda: uuid4().hex)
    cue: Prepare | None = None
    timeline: str | None = None
    receipt: asyncio.Future | None = None
    worker: asyncio.Task | None = None


@dataclass(eq=False)
class Peer:
    session: str
    connection: str
    turn_lifecycle: bool = False
    received_seq: int = 1
    sent_seq: int = 0
    highest_epoch: int = INITIAL_EPOCH - 1
    epoch_floor: int = INITIAL_EPOCH
    last_interrupted: int | None = None
    revoked_epochs: dict = field(default_factory=dict)
    speaking: bool = False
    lease: Lease | None = None
    jobs: set = field(default_factory=set)
    outbound: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=16))

    def send(self, kind, **payload):
        self.sent_seq += 1
        self.outbound.put_nowait({'protocol': PROTOCOL, 'type': kind, 'sessionId': self.session,
                                 'connectionId': self.connection, 'commandSeq': self.sent_seq, 'payload': payload})

    def prune_revoked(self, now):
        for epoch, expires in tuple(self.revoked_epochs.items()):
            if now >= expires:
                del self.revoked_epochs[epoch]


class InterruptController:
    def __init__(self, watch_cap, voice):
        self.watch = watch_cap
        self.voice = voice
        self.peer = None
        self.vad = None

    def on_speech_start(self, peer):
        if self.peer is not peer:
            return
        if self.vad and hasattr(self.vad, 'set_playback_active'):
            self.vad.set_playback_active(False)
        peer.speaking = True
        lease = peer.lease
        if not lease:
            return
        if lease.receipt and lease.receipt.done() and lease.receipt.result() in ('played', 'text_delivered'):
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
                          localAudioStopped=elapsed is not None, elapsedAudioMs=elapsed or 0)
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
        expected = 'played' if isinstance(lease.command, Speak) else 'text_delivered'
        return expected if lease.receipt.result() == expected else 'discarded'

    async def _expire_prepared(self, peer, lease):
        while peer.lease is lease and isinstance(lease.command, Prepare):
            if time.monotonic() >= lease.deadline or not self.watch.player or not self._fresh_cue(lease):
                self._settle(peer, lease, 'discarded')
                return
            await asyncio.sleep(0.1)

    async def _play(self, peer, lease):
        command = lease.command
        outcome = 'discarded'
        try:
            async def cancelled():
                return not self._can_render(peer, lease)

            if await cancelled():
                return
            audio, duration, intent = None, 4000, 'talk'
            if isinstance(command, Speak):
                profile = json.loads(Path(config.voice_profile).read_text(encoding='utf-8-sig'))
                request = {'text': command.text, 'voice': {
                    'id': command.voiceProfile,
                    'assets': {name: profile['assets'][name]['sha256'] for name in ASSETS},
                    'settings': {**DEFAULTS, **{key: profile[key] for key in DEFAULTS if key in profile},
                                 'pitch': command.pitchShift},
                }}
                result = await self.voice.synthesize(request, disconnected=cancelled)
                if not self._can_render(peer, lease):
                    return
                audio = result['audioBase64']
                duration = wav_duration(audio)
            else:
                intent = command.intent
            if not self._can_render(peer, lease):
                return
            lease.receipt = self.watch.play_bridge(lease.renderer_id, command.text, audio, duration, intent)
            if not lease.receipt:
                return
            if audio is not None and self.vad and hasattr(self.vad, 'set_playback_active'):
                self.vad.set_playback_active(True)
            end = time.monotonic() + (duration / 1000 + 2 if audio is not None else 2)
            while (not lease.receipt.done() and time.monotonic() < end and not is_desktop_locked() and
                   (not lease.timeline or (self.watch.timeline == lease.timeline and self.watch.playing(time.monotonic())))):
                await asyncio.sleep(0.1)
            if lease.receipt.done():
                outcome = self._outcome(lease)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, wave.Error, EOFError) as error:
            log.info('Voice bridge speech discarded (%s)', type(error).__name__)
        finally:
            if self.vad and hasattr(self.vad, 'set_playback_active'):
                self.vad.set_playback_active(False)
            self._settle(peer, lease, outcome)

    async def _receive(self, socket, peer):
        while True:
            frame = await self._read(socket)
            if (frame.sessionId != peer.session or frame.connectionId != peer.connection
                    or frame.type == 'session.handshake'):
                raise ValueError('Wrong voice connection')
            if frame.commandSeq <= peer.received_seq:
                continue
            peer.received_seq = frame.commandSeq
            if frame.type == 'audio.interrupt_ack':
                ack = InterruptAck.model_validate(frame.payload)
                if ack.abortedEpoch == peer.last_interrupted and ack.currentEpoch > ack.abortedEpoch:
                    peer.epoch_floor = max(peer.epoch_floor, ack.currentEpoch)
                    peer.last_interrupted = None
                    if peer.lease and peer.lease.command.epoch < peer.epoch_floor:
                        self._settle(peer, peer.lease, 'discarded')
                continue
            models = {'audio.prepare': Prepare, 'audio.speak': Speak, 'audio.cancel': Utterance, 'pet.text': PetText}
            command = models[frame.type].model_validate(frame.payload)
            now = time.monotonic()
            peer.prune_revoked(now)
            lease = peer.lease
            matches = lease and (lease.command.epoch, lease.command.utteranceId) == (command.epoch, command.utteranceId)
            if frame.type == 'audio.cancel':
                if matches:
                    self._settle(peer, lease, 'cancelled')
                continue
            if matches and isinstance(lease.command, Prepare) and isinstance(command, (Speak, PetText)):
                if now >= lease.deadline or not self._fresh_cue(lease):
                    self._settle(peer, lease, 'discarded')
                else:
                    lease.command = command
                    lease.deadline = min(lease.deadline, now + (command.deadlineMs / 1000 if isinstance(command, Speak) else 2))
                    lease.worker = self._spawn(peer, self._play(peer, lease))
                continue
            if (command.epoch < peer.epoch_floor or command.epoch <= peer.highest_epoch
                    or command.epoch in peer.revoked_epochs):
                continue
            peer.highest_epoch = command.epoch
            if peer.speaking or peer.lease or isinstance(command, PetText):
                self._result(peer, command, 'discarded')
                continue
            if isinstance(command, Prepare):
                lease = Lease(command, now + 25, cue=command, timeline=self.watch.timeline if command.cueId else None)
                if (not peer.turn_lifecycle or not self.watch.player or is_desktop_locked() or
                        bool(command.cueId) != bool(command.watchSessionId) or not self._fresh_cue(lease)):
                    self._result(peer, command, 'discarded')
                    continue
                peer.lease = lease
                peer.send('audio.prepared', epoch=command.epoch, utteranceId=command.utteranceId)
                self._spawn(peer, self._expire_prepared(peer, lease))
            else:
                lease = peer.lease = Lease(command, now + command.deadlineMs / 1000)
                lease.worker = self._spawn(peer, self._play(peer, lease))

    @staticmethod
    async def _read(socket):
        message = await socket.receive()
        if message['type'] == 'websocket.disconnect':
            raise WebSocketDisconnect(message['code'])
        raw = message.get('text')
        if raw is None or len(raw) > 4096:
            raise ValueError('Invalid voice frame size or encoding')
        return Frame.model_validate_json(raw)

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
                peer = self.peer = Peer(first.sessionId, first.connectionId, turn_lifecycle=lifecycle)
                supported = False
                if config.voice_vad_enabled:
                    loop = asyncio.get_running_loop()
                    mode = getattr(config, 'vad_device_mode', 'headphone')
                    vad_kwargs = {'device': config.voice_vad_device}
                    try:
                        sig = inspect.signature(VoiceVadListener.__init__)
                        if 'device_mode' in sig.parameters or any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()):
                            vad_kwargs['device_mode'] = mode
                    except (ValueError, TypeError):
                        pass
                    vad = VoiceVadListener(lambda: loop.call_soon_threadsafe(self.on_speech_start, peer),
                                           lambda: loop.call_soon_threadsafe(self.on_speech_end, peer),
                                           **vad_kwargs)
                    supported = await asyncio.to_thread(vad.start)
                    self.vad = vad
                peer.send('session.handshake_ack', status='ready', gatewayVersion=__version__,
                          initialEpoch=INITIAL_EPOCH, vadSupported=supported, **({'turnLifecycle': True} if lifecycle else {}))

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
