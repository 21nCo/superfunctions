import hashlib
import base64
from typing import Any, Optional, AsyncGenerator, Dict, Protocol
from pydantic import BaseModel
from superfunctions.db import Adapter

class DeduplicationServiceConfig(BaseModel):
    db: Any # Adapter
    namespace: str = 'filefn'
    enabled: bool = True
    
    class Config:
        arbitrary_types_allowed = True

class DeduplicationResult(BaseModel):
    isDuplicate: bool
    existingVersionId: Optional[str] = None
    existingStorageKey: Optional[str] = None
    checksumSha256Base64: str

class DeduplicationService:
    def __init__(self, config: DeduplicationServiceConfig):
        self.db = config.db
        self.namespace = config.namespace
        self.enabled = config.enabled

    def is_enabled(self) -> bool:
        return self.enabled

    def compute_hash(self, data: bytes) -> str:
        sha256 = hashlib.sha256()
        sha256.update(data)
        return base64.b64encode(sha256.digest()).decode('utf-8')

    async def compute_hash_from_stream(self, stream: AsyncGenerator[bytes, None]) -> str:
        sha256 = hashlib.sha256()
        async for chunk in stream:
            sha256.update(chunk)
        return base64.b64encode(sha256.digest()).decode('utf-8')

    async def check_for_duplicate(self, checksum_sha256_base64: str, tenant_id: Optional[str]) -> DeduplicationResult:
        if not self.enabled:
            return DeduplicationResult(
                isDuplicate=False,
                checksumSha256Base64=checksum_sha256_base64
            )

        where_conditions = [
            {'field': 'checksumSha256Base64', 'operator': 'eq', 'value': checksum_sha256_base64}
        ]

        if tenant_id:
            where_conditions.append({'field': 'tenantId', 'operator': 'eq', 'value': tenant_id})
        else:
             where_conditions.append({'field': 'tenantId', 'operator': 'eq', 'value': None})

        existing_version = await self.db.find_one(
            model='fileVersions',
            where=where_conditions,
            namespace=self.namespace
        )

        if existing_version:
            return DeduplicationResult(
                isDuplicate=True,
                existingVersionId=existing_version.get('versionId'),
                existingStorageKey=existing_version.get('storageKey'),
                checksumSha256Base64=checksum_sha256_base64
            )

        return DeduplicationResult(
            isDuplicate=False,
            checksumSha256Base64=checksum_sha256_base64
        )

    async def compute_and_check_duplicate(self, storage_key: str, tenant_id: Optional[str], storage: Any) -> DeduplicationResult:
        if not self.enabled:
             return DeduplicationResult(
                isDuplicate=False,
                checksumSha256Base64=''
            )

        if not hasattr(storage, 'open_download_stream'):
            raise Exception('Storage adapter does not support streaming downloads required for deduplication')

        stream = await storage.open_download_stream(key=storage_key)
        checksum = await self.compute_hash_from_stream(stream)
        
        return await self.check_for_duplicate(checksum, tenant_id)

    async def verify_hash(self, storage_key: str, expected_hash: str, storage: Any) -> bool:
        if not hasattr(storage, 'open_download_stream'):
            return False
            
        stream = await storage.open_download_stream(key=storage_key)
        actual_hash = await self.compute_hash_from_stream(stream)
        
        return actual_hash == expected_hash

def create_deduplication_service(config: DeduplicationServiceConfig) -> DeduplicationService:
    return DeduplicationService(config)
