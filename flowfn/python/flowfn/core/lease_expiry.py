"""Observe local ownership expiry without awaiting provider cancellation."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable


class LeaseExpiry:
    def __init__(self, deadline: float, expired: Callable[[], None]) -> None:
        self.deadline = deadline
        self.expired = False
        self._closed = False
        self._callback = expired
        self._timer: asyncio.TimerHandle | None = None
        self._schedule()

    def _schedule(self) -> None:
        self._timer = asyncio.get_running_loop().call_later(
            max(0, self.deadline - time.monotonic()), self._check,
        )

    def _check(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        self._timer = None
        if self._closed or self.expired:
            return
        if time.monotonic() < self.deadline:
            self._schedule()
            return
        self.expired = True
        self._callback()

    def renew(self, deadline: float) -> bool:
        if self._closed or self.expired:
            return False
        if time.monotonic() >= self.deadline:
            self._check()
            return False
        if self._timer is not None:
            self._timer.cancel()
        self.deadline = deadline
        self._schedule()
        return True

    def close(self) -> None:
        self._closed = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
