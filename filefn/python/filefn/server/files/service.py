from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel

from .. import errors
from ..events import FileFnEventEmitter, create_file_deleted_event
from ..models import FileProviderContext, FileRecord, FileVersionRecord, Visibility


class Authorizer(Protocol):
    async def can_read(self, file: FileRecord, ctx: FileProviderContext) -> bool: ...

    async def can_write(self, file: FileRecord, ctx: FileProviderContext) -> bool: ...

    async def can_delete(self, file: FileRecord, ctx: FileProviderContext) -> bool: ...


class DefaultAuthorizer:
    async def can_read(self, file: FileRecord, ctx: FileProviderContext) -> bool:
        if file.visibility == Visibility.PUBLIC:
            return True
        if file.ownerId == ctx.principalId:
            return True
        if file.visibility == Visibility.SHARED and file.tenantId and file.tenantId == ctx.tenantId:
            return True
        return False

    async def can_write(self, file: FileRecord, ctx: FileProviderContext) -> bool:
        return file.ownerId == ctx.principalId

    async def can_delete(self, file: FileRecord, ctx: FileProviderContext) -> bool:
        return file.ownerId == ctx.principalId


class QuotaProvider(Protocol):
    async def record_usage(self, input: Dict[str, Any]) -> None: ...


class FileServiceConfig(BaseModel):
    db: Any
    storage: Any
    events: FileFnEventEmitter
    logger: Optional[Any] = None
    quota: Optional[Any] = None
    authorizer: Optional[Any] = None
    namespace: str = "filefn"
    signed_url_ttl_seconds: int = 900

    class Config:
        arbitrary_types_allowed = True


