"""Replay a 16 kHz mono speech WAV through VAD, localhost and the real Qt player."""

import argparse
import base64
from io import BytesIO
import json
import math
import os
from pathlib import Path
import socket
import statistics
from tempfile import TemporaryDirectory
from threading import Thread
import time
from types import SimpleNamespace
from unittest.mock import patch
import wave

from PySide6.QtCore import QEventLoop, QTimer, QUrl
from PySide6.QtNetwork import QAbstractSocket, QNetworkRequest
from PySide6.QtWebSockets import QWebSocket
from PySide6.QtWidgets import QApplication
import uvicorn
import webrtcvad

from fullawake.capabilities.voice import ASSETS
from fullawake.capabilities.voice_vad import FRAME_MS, SpeechGate
from fullawake.core.config import config
from fullawake.gateway.mcp_server import FullAwakeMCPGateway
from pet.fullawake_bridge import FullAwakePetBridge


def wait_until(predicate, timeout_ms=4000):
    if predicate():
        return
    loop = QEventLoop()
    poll = QTimer()
    poll.timeout.connect(lambda: loop.quit() if predicate() else None)
    poll.start(2)
    deadline = QTimer()
    deadline.setSingleShot(True)
    deadline.timeout.connect(loop.quit)
    deadline.start(timeout_ms)
    loop.exec()
    if not predicate():
        raise RuntimeError('Timed out waiting for the bridge or player')


def playback_wav():
    buf = BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', ''))
        wav.writeframes(b'\x00\x02' * 160000)
    return base64.b64encode(buf.getvalue()).decode()


