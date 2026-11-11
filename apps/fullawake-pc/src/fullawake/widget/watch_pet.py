"""Independent Qt player and renderer for phone-originated reactions."""

from array import array
import base64
from io import BytesIO
import json
import math
import time
import wave

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QRectF, Qt, QTimer, QUrl
from PySide6.QtGui import QColor, QPainter, QPixmap
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtNetwork import QAbstractSocket
from PySide6.QtWebSockets import QWebSocket
from PySide6.QtWidgets import QApplication, QLabel, QWidget


class MouthEnvelope:
    def __init__(self, data):
        with wave.open(BytesIO(data), 'rb') as wav:
            self.samples = array('h', wav.readframes(wav.getnframes()))
            self.samples_per_ms = wav.getframerate() * wav.getnchannels() / 1000
        self.level = 0
        self.rms = 0

    def at(self, position_ms):
        start = int(max(0, position_ms - 16) * self.samples_per_ms)
        end = int((position_ms + 16) * self.samples_per_ms)
        samples = self.samples[start:end]
        rms = math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples))) / 32768
        self.rms += (rms - self.rms) * (0.55 if rms > self.rms else 0.24)
        low = 0.018 if self.level == 0 else 0.012
        high = 0.055 if self.level == 2 else 0.08
        self.level = 2 if self.rms >= high else 1 if self.rms >= low else 0
        return self.level