class FileService:
    def __init__(self, config: FileServiceConfig):
        self.db = config.db
        self.storage = config.storage
        self.events = config.events
        self.logger = config.logger
        self.quota = config.quota
        self.authorizer = config.authorizer or DefaultAuthorizer()
        self.namespace = config.namespace
        self.signed_url_ttl_seconds = config.signed_url_ttl_seconds

    async def _get_file_record(self, file_id: str) -> FileRecord:
        file_data = await self.db.find_one(
            model="files",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )
        if not file_data:
            raise errors.not_found("File")
        return FileRecord(**file_data)

    async def _get_bound_version(self, file_id: str, version_id: str) -> FileVersionRecord:
        version_data = await self.db.find_one(
            model="fileVersions",
            where=[{"field": "versionId", "operator": "eq", "value": version_id}],
            namespace=self.namespace,
        )
        if not version_data:
            raise errors.not_found("Version")

        version = FileVersionRecord(**version_data)
        if version.fileId != file_id:
            raise errors.not_found("Version")
        return version

    async def get_file(
        self,
        file_id: str,
        ctx: FileProviderContext,
        version_id: Optional[str] = None,
    ) -> FileRecord:
        file = await self._get_file_record(file_id)

        if not await self.authorizer.can_read(file, ctx):
            raise errors.forbidden()

        if version_id:
            await self._get_bound_version(file_id, version_id)

        return file

    async def list_files(
        self,
        ctx: FileProviderContext,
        options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        options = options or {}
        limit = options.get("limit", 20)

        all_files_data = await self.db.find_many(
            model="files",
            where=[],
            limit=1000,
            namespace=self.namespace,
        )
        all_files = [FileRecord(**item) for item in all_files_data]

        granted_file_ids = set()
        if ctx.principalId:
            grants = await self.db.find_many(
                model="filePermissions",
                where=[],
                namespace=self.namespace,
            )
            for grant in grants:
                if not grant.get("canRead"):
                    continue
                if grant.get("userId") == ctx.principalId:
                    granted_file_ids.add(grant.get("fileId"))
                elif grant.get("tenantId") and grant.get("tenantId") == ctx.tenantId:
                    granted_file_ids.add(grant.get("fileId"))

        accessible_files: List[FileRecord] = []
        for file in all_files:
            if ctx.principalId and file.ownerId == ctx.principalId:
                accessible_files.append(file)
                continue
            if file.visibility == Visibility.PUBLIC:
                accessible_files.append(file)
                continue
            if file.visibility == Visibility.SHARED and file.tenantId and ctx.tenantId and file.tenantId == ctx.tenantId:
                accessible_files.append(file)
                continue
            if file.fileId in granted_file_ids:
                accessible_files.append(file)

        has_more = len(accessible_files) > limit
        result_files = accessible_files[:limit]
        next_cursor = result_files[-1].fileId if has_more and result_files else None

        return {"files": [f.model_dump() for f in result_files], "nextCursor": next_cursor}

    async def get_download_url(
        self,
        file_id: str,
        version_id: Optional[str],
        ctx: FileProviderContext,
    ) -> Dict[str, Any]:
        file = await self.get_file(file_id, ctx)

        target_version_id = version_id or file.currentVersionId
        version = await self._get_bound_version(file_id, target_version_id)

        if hasattr(self.storage, "sign_download_url"):
            try:
                result = await self.storage.sign_download_url(
                    key=version.storageKey,
                    expires_in_seconds=self.signed_url_ttl_seconds,
                )
                return {"url": result["url"], "headers": result.get("headers")}
            except Exception:
                pass

        proxy_url = (
            f"/proxy/files/{file_id}/versions/{version.versionId}/download"
            if version_id
            else f"/proxy/files/{file_id}/download"
        )
        return {"url": proxy_url}

    async def get_download_stream(
        self,
        file_id: str,
        version_id: Optional[str],
        ctx: FileProviderContext,
    ) -> Dict[str, Any]:
        file = await self.get_file(file_id, ctx)
        target_version_id = version_id or file.currentVersionId
        version = await self._get_bound_version(file_id, target_version_id)

        stream = await self.storage.open_download_stream(key=version.storageKey)
        return {"stream": stream, "contentType": version.mimeType, "size": version.size}

    async def delete_file(self, file_id: str, ctx: FileProviderContext) -> None:
        file = await self._get_file_record(file_id)

        if not await self.authorizer.can_delete(file, ctx):
            raise errors.forbidden()

        versions_data = await self.db.find_many(
            model="fileVersions",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )
        versions = [FileVersionRecord(**item) for item in versions_data]

        total_bytes_freed = 0
        for version in versions:
            try:
                await self.storage.delete_object(key=version.storageKey)
                total_bytes_freed += version.size
            except Exception:
                pass

        await self.db.delete_many(
            model="fileVersions",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )
        await self.db.delete(
            model="files",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )

        if self.quota and total_bytes_freed > 0:
            await self.quota.record_usage(
                {
                    "principalId": ctx.principalId,
                    "tenantId": ctx.tenantId,
                    "bytes": -total_bytes_freed,
                }
            )

        self.events.emit(
            "file:deleted",
            create_file_deleted_event(
                {"fileId": file_id, "ownerId": file.ownerId, "tenantId": file.tenantId},
                ctx.requestId,
            ),
        )

        if self.logger:
            self.logger.info(
                "File deleted",
                {
                    "fileId": file_id,
                    "ownerId": file.ownerId,
                    "tenantId": file.tenantId,
                    "requestId": ctx.requestId,
                },
            )

    async def list_versions(self, file_id: str, ctx: FileProviderContext) -> Dict[str, Any]:
        await self.get_file(file_id, ctx)
        versions_data = await self.db.find_many(
            model="fileVersions",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            order_by=[{"field": "createdAt", "direction": "desc"}],
            namespace=self.namespace,
        )
        return {"versions": versions_data}

    async def can_write_file(self, file_id: str, ctx: FileProviderContext) -> bool:
        file_data = await self.db.find_one(
            model="files",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )

        if not file_data:
            return True

        file = FileRecord(**file_data)
        return await self.authorizer.can_write(file, ctx)

    async def get_version(self, file_id: str, version_id: str, ctx: FileProviderContext) -> FileVersionRecord:
        await self.get_file(file_id, ctx)
        return await self._get_bound_version(file_id, version_id)


def create_file_service(config: FileServiceConfig) -> FileService:
    return FileService(config)
