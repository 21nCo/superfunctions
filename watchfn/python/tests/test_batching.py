import threading

import pytest

from watchfn.utils.batching import Batcher


def test_stop_flushes_pending_and_can_restart():
    received = []
    batcher = Batcher(received.extend, max_wait=60)
    for value in range(3):
        batcher.start()
        batcher.add(value)
        batcher.stop()
    assert received == [0, 1, 2]
    assert batcher._thread is None


def test_flush_joins_active_delivery_and_flushes_new_events():
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    received = []
    def deliver(batch):
        if batch == [1]:
            entered.set()
            assert release.wait(2)
        received.extend(batch)
    batcher = Batcher(deliver, max_size=1)
    batcher.start()
    reader = None
    try:
        batcher.add(1)
        assert entered.wait(2)
        batcher.add(2)
        reader = threading.Thread(target=lambda: (batcher.flush(), finished.set()))
        reader.start()
        assert not finished.wait(.02)
        release.set()
        reader.join(2)
        assert finished.is_set()
        assert received == [1, 2]
    finally:
        release.set()
        if reader is not None:
            reader.join(2)
        batcher.stop()


def test_failed_delivery_is_visible_and_retains_order_for_retry():
    received = []
    failed = True
    def deliver(batch):
        nonlocal failed
        if failed:
            failed = False
            raise ValueError('storage unavailable')
        received.extend(batch)
    batcher = Batcher(deliver, max_size=2)
    batcher.add(1)
    batcher.add(2)
    with pytest.raises(ValueError, match='storage unavailable'):
        batcher.flush()
    batcher.add(3)
    batcher.flush()
    assert received == [1, 2, 3]


def test_stop_surfaces_failure_without_discarding_pending():
    received = []
    batcher = Batcher(lambda batch: (_ for _ in ()).throw(ValueError('write failed')))
    batcher.add(1)
    with pytest.raises(ValueError, match='write failed'):
        batcher.stop()
    batcher.on_flush = received.extend
    batcher.flush()
    assert received == [1]


def test_overlapping_stops_cannot_disown_a_replacement_worker(monkeypatch):
    batcher = Batcher(lambda batch: None, max_wait=60)
    batcher.start()
    original = batcher._thread
    joined, release = threading.Event(), threading.Event()
    original_join = original.join

    def delayed_join(*args, **kwargs):
        original_join(*args, **kwargs)
        if threading.current_thread() is late_stop:
            joined.set()
            assert release.wait(2)

    monkeypatch.setattr(original, 'join', delayed_join)
    late_stop = threading.Thread(target=batcher.stop, daemon=True)
    replacement = None
    try:
        late_stop.start()
        assert joined.wait(2)
        batcher.stop()
        batcher.start()
        replacement = batcher._thread
        assert replacement is not original and replacement.is_alive()
        release.set()
        late_stop.join(2)
        assert not late_stop.is_alive()
        assert batcher._thread is replacement
        batcher.start()
        assert batcher._thread is replacement
        batcher.stop()
        assert not replacement.is_alive()
        assert batcher._thread is None
    finally:
        release.set()
        late_stop.join(2)
        batcher.stop()
        if replacement is not None:
            replacement.join(2)


def test_stop_does_not_hold_lifecycle_lock_while_callback_calls_start():
    entered, restart, callback_done = threading.Event(), threading.Event(), threading.Event()

    def deliver(batch):
        entered.set()
        assert restart.wait(2)
        batcher.start()
        callback_done.set()

    batcher = Batcher(deliver, max_size=1)
    batcher.start()
    stopping = threading.Thread(target=batcher.stop, daemon=True)
    try:
        batcher.add(1)
        assert entered.wait(2)
        stopping.start()
        with batcher._condition:
            assert batcher._condition.wait_for(lambda: batcher._stopped, 2)
        restart.set()
        assert callback_done.wait(2)
        stopping.join(2)
        assert not stopping.is_alive()
        assert batcher._thread is None
    finally:
        restart.set()
        if stopping.ident is not None:
            stopping.join(2)
        if not stopping.is_alive():
            batcher.stop()