class ReplayVad:
    """Replace only the microphone source. Feed the native classifier at 50 Hz."""

    def __init__(self, on_start, on_end, *, device):
        self.on_start = on_start
        self.on_end = on_end

    def start(self):
        return True

    def stop(self):
        pass

    def replay(self, speech, timings):
        def detected():
            timings['vad'] = time.perf_counter()
            self.on_start()

        gate = SpeechGate(webrtcvad.Vad(2), 16000, detected, self.on_end)
        timings['onset'] = time.perf_counter()
        for end in range(640, len(speech) + 1, 640):
            time.sleep(max(0, timings['onset'] + end // 640 * FRAME_MS / 1000 - time.perf_counter()))
            gate.feed(speech[end - 640:end])
            if gate.speaking:
                break
        for _ in range(12):
            time.sleep(FRAME_MS / 1000)
            gate.feed(bytes(640))


def measure(port, gateway, vad_instances, speech, samples, token):
    app = QApplication([])
    target = SimpleNamespace(animation=None)
    target.request_link_anim = lambda name, *, interrupt=False: setattr(target, 'animation', name)
    pet = FullAwakePetBridge(SimpleNamespace(instance=SimpleNamespace(win=target)), port=port)
    pet.audio.setMuted(True)
    phone = QWebSocket()
    messages = []
    phone.textMessageReceived.connect(lambda raw: messages.append(json.loads(raw)))
    request = QNetworkRequest(QUrl(f'ws://127.0.0.1:{port}/ws/bridge'))
    request.setRawHeader(b'Authorization', f'Bearer {token}'.encode())
    try:
        wait_until(lambda: pet.socket.state() == QAbstractSocket.SocketState.ConnectedState and gateway.watch.player)
        phone.open(request)
        wait_until(lambda: phone.state() == QAbstractSocket.SocketState.ConnectedState)

        def send(kind, seq, payload):
            phone.sendTextMessage(json.dumps({'protocol': 'lucid.voice/1', 'type': kind, 'commandSeq': seq,
                'sessionId': 'measure', 'connectionId': 'measure-1', 'payload': payload}))

        send('session.handshake', 1, {'clientVersion': 'probe', 'heartVersion': 'probe', 'device': 'probe'})
        wait_until(lambda: messages)
        assert messages[0]['payload']['vadSupported']
        onset_to_stop = []
        vad_to_stop = []
        timings = {}

        def playing_changed(playing):
            if not playing and 'onset' in timings:
                timings.setdefault('stop', time.perf_counter())

        pet.player.playingChanged.connect(playing_changed)
        for i in range(samples):
            timings.clear()
            target.animation = None
            epoch = 100 + i
            send('audio.speak', i + 2, {'epoch': epoch, 'utteranceId': f'sample-{i}', 'text': 'Latency probe',
                                       'voiceProfile': 'feiyu-rvc-v1', 'pitchShift': 0, 'deadlineMs': 4000})
            wait_until(lambda: pet.player.isPlaying() and pet.player.position() >= 100)
            replay = Thread(target=vad_instances[0].replay, args=(speech, timings))
            replay.start()
            try:
                wait_until(lambda: len(messages) == i + 2)
                notice = messages[-1]['payload']
                assert notice['abortedEpoch'] == epoch and notice['localAudioStopped'], (notice, timings)
                assert not pet.player.isPlaying() and pet.current_mouth == 0 and target.animation == '东张西望'
                onset_to_stop.append((timings['stop'] - timings['onset']) * 1000)
                vad_to_stop.append((timings['stop'] - timings['vad']) * 1000)
            finally:
                replay.join()
            wait_until(lambda: not gateway.interrupts.peer.speaking)
        for label, values in [('replay onset to Qt stop', onset_to_stop), ('VAD edge to Qt stop', vad_to_stop)]:
            p95 = sorted(values)[math.ceil(len(values) * .95) - 1]
            print(f'{label}: n={len(values)} median={statistics.median(values):.2f} ms P95={p95:.2f} ms max={max(values):.2f} ms')
        return int(sorted(onset_to_stop)[math.ceil(samples * .95) - 1] > 200)
    finally:
        phone.abort()
        pet.socket.abort()
        app.processEvents()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('speech_wav', type=Path, help='Trimmed 16 kHz, mono, signed 16-bit speech WAV')
    parser.add_argument('--samples', type=int, default=50)
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error('--samples must be between 1 and 100')
    with wave.open(str(args.speech_wav), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            parser.error('Expected 16 kHz, mono, signed 16-bit WAV')
        speech = wav.readframes(32000)
    token = 'isolated-local-measurement-token'
    os.environ['FULLAWAKE_WATCH_TOKEN'] = token
    config.auth_token = token
    config.voice_enabled = False
    config.voice_vad_enabled = config.epoch_revocation_enabled = True
    audio = playback_wav()
    gateway = FullAwakeMCPGateway()

    async def synth(_request, disconnected):
        return {'audioBase64': audio}

    vad_instances = []

    def vad(*args, **kwargs):
        listener = ReplayVad(*args, **kwargs)
        vad_instances.append(listener)
        return listener

    with TemporaryDirectory(prefix='fullawake-latency-') as folder, socket.socket() as listener:
        profile = Path(folder) / 'voice.json'
        profile.write_text(json.dumps({'assets': {name: {'sha256': 'test'} for name in ASSETS}}), encoding='utf8')
        config.voice_profile = str(profile)
        gateway.voice.synthesize = synth
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        os.environ['FULLAWAKE_PORT'] = str(port)
        server = uvicorn.Server(uvicorn.Config(gateway.app, ws='wsproto', log_level='warning'))
        thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        with patch('fullawake.gateway.interrupt_controller.VoiceVadListener', vad):
            thread.start()
            try:
                deadline = time.monotonic() + 5
                while not server.started and thread.is_alive() and time.monotonic() < deadline:
                    time.sleep(.01)
                if not server.started:
                    raise RuntimeError('Isolated gateway did not start')
                return measure(port, gateway, vad_instances, speech, args.samples, token)
            finally:
                server.should_exit = True
                thread.join(5)


if __name__ == '__main__':
    raise SystemExit(main())
