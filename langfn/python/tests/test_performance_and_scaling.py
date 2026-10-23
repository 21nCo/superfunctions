import pytest

from langfn.models.transport import get_async_client
from langfn.rag import DbVectorStore
from langfn.utils.cache_keys import (
    create_chat_cache_key,
    create_completion_cache_key,
    create_embedding_cache_key,
    create_retriever_cache_key,
)
from langfn.utils.concurrency import map_with_concurrency


class FakeEmbeddings:
    async def embed_query(self, text: str):
        return _vectorize(text)

    async def embed_documents(self, texts):
        return [_vectorize(text) for text in texts]


@pytest.mark.asyncio
async def test_transport_clients_are_reused_for_equivalent_configs():
    left = get_async_client(
        base_url="https://api.example.com/",
        headers={"b": "2", "a": "1"},
        timeout=30.0,
    )
    right = get_async_client(
        base_url="https://api.example.com",
        headers={"a": "1", "b": "2"},
        timeout=30.0,
    )

    assert left is right


def test_cache_keys_are_stable_across_metadata_ordering():
    assert create_completion_cache_key(
        provider="openai",
        model="gpt-4o-mini",
        prompt="hello",
        metadata={"z": 1, "a": {"y": True, "x": 1}},
    ) == create_completion_cache_key(
        provider="openai",
        model="gpt-4o-mini",
        prompt="hello",
        metadata={"a": {"x": 1, "y": True}, "z": 1},
    )
    assert create_chat_cache_key(
        provider="openai",
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
        metadata={"nested": {"b": 2, "a": 1}},
    )
    assert create_embedding_cache_key(
        provider="openai",
        model="text-embedding-3-small",
        inputs=["a", "b"],
    )
    assert create_retriever_cache_key(
        query="paris",
        namespace="docs",
        filter={"source": "wiki"},
        options={"k": 4},
    )


@pytest.mark.asyncio
async def test_map_with_concurrency_preserves_order_and_limit():
    active = 0
    peak = 0

    async def mapper(delay_ms: int, index: int) -> int:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await __import__("asyncio").sleep(delay_ms / 1000)
        active -= 1
        return index

    results = await map_with_concurrency(2, [30, 10, 20], mapper)

    assert peak <= 2
    assert results == [0, 1, 2]


@pytest.mark.asyncio
async def test_db_vector_store_pages_beyond_first_hundred_rows():
    offsets = []
    records = [
        {
            "id": f"doc-{index}",
            "content": "Paris is the capital of France." if index == 120 else f"filler-{index}",
            "embedding": _vectorize("Paris is the capital of France." if index == 120 else f"filler-{index}"),
            "metadata": {"source": "wiki"},
            "namespace": "default",
            "created_at": index,
        }
        for index in range(140)
    ]

    class FakeDb:
        async def create_many(self, *_args, **_kwargs):
            return []

        async def find_many(self, params=None, **kwargs):
            if params is not None:
                limit = params.limit or len(records)
                offset = params.offset or 0
            else:
                limit = kwargs.get("limit", len(records))
                offset = kwargs.get("offset", 0)
            offsets.append(offset)
            return records[offset : offset + limit]

    store = DbVectorStore(FakeDb(), FakeEmbeddings(), mode="reference", page_size=50, max_scan=150)
    results = await store.search("Tell me about Paris", k=1, filter={"source": "wiki"})

    assert offsets == [0, 50, 100]
    assert results[0].content == "Paris is the capital of France."


def _vectorize(text: str):
    lowered = text.lower()
    return [1.0 if "paris" in lowered else 0.0, float(len(lowered))]
