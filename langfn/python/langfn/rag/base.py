from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Document:
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    score: Optional[float] = None


@dataclass
class RetrievalOptions:
    k: int = 4
    filter: Optional[Dict[str, Any]] = None


def matches_retrieval_filter(metadata: Dict[str, Any], filter: Optional[Dict[str, Any]] = None) -> bool:
    if filter is None:
        return True
    return all(metadata.get(key) == value for key, value in filter.items())


def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    dot_product = sum(a * b for a, b in zip(v1, v2))
    magnitude1 = sum(a * a for a in v1) ** 0.5
    magnitude2 = sum(a * a for a in v2) ** 0.5
    if magnitude1 == 0 or magnitude2 == 0:
        return 0.0
    return dot_product / (magnitude1 * magnitude2)


class Embeddings(ABC):
    @abstractmethod
    async def embed_query(self, text: str) -> List[float]:
        ...

    @abstractmethod
    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        ...


class VectorStore(ABC):
    backend_type: str = "reference"

    @abstractmethod
    async def add_documents(self, documents: List[Document]) -> None:
        ...

    @abstractmethod
    async def search(self, query: str, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        ...

    def as_retriever(self, *, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> "Retriever":
        return VectorStoreRetriever(self, k=k, filter=filter)


class Retriever(ABC):
    @abstractmethod
    async def get_relevant_documents(self, query: str, *, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        ...


class VectorStoreRetriever(Retriever):
    def __init__(self, store: VectorStore, *, k: int = 4, filter: Optional[Dict[str, Any]] = None):
        self._store = store
        self._k = k
        self._filter = filter

    async def get_relevant_documents(self, query: str, *, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        resolved_k = k if k != 4 or self._k == 4 else self._k
        resolved_filter = filter if filter is not None else self._filter
        return await self._store.search(query, k=resolved_k, filter=resolved_filter)


@dataclass
class RetrievalResult:
    retrieved: List[Document]
    answer: str


class RetrievalChain:
    def __init__(
        self,
        *,
        retriever: Retriever,
        generator: Optional[Any] = None,
        lang: Optional[Any] = None,
    ):
        self._retriever = retriever
        self._generator = generator
        self._lang = lang

    async def retrieve(self, query: str, *, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        return await self._retriever.get_relevant_documents(query, k=k, filter=filter)

    async def run(self, query: str, *, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> RetrievalResult:
        documents = await self.retrieve(query, k=k, filter=filter)
        if self._generator is not None:
            result = self._generator({"query": query, "documents": documents})
            answer = await result if hasattr(result, "__await__") else result
            return RetrievalResult(retrieved=documents, answer=str(answer))
        if self._lang is not None:
            response = await self._lang.complete(
                "\n".join(["Question: " + query, "", "Context:", *[document.content for document in documents]])
            )
            return RetrievalResult(retrieved=documents, answer=response.content)
        return RetrievalResult(retrieved=documents, answer="\n".join(document.content for document in documents))
