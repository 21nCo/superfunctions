from __future__ import annotations

import math
import time
from typing import Any, Dict, List, Optional

from superfunctions.db import Adapter
from .base import Document, Embeddings, VectorStore


class DbVectorStore(VectorStore):
    def __init__(
        self,
        db: Adapter,
        embeddings: Embeddings,
        namespace: str = "default",
    ):
        self._db = db
        self._embeddings = embeddings
        self._namespace = namespace
        self._table_name = "langfn_documents"

    async def add_documents(self, documents: List[Document]) -> None:
        texts = [doc.content for doc in documents]
        vectors = await self._embeddings.embed_documents(texts)

        records = []
        for i, doc in enumerate(documents):
            records.append({
                "content": doc.content,
                "embedding": vectors[i],
                "metadata": doc.metadata,
                "namespace": self._namespace,
                "created_at": int(time.time() * 1000),
            })

        await self._db.create_many(
            table=self._table_name,
            data=records,
        )

    async def search(
        self,
        query: str,
        k: int = 4,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[Document]:
        where = {"namespace": self._namespace}
        if filter:
            where.update(filter)

        # Candidate retrieval
        records = await self._db.find_many(
            table=self._table_name,
            where=where,
            limit=100,
        )

        if not records:
            return []

        query_vector = await self._embeddings.embed_query(query)
        
        scored = []
        for record in records:
            score = self._cosine_similarity(query_vector, record["embedding"])
            scored.append((score, record))

        scored.sort(key=lambda x: x[0], reverse=True)

        results = []
        for score, record in scored[:k]:
            results.append(Document(
                content=record["content"],
                metadata=record["metadata"],
                score=score,
            ))

        return results

    def _cosine_similarity(self, v1: List[float], v2: List[float]) -> float:
        dot_product = sum(a * b for a, b in zip(v1, v2))
        magnitude1 = math.sqrt(sum(a * a for a in v1))
        magnitude2 = math.sqrt(sum(a * a for a in v2))
        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0
        return dot_product / (magnitude1 * magnitude2)
