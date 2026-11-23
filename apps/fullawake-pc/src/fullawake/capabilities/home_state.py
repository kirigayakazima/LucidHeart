"""Ephemeral phone projection and deterministic desktop scene selection."""

from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


class HomeInput(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', frozen=True)


class Mood(HomeInput):
    state: Literal['calm', 'engaged', 'cheerful', 'excited', 'tired']
    energy: float = Field(ge=0, le=1, allow_inf_nan=False)


class Activity(HomeInput):
    kind: Literal['idle', 'activity', 'project', 'singing', 'thinking', 'browsing_video', 'reading_memory', 'viewing_pc']
    label: str = Field(max_length=64)
    source: Literal['heart', 'companion', 'session']
    startedAt: AwareDatetime | None

    @model_validator(mode='after')
    def check_state(self):
        if self.kind == 'idle':
            if self.label or self.startedAt is not None or self.source != 'heart':
                raise ValueError('invalid idle activity')
        else:
            source = 'session' if self.kind in SESSION_SCENES else 'companion'
            if not self.label.strip() or self.startedAt is None or self.source != source:
                raise ValueError('missing activity evidence')
        return self


class AlbumItem(HomeInput):
    id: str = Field(pattern=r'^alb_[a-f0-9]{8}$')
    kind: Literal['video_storyboard', 'game_moment', 'user_photo']
    title: str = Field(min_length=1, max_length=64)
    summary: str = Field(max_length=160)
    timestamp: AwareDatetime
    revision: int = Field(ge=0, le=2**53 - 1)


class HomeSnapshot(HomeInput):
    schemaVersion: int = Field(ge=1, le=1)
    actorId: Literal['xiaoman']
    sequence: int = Field(ge=1, le=2**53 - 1)
    generatedAt: AwareDatetime
    expiresAt: AwareDatetime
    presence: Literal['present', 'away', 'asleep', 'resting', 'unknown']
    mood: Mood
    activity: Activity
    recentAlbum: tuple[AlbumItem, ...] = Field(max_length=8)

    @model_validator(mode='after')
    def check_timestamps(self):
        if not timedelta() < self.expiresAt - self.generatedAt <= timedelta(seconds=180):
            raise ValueError('invalid snapshot lifetime')
        if self.activity.startedAt and self.activity.startedAt > self.generatedAt:
            raise ValueError('activity cannot start in the future')
        if any(item.timestamp > self.generatedAt for item in self.recentAlbum):
            raise ValueError('album item cannot be from the future')
        if len({item.id for item in self.recentAlbum}) != len(self.recentAlbum):
            raise ValueError('duplicate album item')
        return self


SESSION_SCENES = {
    'browsing_video': ('sofa', 'watch'),
    'reading_memory': ('bookshelf', 'read'),
    'viewing_pc': ('computer', 'read'),
    'thinking': ('desk', 'sit'),
}


def scene(place, pose, source, label):
    return {'place': place, 'pose': pose, 'source': source, 'label': label}


def resolve_scene_state(phone_snapshot, pc_runtime):
    if phone_snapshot is None:
        return scene('window', 'idle', 'offline', '安静等待')
    for key, place, pose, label in (
        ('call_active', 'desk', 'sit', '连麦中'),
        ('watch_active', 'sofa', 'watch', '陪看中'),
        ('game_watch_active', 'computer', 'watch', '游戏观战中'),
    ):
        if pc_runtime.get(key):
            return scene(place, pose, 'pc', label)
    activity = phone_snapshot.activity
    if activity.kind in SESSION_SCENES:
        return scene(*SESSION_SCENES[activity.kind], 'session', activity.label)
    if activity.kind != 'idle':
        return scene('desk', 'sit' if activity.kind == 'singing' else 'read', 'companion', activity.label)
    if phone_snapshot.presence == 'asleep':
        return scene('bed', 'rest', 'heart', '正在休息')
    if phone_snapshot.presence == 'resting' or phone_snapshot.mood.state == 'tired':
        return scene('window', 'sit', 'heart', '窗边小憩')
    return scene('window', 'idle', 'decoration', '安静待机')


class HomeState:
    def __init__(self, now=lambda: datetime.now(timezone.utc)):
        self.now = now
        self.snapshot = None
        self.last_sequence = 0
        self.last_generated_at = None
        self.unavailable = 'awaiting'
        self.speech_bubble = None

    def set_speech(self, text, *, intent='talk', duration_ms=None, utterance_id=None):
        if not isinstance(text, str) or not (text := text.strip()[:200]):
            return
        at = self.now()
        ms = min(duration_ms, 60_000) if type(duration_ms) is int and duration_ms > 0 else max(4000, min(15000, len(text) * 260 + 2000))
        self.speech_bubble = {
            'text': text, 'intent': intent if intent in ('talk', 'nod', 'smile', 'wave', 'shock') else 'talk',
            'utteranceId': utterance_id, 'startedAt': at, 'expiresAt': at + timedelta(milliseconds=ms + 1200),
        }

    def clear_speech(self, utterance_id=None, *, immediate=False):
        current = self.speech_bubble
        if current is None or (utterance_id is not None and current['utteranceId'] != utterance_id):
            return
        if immediate:
            self.speech_bubble = None
        else:
            current['expiresAt'] = min(current['expiresAt'], self.now() + timedelta(milliseconds=1200))

    def accept(self, snapshot):
        at = self.now()
        if snapshot.generatedAt > at + timedelta(seconds=30) or snapshot.expiresAt <= at:
            return False
        if self.last_generated_at is not None and (
            snapshot.generatedAt <= self.last_generated_at
            or (snapshot.sequence <= self.last_sequence and snapshot.sequence != 1)
        ):
            return False
        self.snapshot = snapshot
        self.unavailable = None
        self.last_sequence = snapshot.sequence
        self.last_generated_at = snapshot.generatedAt
        return True

    def invalidate(self, reason='disconnected'):
        self.snapshot = None
        self.speech_bubble = None
        self.unavailable = reason

    def view(self, pc_runtime, *, include_album=False):
        now = self.now()
        if self.snapshot is not None and self.snapshot.expiresAt <= now:
            self.invalidate('expired')
        if self.speech_bubble is not None and self.speech_bubble['expiresAt'] <= now:
            self.clear_speech(immediate=True)
        snapshot = self.snapshot
        bubble = self.speech_bubble
        result = {
            'schemaVersion': 1, 'phone_online': snapshot is not None, 'stale': snapshot is None,
            'unavailable': self.unavailable,
            'sequence': snapshot.sequence if snapshot else None,
            'generatedAt': snapshot.generatedAt.isoformat() if snapshot else None,
            'expiresAt': snapshot.expiresAt.isoformat() if snapshot else None,
            'presence': snapshot.presence if snapshot else 'unknown',
            'mood': snapshot.mood.model_dump() if snapshot else None,
            'sceneState': resolve_scene_state(snapshot, pc_runtime),
            'speechBubble': {**bubble, 'startedAt': bubble['startedAt'].isoformat(),
                             'expiresAt': bubble['expiresAt'].isoformat()} if bubble else None,
            'pet_running': bool(pc_runtime.get('pet_running')),
            'albumCount': len(snapshot.recentAlbum) if snapshot else 0,
            'target_label': pc_runtime.get('target_label') if snapshot and pc_runtime.get('watch_active') else None,
        }
        if include_album:
            result['recentAlbum'] = [item.model_dump(mode='json') for item in snapshot.recentAlbum] if snapshot else []
        return result
