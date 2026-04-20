from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol

from .base import Document, Retriever


class MemoryFnClient(Protocol):
    async def search(self, query: str, options: Optional[Dict[str, Any]] = None) -> List[Document]: ...


class MemoryFnRetriever(Retriever):
    def __init__(self, client: Any, *, k: int = 4, filter: Optional[Dict[str, Any]] = None):
        self._client = client
        self._k = k
        self._filter = filter

    async def get_relevant_documents(self, query: str, *, k: int = 4, filter: Optional[Dict[str, Any]] = None) -> List[Document]:
        request = {"k": self._k if k == 4 else k, "filter": filter if filter is not None else self._filter}
        if hasattr(self._client, "search"):
            results = await self._client.search(query, request)
        else:
            results = await self._client.retrieve(query, request)
        limit = request["k"] or 4
        ordered = sorted(results, key=lambda document: (-(document.score or 0), document.content))
        return [
            Document(content=document.content, metadata=dict(document.metadata), score=document.score)
            for document in ordered[:limit]
        ]
