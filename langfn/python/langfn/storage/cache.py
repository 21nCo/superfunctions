from __future__ import annotations

import time
from typing import Any, Dict, Optional

from superfunctions.db import Adapter, DeleteParams, FindOneParams, UpsertParams, WhereClause

from ..utils.cache_keys import (
    create_chat_cache_key,
    create_completion_cache_key,
    create_embedding_cache_key,
    create_retriever_cache_key,
)


class ResponseCache:
    def __init__(self, db: Adapter, ttl: int = 3600, *, namespace: Optional[str] = None, key_prefix: str = "langfn"):
        self._db = db
        self._ttl = ttl
        self._table_name = "langfn_cache"
        self._namespace = namespace
        self._key_prefix = key_prefix

    def build_completion_key(self, prompt: str, model: str, provider: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        return f"{self._key_prefix}:{create_completion_cache_key(provider=provider, model=model, prompt=prompt, metadata=metadata, namespace=self._namespace)}"

    def build_chat_key(self, messages: list[Any], model: str, provider: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        return f"{self._key_prefix}:{create_chat_cache_key(provider=provider, model=model, messages=messages, metadata=metadata, namespace=self._namespace)}"

    def build_embedding_key(self, inputs: list[str], model: str, provider: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        return f"{self._key_prefix}:{create_embedding_cache_key(provider=provider, model=model, inputs=inputs, metadata=metadata, namespace=self._namespace)}"

    def build_retriever_key(
        self,
        query: str,
        *,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        filter: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        return f"{self._key_prefix}:{create_retriever_cache_key(query=query, provider=provider, model=model, namespace=self._namespace, filter=filter, options=metadata)}"

    async def get(self, prompt: str, model: str, provider: str, metadata: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        key = self.build_completion_key(prompt, model, provider, metadata)
        record = await _find_one(self._db, FindOneParams(model=self._table_name, where=self._where_for_key(key)))
        
        if not record:
            return None
            
        expires_at = int(record.get("expires_at") or record.get("expiresAt") or 0)
        if expires_at < int(time.time()):
            await _delete(self._db, DeleteParams(model=self._table_name, where=self._where_for_key(key)))
            return None
            
        return record["value"]

    async def set(self, prompt: str, model: str, provider: str, value: Any, metadata: Optional[Dict[str, Any]] = None) -> None:
        key = self.build_completion_key(prompt, model, provider, metadata)
        now = int(time.time())
        expires_at = now + self._ttl
        data = {
            "key": key,
            "value": value,
            "expires_at": expires_at,
            "created_at": now,
            "namespace": self._namespace,
        }

        await _upsert(
            self._db,
            UpsertParams(
                model=self._table_name,
                where=self._where_for_key(key),
                create=data,
                update=data,
            ),
        )

    def _where_for_key(self, key: str) -> list[WhereClause]:
        where = [WhereClause(field="key", operator="eq", value=key)]
        if self._namespace is not None:
            where.append(WhereClause(field="namespace", operator="eq", value=self._namespace))
        return where


async def _find_one(db: Adapter, params: FindOneParams):
    method = getattr(db, "find_one")
    try:
        return await method(params)
    except TypeError:
        where = {clause.field: clause.value for clause in params.where}
        return await method(table=params.model, where=where)


async def _delete(db: Adapter, params: DeleteParams):
    method = getattr(db, "delete")
    try:
        return await method(params)
    except TypeError:
        where = {clause.field: clause.value for clause in params.where}
        return await method(table=params.model, where=where)


async def _upsert(db: Adapter, params: UpsertParams):
    method = getattr(db, "upsert")
    try:
        return await method(params)
    except TypeError:
        where = {clause.field: clause.value for clause in params.where}
        return await method(table=params.model, where=where, data={**params.create, **params.update})
