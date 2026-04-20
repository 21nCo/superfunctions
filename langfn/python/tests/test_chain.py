import pytest

from langfn import ValidationError
from langfn.orchestration import Chain


@pytest.mark.asyncio
async def test_chain_sequential():
    chain = Chain.sequential([lambda x: _async(x + 1), lambda x: _async(x * 2)])
    assert await chain.run(3) == 8


@pytest.mark.asyncio
async def test_chain_parallel():
    chain = Chain.parallel([lambda x: _async(x + 1), lambda x: _async(x * 2)], concurrency=1)
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


@pytest.mark.asyncio
async def test_chain_map_reduce_preserves_order():
    chain = Chain.map_reduce(
        map=lambda value: _async(value.upper()),
        reduce=lambda values: _async("|".join(values)),
        concurrency=1,
    )
    assert await chain.run(["a", "b"]) == "A|B"


@pytest.mark.asyncio
async def test_chain_router_unknown_route_raises_validation_error():
    chain = Chain.router(
        routes={"a": lambda x: _async(f"a:{x}")},
        router=lambda _x: _async("unknown"),
    )
    with pytest.raises(ValidationError) as error:
        await chain.run(1)
    assert error.value.code == "VALIDATION_ERROR"


async def _async(value):
    return value
