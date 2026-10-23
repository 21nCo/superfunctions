from memoryfn.core.config import Config
from memoryfn.core.types import AddMemoryInput, SearchMemoryInput, SearchMemoryResult, Memory
from memoryfn.storage.postgres import PostgresAdapter
from memoryfn.providers.openai import OpenAIProvider
from memoryfn.extraction.facts import FactExtractor
import time

class MemoryFn:
    def __init__(self, config: Config):
        self.config = config
        self.storage = PostgresAdapter(config.storage_url)
        self.provider = None
        self.extractor = None
        
        if config.openai_api_key:
            self.provider = OpenAIProvider(
                api_key=config.openai_api_key,
                embedding_model=config.embedding_model,
                llm_model=config.openai_model
            )
            self.extractor = FactExtractor(self.provider)

    async def add(self, input: AddMemoryInput) -> List[Memory]:
        # 1. Normalize
        content = input.content
        memories_to_persist = []

        # 2. Extract
        if self.extractor:
            facts = await self.extractor.extract(content)
            if facts:
                for fact in facts:
                    memories_to_persist.append(Memory(
                        tenantId=input.tenant_id,
                        containerTags=input.container_tags + fact.get("tags", []),
                        type=fact.get("type", "conversational"),
                        content=fact.get("content"),
                        metadata={**input.metadata, "confidence": fact.get("confidence", 1.0)}
                    ))
            else:
                # Fallback
                memories_to_persist.append(Memory(
                    tenantId=input.tenant_id,
                    containerTags=input.container_tags,
                    type=input.type,
                    content=content,
                    metadata=input.metadata
                ))
        else:
            memories_to_persist.append(Memory(
                tenantId=input.tenant_id,
                containerTags=input.container_tags,
                type=input.type,
                content=content,
                metadata=input.metadata
            ))

        # 3. Embed
        if self.provider:
            texts = [m.content for m in memories_to_persist]
            embeddings = await self.provider.embed_batch(texts)
            for i, mem in enumerate(memories_to_persist):
                mem.embedding = embeddings[i]

        # 4. Persist
        saved = await self.storage.insert_memories(memories_to_persist)
        return saved

    async def search(self, input: SearchMemoryInput) -> SearchMemoryResult:
        embedding = []
        if self.provider:
            embedding = await self.provider.embed(input.q)
        else:
            # Mock or error
            embedding = [0.0] * self.config.embedding_dims

        results = await self.storage.search_vectors(
            embedding=embedding,
            container_tags=input.container_tags,
            top_k=input.limit,
            threshold=input.threshold
        )

        return SearchMemoryResult(
            results=results,
            totalFound=len(results)
        )
        
    async def close(self):
        await self.storage.close()
