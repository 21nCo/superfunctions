import pytest
from unittest.mock import AsyncMock, MagicMock
from memoryfn.core.pipeline import MemoryFn
from memoryfn.core.config import Config
from memoryfn.core.types import AddMemoryInput, SearchMemoryInput, Memory

@pytest.mark.asyncio
async def test_memoryfn_pipeline():
    # Mock Config
    config = Config(
        storageUrl="postgresql://mock:mock@localhost:5432/mock",
        openaiApiKey="mock-key"
    )

    # Mock Storage
    mock_storage = AsyncMock()
    mock_storage.insert_memories.return_value = [
        Memory(id="1", content="Test content", type="conversational")
    ]
    mock_storage.search_vectors.return_value = [
        Memory(id="1", content="Test content", type="conversational")
    ]

    # Mock Provider
    mock_provider = AsyncMock()
    mock_provider.embed.return_value = [0.1] * 1536
    mock_provider.embed_batch.return_value = [[0.1] * 1536]
    mock_provider.generate_json.return_value = {"facts": [{"content": "Test content", "type": "conversational", "confidence": 0.9}]}

    # Initialize MemoryFn and inject mocks
    memory = MemoryFn(config)
    memory.storage = mock_storage
    memory.provider = mock_provider
    memory.extractor.provider = mock_provider # type: ignore

    # Test Add
    input_data = AddMemoryInput(
        content="Test content",
        containerTags=["user:test"],
        tenantId="test-tenant"
    )
    result = await memory.add(input_data)
    
    assert len(result) == 1
    assert result[0].content == "Test content"
    mock_storage.insert_memories.assert_called_once()
    mock_provider.embed_batch.assert_called_once()

    # Test Search
    search_input = SearchMemoryInput(
        q="query",
        containerTags=["user:test"]
    )
    search_result = await memory.search(search_input)
    
    assert len(search_result.results) == 1
    assert search_result.total_found == 1
    mock_storage.search_vectors.assert_called_once()
