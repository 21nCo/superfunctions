import pytest

from langfn.orchestration import Chain


@pytest.mark.asyncio
async def test_chain_sequential():
    chain = Chain.sequential([lambda x: _async(x + 1), lambda x: _async(x * 2)])
    assert await chain.run(3) == 8


@pytest.mark.asyncio
async def test_chain_parallel():
    chain = Chain.parallel([lambda x: _async(x + 1), lambda x: _async(x * 2)])
    assert await chain.run(3) == [4, 6]


@pytest.mark.asyncio
async def test_chain_router():
    chain = Chain.router(
        routes={
            "a": lambda x: _async(f"a:{x}"),
            "b": lambda x: _async(f"b:{x}"),
        },
        router=lambda x: _async("b" if x > 0 else "a"),
    )
    assert await chain.run(1) == "b:1"


async def _async(value):
    return value

