from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional

from superfunctions.db import Adapter
from superfunctions.db import CreateManyParams, FindManyParams, WhereClause

from ..core.errors import NonProductionBackendError
from .base import Document, Embeddings, VectorStore, cosine_similarity, matches_retrieval_filter

IndexedSearch = Callable[[dict[str, Any]], Any]


class DbVectorStore(VectorStore):
    """
    Reference DB vector store. This fallback is intentionally non-production unless indexed search is delegated to the adapter.
    """

    def __init__(
        self,
        db: Adapter,
        embeddings: Embeddings,
        namespace: str = "default",
        *,
        mode: str = "reference",
        page_size: int = 64,
        max_scan: int = 512,
        indexed_search: Optional[IndexedSearch] = None,
    ):
        self._db = db
        self._embeddings = embeddings
        self._namespace = namespace
        self._table_name = "langfn_documents"
        self.backend_type = mode
        self._page_size = max(1, page_size)
        self._max_scan = max(self._page_size, max_scan)
        self._indexed_search = indexed_search

    async def add_documents(self, documents: List[Document]) -> None:
        texts = [document.content for document in documents]
        vectors = await self._embeddings.embed_documents(texts)
        payload = [
            {
                "content": document.content,
                "embedding": vectors[index],
                "metadata": dict(document.metadata),
                "namespace": self._namespace,
                "created_at": int(time.time() * 1000),
            }
            for index, document in enumerate(documents)
        ]
        await _create_many(
            self._db,
            CreateManyParams(model=self._table_name, data=payload),
        )

    async def search(
        self,
        query: str,
        k: int = 4,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[Document]:
        query_vector = await self._embeddings.embed_query(query)
        if self._indexed_search is not None:
            records = await self._indexed_search(
                {
                    "query": query,
                    "k": k,
                    "filter": filter,
                    "namespace": self._namespace,
                    "query_embedding": query_vector,
                }
            )
        else:
            records = await self._reference_search(query_vector, filter=filter, k=k)

        return [
            Document(content=record["content"], metadata=dict(record.get("metadata", {})), score=record.get("score"))
            for record in records[:k]
        ]

    async def _reference_search(
        self,
        query_vector: List[float],
        *,
        filter: Optional[Dict[str, Any]],
        k: int,
    ) -> List[Dict[str, Any]]:
        if self.backend_type == "production":
            raise NonProductionBackendError(
                "Production retrieval requires adapter-native indexed search or memoryfn",
                metadata={"backend": "db_vector_store"},
            )

        scored = []
        offset = 0
        while offset < self._max_scan:
            limit = min(self._page_size, self._max_scan - offset)
            records = await _find_many(
                self._db,
                FindManyParams(
                    model=self._table_name,
                    where=[WhereClause(field="namespace", operator="eq", value=self._namespace)],
                    limit=limit,
                    offset=offset,
                ),
            )
            if not records:
                break

            for index, record in enumerate(records):
                metadata = dict(record.get("metadata") or {})
                if not matches_retrieval_filter(metadata, filter):
                    continue
                scored.append(
                    {
                        **record,
                        "score": cosine_similarity(query_vector, record["embedding"]),
                        "created_at": record.get("created_at", offset + index),
                    }
                )

            offset += len(records)
            if len(records) < limit:
                break

        scored.sort(key=lambda item: (-item["score"], item["created_at"]))
        return scored[: max(k, 1)]


async def _create_many(db: Adapter, params: CreateManyParams):
    method = getattr(db, "create_many")
    try:
        return await method(params)
    except TypeError:
        return await method(table=params.model, data=params.data)


async def _find_many(db: Adapter, params: FindManyParams):
    method = getattr(db, "find_many")
    try:
        return await method(params)
    except TypeError:
        where = {clause.field: clause.value for clause in params.where or []}
        return await method(table=params.model, where=where, limit=params.limit, offset=params.offset)
