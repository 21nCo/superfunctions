import asyncio

import pytest

from flowfn.core.owned_wait import wait_for_owned


@pytest.mark.asyncio
async def test_result_and_provider_error_preserved() -> None:
    async def value() -> int:
        return 42

    failure = ValueError('provider failure')

    async def fail() -> int:
        raise failure

    assert await wait_for_owned(value(), 1) == 42
    with pytest.raises(ValueError) as caught:
        await wait_for_owned(fail(), 1)
    assert caught.value is failure


@pytest.mark.asyncio
@pytest.mark.parametrize('deadline', [False, True])
async def test_cancellation_joins_provider_cleanup(deadline: bool) -> None:
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    release = asyncio.Event()
    terminated = asyncio.Event()
    late_failure = ValueError('cleanup failed')

    async def provider() -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue
            terminated.set()
            if not deadline:
                raise late_failure from None
            raise

    observed_causes: list[BaseException] = []

    async def own() -> None:
        try:
            await wait_for_owned(provider(), .01 if deadline else 10)
        except asyncio.CancelledError as error:
            if error.__cause__ is not None:
                observed_causes.append(error.__cause__)
            raise

    owner = asyncio.create_task(own())
    await entered.wait()
    if not deadline:
        owner.cancel()
    await asyncio.wait_for(cancelled.wait(), 1)
    if not deadline:
        owner.cancel()
    await asyncio.sleep(0)
    assert not owner.done()
    release.set()
    if deadline:
        with pytest.raises(asyncio.TimeoutError):
            await owner
    else:
        with pytest.raises(asyncio.CancelledError):
            await owner
        # Python 3.9 Task.result replaces CancelledError, so inspect the cause
        # at the owning coroutine boundary before Task cancellation wrapping.
        assert observed_causes == [late_failure]
    assert terminated.is_set()
