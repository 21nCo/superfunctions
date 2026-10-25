"""Monotonic observer lifecycle independently of storage operations."""
import asyncio
import time

from flowfn.core.lease_expiry import LeaseExpiry


async def test_expiry_is_irreversible_and_releases_timer() -> None:
    expired = asyncio.Event()
    observer = LeaseExpiry(time.monotonic() + .03, expired.set)
    await asyncio.wait_for(expired.wait(), .5)
    assert observer.expired
    assert not observer.renew(time.monotonic() + 10)
    assert observer._timer is None
    observer.close()


async def test_renewal_replaces_old_deadline_and_close_prevents_callback() -> None:
    expired = asyncio.Event()
    observer = LeaseExpiry(time.monotonic() + .1, expired.set)
    old_timer = observer._timer
    assert observer.renew(time.monotonic() + 10)
    assert old_timer is not None and old_timer.cancelled()
    observer.close()
    assert not observer.renew(time.monotonic() + 20)
    await asyncio.sleep(.12)
    assert not expired.is_set()
    assert observer._timer is None
