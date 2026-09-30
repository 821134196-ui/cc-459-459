"""Time source — injectable so tests can fast-forward."""
from __future__ import annotations

import threading
from datetime import datetime, timedelta
from typing import Optional


class Clock:
    def __init__(self, start: Optional[datetime] = None):
        self._now = start
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            if self._now is not None:
                return self._now
            return datetime.now().replace(microsecond=0)

    def advance(self, seconds: int = 0, minutes: int = 0) -> datetime:
        """Tests: move the fake clock forward."""
        with self._lock:
            base = self._now if self._now is not None else datetime.now()
            self._now = base + timedelta(seconds=seconds, minutes=minutes)
            return self._now

    def set(self, dt: datetime) -> None:
        with self._lock:
            self._now = dt


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def parse(s: str) -> datetime:
    return datetime.fromisoformat(s)
