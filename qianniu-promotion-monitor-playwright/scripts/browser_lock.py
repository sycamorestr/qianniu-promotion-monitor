"""Process-owned file mutexes; lock metadata is never ownership evidence.

Keep the file in place after release. Unlinking a locked file allows another
process to lock a different inode while the original owner is still active.
The OS releases the held handle after a crash, so stale PID recovery and
process signalling are deliberately unnecessary.
"""

from __future__ import annotations

import errno
import json
import os
from pathlib import Path
from typing import Any, BinaryIO
import uuid


class FileMutexBusy(RuntimeError):
    pass


class FileMutex:
    def __init__(self, path: Path, metadata: dict[str, Any] | None = None) -> None:
        self.path = Path(path)
        self.metadata = dict(metadata or {})
        self._stream: BinaryIO | None = None

    @property
    def owned(self) -> bool:
        return self._stream is not None

    def acquire(self) -> None:
        if self.owned:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        stream = os.fdopen(fd, "r+b", buffering=0)
        try:
            if os.name == "nt":
                import msvcrt
                # Windows permits a byte range lock beyond EOF. Acquire it
                # before writing even the first byte, avoiding an empty-file
                # race between owners.
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            stream.close()
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise FileMutexBusy(f"作业锁已被占用: {self.path}") from exc
            raise
        try:
            payload = {**self.metadata, "pid": os.getpid(), "owner": uuid.uuid4().hex}
            stream.seek(0)
            stream.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            stream.truncate()
        except BaseException:
            stream.close()
            raise
        self._stream = stream

    def release(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            # Closing releases precisely this owner's lock. Do not unlink
            # the file or use the diagnostic PID to touch another process.
            stream.close()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()
