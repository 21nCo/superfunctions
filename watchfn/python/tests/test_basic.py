import pytest
from watchfn import watch_fn

def test_watch_fn_init():
    watch = watch_fn(name="test-app")
    assert watch.config.name == "test-app"

def test_watch_fn_track():
    watch = watch_fn(name="test-app")
    watch.start()
    watch.track("test.event", {"foo": "bar"})
    
    events = watch.query(metric="test.event")
    assert len(events) == 1
    assert events[0].properties["foo"] == "bar"
    watch.stop()

def test_watch_fn_error():
    watch = watch_fn(name="test-app")
    watch.start()
    try:
        raise ValueError("test error")
    except Exception as e:
        watch.capture_exception(e)
    
    events = watch.query()
    error_events = [e for e in events if e.type == "error"]
    assert len(error_events) == 1
    assert error_events[0].properties["class"] == "ValueError"
    watch.stop()
