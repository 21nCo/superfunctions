from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Document:
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    score: Optional[float] = None


class Embeddings(ABC):
    @abstractmethod
    async def embed_query(self, text: str) -> List[float]:
        """Embed a single query text."""
        ...

    @abstractmethod
    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Embed a list of document texts."""
        ...


class VectorStore(ABC):
    @abstractmethod
    async def add_documents(self, documents: List[Document]) -> None:
        """Add documents to the store."""
        ...

    @abstractmethod
    async def search(self, query: str, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        """Search for similar documents."""
        ...


class Retriever(ABC):
    @abstractmethod
    async def get_relevant_documents(self, query: str) -> List[Document]:
        """Retrieve relevant documents for a query."""
        ...
