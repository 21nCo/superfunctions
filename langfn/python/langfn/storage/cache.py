from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional

from superfunctions.db import Adapter


class ResponseCache:
    def __init__(self, db: Adapter, ttl: int = 3600):
        self._db = db
        self._ttl = ttl
        self._table_name = "langfn_cache"

    def _generate_key(self, prompt: str, model: str, provider: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        # Simple key generation. In a real app, this might be a hash.
        import hashlib
        key_content = f"{provider}:{model}:{prompt}:{json.dumps(metadata or {}, sort_keys=True)}"
        return hashlib.sha256(key_content.encode()).hexdigest()

    async def get(self, prompt: str, model: str, provider: str, metadata: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        key = self._generate_key(prompt, model, provider, metadata)
        record = await self._db.find_one(
            table=self._table_name,
            where={"key": key}
        )
        
        if not record:
            return None
            
        if record["expires_at"] < int(time.time()):
            await self._db.delete(table=self._table_name, where={"key": key})
            return None
            
        return record["value"]

    async def set(self, prompt: str, model: str, provider: str, value: Any, metadata: Optional[Dict[str, Any]] = None) -> None:
        key = self._generate_key(prompt, model, provider, metadata)
        expires_at = int(time.time()) + self._ttl
        
        await self._db.upsert(
            table=self._table_name,
            where={"key": key},
            data={
                "key": key,
                "value": value,
                "expires_at": expires_at,
                "created_at": int(time.time())
            }
        )
