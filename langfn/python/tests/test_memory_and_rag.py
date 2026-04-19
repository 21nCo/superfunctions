import pytest

from langfn import LangFn, NonProductionBackendError, ValidationError
from langfn.memory import BufferMemory, SummaryMemory
from langfn.models import MockChatModel
from langfn.rag import DbVectorStore, Document, InMemoryVectorStore, MemoryFnRetriever


class FakeEmbeddings:
    async def embed_query(self, text: str):
        return _vectorize(text)

    async def embed_documents(self, texts):
        return [_vectorize(text) for text in texts]


@pytest.mark.asyncio
async def test_buffer_memory_retains_newest_entries_and_clears():
    memory = BufferMemory(max_messages=2)
    await memory.extend(
        [
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ]
    )
    assert await memory.get() == [
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
    ]
    await memory.clear()
    assert await memory.get() == []

    with pytest.raises(ValidationError) as error:
        BufferMemory(max_messages=-1)
    assert error.value.code == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_summary_memory_rolls_older_messages_deterministically():
    async def summarizer(payload):
        lines = [payload["existing_summary"]] if payload["existing_summary"] else []
        lines.extend(f"{message['role']}:{message['content']}" for message in payload["messages"])
        return "|".join(lines)

    memory = SummaryMemory(max_messages=2, summarizer=summarizer)
    await memory.extend(
        [
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "two"},
            {"role": "user", "content": "three"},
        ]
    )
    assert memory.get_summary() == "user:one"
    assert await memory.get() == [
        {"role": "system", "content": "Previous conversation summary: user:one"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
    ]
    await memory.clear()
    assert memory.get_summary() is None
    assert await memory.get() == []


@pytest.mark.asyncio
async def test_rag_memoryfn_adapter_and_chain_surface():
    store = InMemoryVectorStore(FakeEmbeddings())
    await store.add_documents(
        [
            Document(content="Paris is the capital of France.", metadata={"source": "wiki"}),
            Document(content="Berlin is the capital of Germany.", metadata={"source": "wiki"}),
        ]
    )
    retrieved = await store.as_retriever(k=1, filter={"source": "wiki"}).get_relevant_documents("Tell me about Paris")
    assert retrieved[0].content == "Paris is the capital of France."

    class MemoryFnClient:
        async def search(self, _query, _options=None):
            return [
                Document(content="Rome is in Italy.", metadata={"source": "wiki"}, score=0.1),
                Document(content="Paris is the capital of France.", metadata={"source": "wiki"}, score=0.9),
            ]

    retriever = MemoryFnRetriever(MemoryFnClient(), k=1)
    chain = LangFn(model=MockChatModel(responses=["unused"])).create_rag_chain(
        retriever=retriever,
        generator=lambda payload: payload["documents"][0].content,
    )
    result = await chain.run("Tell me about Paris")
    assert result.retrieved[0].content == "Paris is the capital of France."
    assert "capital of France" in result.answer


@pytest.mark.asyncio
async def test_db_vector_store_blocks_reference_reranking_in_production_mode():
    class FakeDb:
        async def create_many(self, **_kwargs):
            return None

        async def find_many(self, **_kwargs):
            return [
                {
                    "content": "Paris is the capital of France.",
                    "embedding": _vectorize("Paris is the capital of France."),
                    "metadata": {"source": "wiki"},
                    "namespace": "default",
                    "created_at": 1,
                }
            ]

    reference_store = DbVectorStore(FakeDb(), FakeEmbeddings(), mode="reference")
    assert len(await reference_store.search("Tell me about Paris", k=1)) == 1

    production_store = DbVectorStore(FakeDb(), FakeEmbeddings(), mode="production")
    with pytest.raises(NonProductionBackendError) as error:
        await production_store.search("Tell me about Paris", k=1)
    assert error.value.code == "NON_PRODUCTION_BACKEND"


def _vectorize(text: str):
    lowered = text.lower()
    return [1.0 if "paris" in lowered else 0.0, float(len(lowered))]