class WatchPet(QWidget):
    def __init__(self, port, name, portrait):
        super().__init__(None, Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowTitle(f'LucidHeart · {name}')
        self.resize(284, 274)
        self.name = name
        self.sprite = QPixmap(portrait) if portrait else QPixmap()
        self.mouth = 0
        self.intent = ''
        self.action_until = 0
        self.drag = None
        self.utterance = ''
        self.bridged = False
        self.envelope = None
        self.buffer = None
        self.bubble = QLabel(self)
        self.bubble.setTextFormat(Qt.TextFormat.PlainText)
        self.bubble.setWordWrap(True)
        self.bubble.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.bubble.setGeometry(8, 4, 268, 87)
        self.bubble.setStyleSheet('QLabel {color:#352744;background:#fff3eb;border-radius:14px;padding:7px;}')
        self.bubble.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.bubble.hide()

        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setAudioOutput(self.audio)
        self.player.mediaStatusChanged.connect(self.media_changed)

        self.socket = QWebSocket(parent=self)
        self.socket.setMaxAllowedIncomingMessageSize(1_500_000)
        self.socket.textMessageReceived.connect(self.receive)
        self.socket.disconnected.connect(self.disconnected)
        self.url = QUrl(f'ws://127.0.0.1:{port}/ws/pet?player=1')
        self.connect_timer = QTimer(self)
        self.connect_timer.timeout.connect(self.connect_socket)
        self.connect_timer.start(2000)
        self.connect_socket()

        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.timer.timeout.connect(self.tick)
        self.timer.start(33)

    def connect_socket(self):
        if self.socket.state() == QAbstractSocket.SocketState.UnconnectedState:
            self.socket.open(self.url)

    def disconnected(self):
        self.stop_audio()
        self.bubble.hide()

    def receive(self, raw):
        try:
            event = json.loads(raw)
            if event['event'] == 'action':
                self.utterance = event['utteranceId']
                self.bridged = event.get('voiceBridge') is True
                self.intent = event['intent']
                self.action_until = time.monotonic() + event['durationMs'] / 1000
                self.bubble.setText(event['text'])
                self.bubble.show()
                if event.get('bridgeText'):
                    self.clock('idle', outcome='text_delivered' if self.bubble.isVisible() else 'discarded')
            elif event['event'] == 'playback_audio' and event['utteranceId'] == self.utterance:
                data = base64.b64decode(event['audioBase64'], validate=True)
                self.envelope = MouthEnvelope(data)
                self.buffer = QBuffer(self)
                self.buffer.setData(QByteArray(data))
                self.buffer.open(QIODevice.OpenModeFlag.ReadOnly)
                self.player.setSourceDevice(self.buffer, QUrl('memory.wav'))
                self.player.play()
            elif event['event'] == 'playback_clock' and event['mode'] == 'idle':
                self.stop_audio()
                self.bubble.hide()
            elif event['event'] == 'interrupt' and self.utterance in ('', event['utteranceId']):
                position = self.player.position() if self.utterance else 0
                self.stop_audio()
                self.intent = 'listen'
                self.action_until = time.monotonic() + 2
                self.bubble.hide()
                self.socket.sendTextMessage(json.dumps({
                    'event': 'interrupt_ack', 'interruptId': event['interruptId'],
                    'utteranceId': event['utteranceId'], 'elapsedAudioMs': position,
                }))
        except (ValueError, KeyError, TypeError, wave.Error, EOFError):
            if self.bridged:
                self.clock('idle', outcome='discarded')
            self.stop_audio()

    def clock(self, mode, position=0, *, outcome=None):
        if self.utterance and self.socket.state() == QAbstractSocket.SocketState.ConnectedState:
            self.socket.sendTextMessage(json.dumps({'event': 'playback_clock', 'mode': mode,
                'utteranceId': self.utterance, 'positionMs': position, 'mouth': self.mouth,
                **({'outcome': outcome} if outcome is not None else {})}))

    def media_changed(self, status):
        if status in (QMediaPlayer.MediaStatus.EndOfMedia, QMediaPlayer.MediaStatus.InvalidMedia):
            played = status == QMediaPlayer.MediaStatus.EndOfMedia and self.buffer is not None
            self.clock('idle', outcome=('played' if played else 'discarded') if self.bridged else None)
            self.stop_audio()

    def stop_audio(self):
        self.envelope = None
        self.utterance = ''
        self.bridged = False
        self.mouth = 0
        if self.buffer is not None:
            self.player.stop()
            self.player.setSource(QUrl())
            self.buffer.deleteLater()
            self.buffer = None

    def tick(self):
        if self.envelope is not None and self.player.isPlaying():
            position = self.player.position()
            self.mouth = self.envelope.at(position)
            self.clock('speaking', position)
        else:
            self.mouth = 0
        if time.monotonic() >= self.action_until:
            self.intent = ''
            self.bubble.hide()
        self.update()

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(Qt.PenStyle.NoPen)
        now = time.monotonic()
        y = math.sin(now * 2) * 3 + (abs(math.sin(now * 10)) * 8 if self.intent == 'nod' else 0)

        def oval(x, top, width, height, color):
            painter.setBrush(QColor(color))
            painter.drawEllipse(QRectF(x, top + y, width, height))

        if self.sprite.isNull():
            oval(80, 181, 124, 64, '#8e84c7')
            oval(77, 95, 130, 139, '#433857')
            oval(92, 121, 100, 105, '#ffe0cf')
            oval(85, 98, 112, 50, '#433857')
            for x in (113, 160):
                oval(x, 159, 10, 3 if now % 5 < 0.14 else 13, '#392e50')
        else:
            sprite = self.sprite.scaled(150, 155, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            painter.drawPixmap((self.width() - sprite.width()) // 2, int(91 + y), sprite)
        height = max((2, 9, 17)[self.mouth], 12 if self.intent == 'shock' else 0)
        oval(132, 188, 20, height, '#a65c73')
        if self.intent == 'smile' and not self.mouth:
            oval(101, 178, 15, 8, '#f7afae')
            oval(168, 178, 15, 8, '#f7afae')
        if self.intent == 'listen':
            oval(113, 160, 10, 8, '#392e50')
            oval(161, 160, 10, 8, '#392e50')
        if self.intent == 'wave':
            oval(207 + math.sin(now * 12) * 7, 175, 18, 26, '#ffdfc6')
        painter.setPen(QColor('#fff3eb'))
        painter.setBrush(QColor('#433857'))
        painter.drawRoundedRect(QRectF(91, 244, 102, 25), 10, 10)
        painter.drawText(QRectF(91, 244, 102, 25), Qt.AlignmentFlag.AlignCenter, self.name)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.RightButton:
            self.close()
        elif event.button() == Qt.MouseButton.LeftButton:
            self.drag = event.globalPosition().toPoint() - self.pos()

    def mouseMoveEvent(self, event):
        if self.drag is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag)

    def closeEvent(self, event):
        self.connect_timer.stop()
        self.stop_audio()
        self.socket.close()
        super().closeEvent(event)


def run_pet(port, name, portrait=None):
    app = QApplication([])
    pet = WatchPet(port, name, portrait)
    screen = app.primaryScreen().availableGeometry()
    pet.move(screen.right() - pet.width() - 40, screen.top() + 70)
    pet.show()
    app.exec()
