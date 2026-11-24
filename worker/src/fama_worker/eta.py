"""The time left until a job is Ready, from the chunks left and this job's own speed.

Only chunks the engine made count toward the speed. A chunk from the cache takes a few
milliseconds, so a resumed job would look many times faster than it is. The first chunk
the engine makes also loads the model, so it does not count either. The Ready time moves
toward each new estimate slower than the clock runs, so the time left always goes
down and never jumps.
"""

from __future__ import annotations

CACHED_S = 0.05  # a chunk faster than this, before the engine's speed is known, came from the cache
CACHED_FRACTION = 0.2  # after that, a chunk faster than this share of the engine's speed came from the cache
MIN_MADE = 5  # engine chunks to measure before the first estimate
MAX_SHIFT = 0.8  # seconds the Ready time may move for each second of wall time, so the time left still falls


class Eta:
    """Feed it each `synthesizing` progress step with a monotonic time. Other stages have no estimate.

    `remaining_ms` runs on the heartbeat thread, so it only reads `_course`, which `observe` replaces in one write.
    """

    def __init__(self) -> None:
        self._at: float | None = None  # time of the last synthesizing step
        self._done = 0
        self._warm = False  # the engine has made its first chunk
        self._spent = 0.0  # wall seconds of engine chunks, after the first
        self._made = 0  # engine chunks in `_spent`
        # (since, ready_at, target): the Ready time was `ready_at` at `since` and moves toward `target`.
        self._course: tuple[float, float, float] | None = None

    def observe(self, stage: str, done: int, total: int, now: float) -> None:
        if stage != "synthesizing":
            self._at, self._course = None, None
            return
        if self._at is not None and done > self._done:
            steps = done - self._done
            if not self._is_cached((now - self._at) / steps):
                if self._warm:
                    self._spent += now - self._at
                    self._made += steps
                self._warm = True
        self._at, self._done = now, done
        if self._made >= MIN_MADE:
            target = now + (total - done) * self._spent / self._made
            ready_at = target if self._course is None else _ready_at(self._course, now)
            self._course = (now, ready_at, target)

    def _is_cached(self, per_chunk: float) -> bool:
        threshold = CACHED_S if self._made == 0 else CACHED_FRACTION * self._spent / self._made
        return per_chunk < threshold

    def remaining_ms(self, now: float) -> int | None:
        course = self._course
        return None if course is None else max(0, round((_ready_at(course, now) - now) * 1000))


def _ready_at(course: tuple[float, float, float], now: float) -> float:
    since, ready_at, target = course
    shift = MAX_SHIFT * max(0.0, now - since)
    return ready_at + min(shift, max(-shift, target - ready_at))
