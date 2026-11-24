"""The time-left estimate, driven with chunk times we choose."""

import random

from fama_worker.eta import Eta

HEARTBEAT_S = 5


def _run(chunk_seconds: list[float], *, start: float = 100.0):
    """Feed one chunk at a time. Returns (time, estimate in s, real time left in s) at each heartbeat."""
    eta = Eta()
    total = len(chunk_seconds)
    end = start + sum(chunk_seconds)
    now, next_beat, samples = start, start, []
    eta.observe("synthesizing", 0, total, now)
    for done, seconds in enumerate(chunk_seconds, start=1):
        # Heartbeats that fall while this chunk is made see the state of the last step.
        while next_beat < now + seconds:
            remaining = eta.remaining_ms(next_beat)
            if remaining is not None:
                samples.append((next_beat, remaining / 1000, end - next_beat))
            next_beat += HEARTBEAT_S
        now += seconds
        eta.observe("synthesizing", done, total, now)
    return samples


def test_no_estimate_before_the_engine_speed_is_known():
    eta = Eta()
    eta.observe("extracting", 1, 1, 0.0)
    assert eta.remaining_ms(0.0) is None
    eta.observe("synthesizing", 0, 10, 1.0)
    for done in range(1, 6):
        eta.observe("synthesizing", done, 10, 1.0 + done)
        assert eta.remaining_ms(1.0 + done) is None  # the first chunk is warm-up, so five chunks give four
    eta.observe("synthesizing", 6, 10, 7.0)
    assert eta.remaining_ms(7.0) == 4000


def test_no_estimate_after_synthesis():
    eta = Eta()
    eta.observe("synthesizing", 0, 5, 0.0)
    for done in range(1, 8):
        eta.observe("synthesizing", done, 8, float(done))
    assert eta.remaining_ms(7.0) is not None
    eta.observe("encoding", 0, 1, 9.0)
    assert eta.remaining_ms(9.0) is None


def test_uneven_chunks_count_down_without_jumps():
    for seed in range(50):
        rng = random.Random(seed)
        chunks = [8.0] + [rng.uniform(0.5, 2.5) for _ in range(300)]  # model load, then very uneven chunks
        estimates = [estimate for _, estimate, _ in _run(chunks)]
        assert all(later < earlier for earlier, later in zip(estimates, estimates[1:])), seed


def test_lands_near_the_truth():
    for seed in range(50):
        rng = random.Random(seed)
        samples = _run([8.0] + [rng.uniform(0.8, 1.6) for _ in range(300)])
        for _, estimate, truth in samples[len(samples) // 10:]:
            assert abs(estimate - truth) <= max(0.15 * truth, 10), seed


def test_cached_chunks_do_not_make_the_job_look_fast():
    # A resumed job: the first half comes from the cache, the rest the engine makes at 1 s a chunk.
    samples = _run([0.005] * 200 + [3.0] + [1.0] * 200)
    _, first, truth = samples[0]
    assert abs(first - truth) <= 0.15 * truth
    estimates = [estimate for _, estimate, _ in samples]
    assert all(later < earlier for earlier, later in zip(estimates, estimates[1:]))


def test_a_job_that_slows_down_moves_its_estimate_up_slowly():
    samples = _run([1.0] * 100 + [2.0] * 100)
    estimates = [estimate for _, estimate, _ in samples]
    rises = [later - earlier for earlier, later in zip(estimates, estimates[1:]) if later > earlier]
    assert all(rise < HEARTBEAT_S for rise in rises)
    _, last, truth = samples[-1]
    assert abs(last - truth) <= max(0.25 * truth, 10)
