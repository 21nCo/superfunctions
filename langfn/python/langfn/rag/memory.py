from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .base import Document, Embeddings, VectorStore


class InMemoryVectorStore(VectorStore):
    def __init__(self, embeddings: Embeddings):
        self.embeddings = embeddings
        self.documents: List[Document] = []
        self.vectors: List[List[float]] = []

    async def add_documents(self, documents: List[Document]) -> None:
        texts = [doc.content for doc in documents]
        vectors = await self.embeddings.embed_documents(texts)
        self.documents.extend(documents)
        self.vectors.extend(vectors)

    async def search(self, query: str, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        query_vector = await self.embeddings.embed_query(query)
        
        scores = []
        for i, doc_vector in enumerate(self.vectors):
            # Simple cosine similarity
            score = self._cosine_similarity(query_vector, doc_vector)
            
            # Apply filter if provided
            if filter:
                match = True
                for key, value in filter.items():
                    if self.documents[i].metadata.get(key) != value:
                        match = False
                        break
                if not match:
                    continue
            
            scores.append((score, self.documents[i]))
        
        # Sort by score descending
        scores.sort(key=lambda x: x[0], reverse=True)
        
        results = []
        for score, doc in scores[:k]:
            # Create a copy with score
            results.append(Document(content=doc.content, metadata=doc.metadata, score=score))
        
        return results

    def _cosine_similarity(self, v1: List[float], v2: List[float]) -> float:
        dot_product = sum(a * b for a, b in zip(v1, v2))
        magnitude1 = math.sqrt(sum(a * a for a in v1))
        magnitude2 = math.sqrt(sum(a * a for a in v2))
        if magnitude1 == 0 or magnitude2 == 0:
            return 0.0
        return dot_product / (magnitude1 * magnitude2)
