"""Disk-backed lifecycle for the gateway's configured voice work tree."""
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import logging
from pathlib import Path
import re
import stat
import time

DAY = 86400
TEMPORARY = re.compile(
    r'chunk_\d+\.wav|(?:input|input_dry|dry|output|vocals|no_vocals|accompaniment|voc_new|mix)'
    r'\.(?:wav|mp3|m4a|flac)|(?:output|dry)\.(?:dry\.mp3|result\.json)|profile\.json|manifest\.json'
)
STEMS = {'vocals.wav', 'no_vocals.wav', 'accompaniment.wav'}
LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    path: Path
    type: str
    size: int
    created_at: float
    ttl: int


class VoiceArtifacts:
    def __init__(self, root, max_bytes=1_500_000_000, max_entries=1024):
        self.root = Path(root).absolute()
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.writers = set()
        self.readers = Counter()

    def task_dir(self, group, task):
        return self.root / group / task

    @staticmethod
    def safe(path, kind):
        try:
            info = path.lstat()
            if (not kind(info.st_mode) or path.resolve() != path
                    or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                return None
            return info
        except (FileNotFoundError, RuntimeError):
            return None

    def scan(self, directory, directories=None):
        if not directory.is_relative_to(self.root) or not self.safe(directory, stat.S_ISDIR):
            return
        for file in directory.iterdir():
            parts = file.relative_to(self.root).parts
            if len(parts) <= 8 and self.safe(file, stat.S_ISDIR):
                if len(parts) == 1 and file.name not in ('singing', 'separated') and not file.name.startswith('rvc-'):
                    continue
                yield from self.scan(file, directories)
            elif info := self.safe(file, stat.S_ISREG):
                kind, ttl = 'other', 0
                if len(parts) == 3 and parts[0] == 'singing' and re.fullmatch(r'song(?:_[\w-]+)?\.(?:mp3|wav)', file.name):
                    kind, ttl = 'song', 7 * DAY
                elif len(parts) == 3 and parts[0] == 'separated' and file.name in STEMS:
                    kind, ttl = 'stem', 3600
                elif len(parts) >= 2 and TEMPORARY.fullmatch(file.name):
                    kind, ttl = 'temporary', 3600
                yield Artifact(self.artifact_id(file), file, kind, info.st_size, info.st_mtime, ttl)
        if directories is not None:
            directories.append(directory)

    def artifact_id(self, file):
        return hashlib.sha256(file.relative_to(self.root).as_posix().encode()).hexdigest()

    def remove(self, file):
        if not file.is_relative_to(self.root) or not self.safe(file, stat.S_ISREG):
            return False
        file.unlink()
        for directory in file.parents:
            if directory == self.root:
                break
            try:
                directory.rmdir()
            except OSError:
                break
        return True

    def sweep(self, protected=None, now=None):
        try:
            now = time.time() if now is None else now
            entries = list(self.scan(self.root))
            managed = [entry for entry in entries if entry.ttl]
            busy = self.writers | self.readers.keys() | {protected}
            available = sorted((entry for entry in managed
                                if busy.isdisjoint(entry.path.parents)), key=lambda entry: entry.created_at)
            total, count = sum(entry.size for entry in entries), len(managed)
            for entry in sorted(available, key=lambda e: (now - e.created_at < e.ttl,
                                                           {'song': 0, 'stem': 1, 'temporary': 2}[e.type])):
                expired = now - entry.created_at >= entry.ttl
                if not expired and total <= self.max_bytes and count <= self.max_entries:
                    break
                if not expired and entry.type == 'temporary':
                    continue
                try:
                    if self.remove(entry.path):
                        total -= entry.size
                        count -= 1
                except OSError:
                    LOG.warning('Unable to remove voice artifact %s', entry.path, exc_info=True)
        except OSError:
            LOG.warning('Unable to scan voice artifacts', exc_info=True)

    def prepare(self, directory):
        # Refuse pre-existing links anywhere on the configured path.
        if directory.resolve() != directory:
            raise ValueError('VOICE_WORK_PATH_INVALID')
        directory.mkdir(parents=True, exist_ok=True)
        if not self.safe(directory, stat.S_ISDIR):
            raise ValueError('VOICE_WORK_PATH_INVALID')

    @contextmanager
    def job(self, directory):
        if directory in self.writers or self.readers[directory]:
            raise ValueError('VOICE_BUSY')
        self.sweep(protected=directory)
        self.prepare(directory)
        self.writers.add(directory)
        try:
            yield directory
        finally:
            try:
                directories = []
                for entry in list(self.scan(directory, directories)):
                    if entry.type == 'temporary':
                        self.remove(entry.path)
                for folder in directories:
                    if self.safe(folder, stat.S_ISDIR):
                        try:
                            folder.rmdir()
                        except OSError:
                            pass
            except OSError:
                LOG.warning('Unable to clean voice job %s', directory, exc_info=True)
            finally:
                self.writers.remove(directory)
                self.sweep(protected=directory)

    def pin(self, file, ttl):
        directory = file.parent
        if not file.is_relative_to(self.root) or directory in self.writers:
            return None
        info = self.safe(file, stat.S_ISREG)
        if not info or time.time() - info.st_mtime >= ttl:
            return None
        self.readers[directory] += 1

        def release():
            self.readers[directory] -= 1
            if not self.readers[directory]:
                del self.readers[directory]

        return release
