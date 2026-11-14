"""Single event-loop owner for physical speech and song playback."""

from collections import deque
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class PlaybackLease:
    token: str
    kind: str
    start: Callable
    stop: Callable


class LeaseArbiter:
    def __init__(self):
        self.active = None
        self.pending = deque()

    def acquire(self, lease):
        if self.active is None:
            self.active = lease
            lease.start()
            return 'playing'
        if lease.kind == 'song' and len(self.pending) < 3:
            self.pending.append(lease)
            return 'queued'
        return 'busy'

    def finish(self, token):
        if self.active is None or self.active.token != token:
            return False
        self.active = None
        if self.pending:
            self.acquire(self.pending.popleft())
        return True

    def revoke(self, *, clear_queue=True):
        if clear_queue:
            while self.pending:
                self.pending.popleft().stop()
        lease, self.active = self.active, None
        if lease is not None:
            lease.stop()
