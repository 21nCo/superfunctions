from __future__ import annotations

from typing import Any, Dict, List, Optional

from .base import Document, Embeddings, VectorStore, cosine_similarity, matches_retrieval_filter


class InMemoryVectorStore(VectorStore):
    """
    Reference-only vector store for local examples and tests.
    This backend is intentionally non-production and uses application-side reranking.
    """

    backend_type = "reference"

    def __init__(self, embeddings: Embeddings):
        self.embeddings = embeddings
        self.documents: List[Document] = []
        self.vectors: List[List[float]] = []

    async def add_documents(self, documents: List[Document]) -> None:
        texts = [document.content for document in documents]
        vectors = await self.embeddings.embed_documents(texts)
        self.documents.extend(Document(content=document.content, metadata=dict(document.metadata), score=document.score) for document in documents)
        self.vectors.extend(vectors)

    async def search(self, query: str, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        query_vector = await self.embeddings.embed_query(query)
        scores = []
        for index, doc_vector in enumerate(self.vectors):
            document = self.documents[index]
            if not matches_retrieval_filter(document.metadata, filter):
                continue
            scores.append((cosine_similarity(query_vector, doc_vector), index, document))

        scores.sort(key=lambda item: (-item[0], item[1]))
        return [
            Document(content=document.content, metadata=dict(document.metadata), score=score)
            for score, _index, document in scores[:k]
        ]
