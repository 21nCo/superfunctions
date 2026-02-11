from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import hashlib
import secrets
import base64
from pydantic import BaseModel

from superfunctions.db import Adapter
from ..protocols import StorageAdapter
from ..models import FileProviderContext, FileRecord, FileVersionRecord, FileShareRecord
from .. import errors

class CreateShareLinkInput(BaseModel):
    fileId: str
    versionId: Optional[str] = None
    expiresAt: Optional[str] = None
    requiresAuth: Optional[bool] = None
    maxDownloads: Optional[int] = None

class SharesServiceConfig(BaseModel):
    db: Any # Adapter
    storage: Any # StorageAdapter
    namespace: str = 'filefn'
    signed_url_ttl_seconds: int = 900
    
    class Config:
        arbitrary_types_allowed = True

class SharesService:
    def __init__(self, config: SharesServiceConfig):
        self.db = config.db
        self.storage = config.storage
        self.namespace = config.namespace
        self.signed_url_ttl_seconds = config.signed_url_ttl_seconds

    def _hash_token(self, token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def _generate_token(self) -> str:
        return secrets.token_urlsafe(32)

    async def _get_file(self, file_id: str) -> Optional[FileRecord]:
        data = await self.db.find_one(
            model='files',
            where=[{'field': 'fileId', 'operator': 'eq', 'value': file_id}],
            namespace=self.namespace
        )
        return FileRecord(**data) if data else None

    async def _can_share_file(self, file: FileRecord, ctx: FileProviderContext) -> bool:
        return file.ownerId == ctx.principalId

    async def create_share_link(self, input: CreateShareLinkInput, ctx: FileProviderContext) -> Dict[str, Any]:
        file = await self._get_file(input.fileId)
        if not file:
            raise errors.not_found('File')

        if not await self._can_share_file(file, ctx):
            raise errors.forbidden()

        token = self._generate_token()
        token_hash = self._hash_token(token)

        share = FileShareRecord(
            tokenHash=token_hash,
            fileId=input.fileId,
            versionId=input.versionId,
            expiresAt=input.expiresAt,
            requiresAuth=input.requiresAuth if input.requiresAuth is not None else False,
            maxDownloads=input.maxDownloads,
            downloads=0,
            createdAt=datetime.now(timezone.utc).isoformat(),
            revokedAt=None
        )

        await self.db.create(
            model='fileShares',
            data=share.model_dump(),
            namespace=self.namespace
        )

        return {'token': token, 'expiresAt': share.expiresAt}

    async def download_via_share_link(self, token: str, ctx: FileProviderContext, is_authenticated: bool = False) -> Dict[str, Any]:
        token_hash = self._hash_token(token)

        data = await self.db.find_one(
            model='fileShares',
            where=[{'field': 'tokenHash', 'operator': 'eq', 'value': token_hash}],
            namespace=self.namespace
        )

        if not data:
            raise errors.share_not_found()
        
        share = FileShareRecord(**data)

        if share.revokedAt:
            raise errors.share_revoked()

        now = datetime.now(timezone.utc).isoformat()
        if share.expiresAt and share.expiresAt < now:
            raise errors.share_expired()

        if share.maxDownloads is not None and share.downloads >= share.maxDownloads:
            raise errors.share_downloads_exceeded()

        if share.requiresAuth and not is_authenticated:
            raise errors.auth_required()

        file = await self._get_file(share.fileId)
        if not file:
            raise errors.share_not_found()

        version_id = share.versionId or file.currentVersionId
        version_data = await self.db.find_one(
            model='fileVersions',
            where=[{'field': 'versionId', 'operator': 'eq', 'value': version_id}],
            namespace=self.namespace
        )

        if not version_data:
            raise errors.not_found('Version')
        
        version = FileVersionRecord(**version_data)

        # Increment downloads
        await self.db.update(
            model='fileShares',
            where=[{'field': 'tokenHash', 'operator': 'eq', 'value': token_hash}],
            data={'downloads': share.downloads + 1},
            namespace=self.namespace
        )

        if hasattr(self.storage, 'sign_download_url'):
            result = await self.storage.sign_download_url(
                key=version.storageKey,
                expires_in_seconds=self.signed_url_ttl_seconds
            )
            return {'url': result['url'], 'headers': result.get('headers'), 'fileName': file.name, 'mimeType': file.mimeType}

        return {'url': f"proxy://{version.storageKey}", 'fileName': file.name, 'mimeType': file.mimeType}

    async def revoke_share_link(self, file_id: str, token: str, ctx: FileProviderContext) -> None:
        file = await self._get_file(file_id)
        if not file:
            raise errors.not_found('File')

        if not await self._can_share_file(file, ctx):
            raise errors.forbidden()

        token_hash = self._hash_token(token)

        share = await self.db.find_one(
            model='fileShares',
            where=[
                {'field': 'tokenHash', 'operator': 'eq', 'value': token_hash},
                {'field': 'fileId', 'operator': 'eq', 'value': file_id}
            ],
            namespace=self.namespace
        )

        if not share:
            raise errors.share_not_found()

        await self.db.update(
            model='fileShares',
            where=[{'field': 'tokenHash', 'operator': 'eq', 'value': token_hash}],
            data={'revokedAt': datetime.now(timezone.utc).isoformat()},
            namespace=self.namespace
        )

    async def list_share_links(self, file_id: str, ctx: FileProviderContext) -> List[Dict[str, Any]]:
        file = await self._get_file(file_id)
        if not file:
            raise errors.not_found('File')

        if not await self._can_share_file(file, ctx):
            raise errors.forbidden()

        shares_data = await self.db.find_many(
            model='fileShares',
            where=[{'field': 'fileId', 'operator': 'eq', 'value': file_id}],
            namespace=self.namespace
        )
        
        result = []
        for s in shares_data:
            share = FileShareRecord(**s)
            res = share.model_dump()
            res.pop('tokenHash')
            res['tokenHashPrefix'] = share.tokenHash[:8]
            result.append(res)
            
        return result

def create_shares_service(config: SharesServiceConfig) -> SharesService:
    return SharesService(config)
