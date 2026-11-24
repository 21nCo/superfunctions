import asyncio
import hashlib
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from pydantic import BaseModel

from .. import errors
from ..authz.grant_expiry import is_grant_expired, parse_iso_instant
from ..authz.ownership import is_file_owner
from ..models import FileProviderContext, FileRecord, FileShareRecord, FileVersionRecord
from ..policies import resolve_storage_target
from ..routed_storage import get_storage_capabilities


class CreateShareLinkInput(BaseModel):
    fileId: str
    versionId: Optional[str] = None
    expiresAt: Optional[str] = None
    requiresAuth: Optional[bool] = None
    maxDownloads: Optional[int] = None




async def _close_stream(stream: Any) -> None:
    """Closes a download stream that will not be handed out; best effort."""
    for name in ("aclose", "close"):
        closer = getattr(stream, name, None)
        if callable(closer):
            try:
                result = closer()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                # Best effort: the stream is discarded either way.
                pass
            return


class SharesServiceConfig(BaseModel):
    db: Any
    storage: Any
    policies: Optional[Any] = None
    logger: Optional[Any] = None
    namespace: str = "filefn"
    signed_url_ttl_seconds: int = 900

    class Config:
        arbitrary_types_allowed = True


class SharesService:
    def __init__(self, config: SharesServiceConfig):
        self.db = config.db
        self.storage = config.storage
        self.policies = config.policies
        self.logger = config.logger
        self.namespace = config.namespace
        self.signed_url_ttl_seconds = config.signed_url_ttl_seconds
        # Give-back tasks of cancelled requests, kept alive until they finish.
        self._background: Set["asyncio.Future[None]"] = set()

    def _storage_target_for_file(self, file: FileRecord) -> str:
        policy = self.policies.get(file.policy) if self.policies else None
        return resolve_storage_target(policy)

    def _hash_token(self, token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _generate_token(self) -> str:
        return secrets.token_urlsafe(32)

    def _signed_url_lifetime(self, share: FileShareRecord) -> Optional[int]:
        """The signed URL TTL, taken just before signing, but never past the link's own expiry; None under a second."""
        expires = parse_iso_instant(share.expiresAt) if share.expiresAt else None
        if expires is None:
            return self.signed_url_ttl_seconds
        remaining = int((expires - datetime.now(timezone.utc)).total_seconds())
        if remaining < 1:
            return None
        return min(self.signed_url_ttl_seconds, remaining)

    async def _reserve_download_cancel_safe(self, token_hash: str) -> int:
        """Counts a download; if the caller is cancelled meanwhile, a count that still lands is given back."""
        task = asyncio.ensure_future(self._reserve_download(token_hash))
        try:
            return (await asyncio.shield(task)).downloads
        except asyncio.CancelledError:
            self._give_back_when_landed(task, token_hash)
            raise

    def _give_back_when_landed(self, task: "asyncio.Future[FileShareRecord]", token_hash: str) -> None:
        """In the background: once a reservation whose caller was cancelled lands, give its count back."""

        async def give_back() -> None:
            try:
                reserved = await task
            except asyncio.CancelledError:
                # This give-back itself was cancelled (shutdown): nothing to undo here.
                raise
            except Exception:
                # The count never landed: nothing to give back.
                return
            await self._release_download(token_hash, reserved.downloads)

        pending = asyncio.ensure_future(give_back())
        self._background.add(pending)
        pending.add_done_callback(self._background.discard)

    async def _release_download(self, token_hash: str, written: int) -> None:
        """Gives back one download that could not be handed out: the current count goes down by one,
        re-read and retried when another download moved it, so it happens once. Best effort (fails closed).
        Shielded by its callers, so a cancelled request still finishes it."""
        current = written
        try:
            for _ in range(20):
                if current <= 0:
                    return
                if await self._set_downloads_if(token_hash, current, current - 1):
                    return
                reread = await self.db.find_one(
                    model="fileShares",
                    where=[{"field": "tokenHash", "operator": "eq", "value": token_hash}],
                    namespace=self.namespace,
                )
                if not reread:
                    return
                current = int(reread.get("downloads", 0))
        except Exception:
            # Fails closed: the link keeps the extra count.
            pass

    def _as_utc(self, value: str) -> datetime:
        normalized = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    async def _get_file(self, file_id: str) -> Optional[FileRecord]:
        data = await self.db.find_one(
            model="files",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )
        return FileRecord(**data) if data else None

    async def _get_version(self, version_id: str) -> Optional[FileVersionRecord]:
        data = await self.db.find_one(
            model="fileVersions",
            where=[{"field": "versionId", "operator": "eq", "value": version_id}],
            namespace=self.namespace,
        )
        return FileVersionRecord(**data) if data else None

    async def _can_share_file(self, file: FileRecord, ctx: FileProviderContext) -> bool:
        return is_file_owner(file, ctx)

    async def _set_downloads_if(self, token_hash: str, from_count: int, to_count: int) -> bool:
        """Writes downloads = to_count only while it is still from_count; whether this call's write landed.

        update_many reports affected rows and keeps the count predicate in the UPDATE on every adapter;
        update (for databases without update_many) returns the row, or raises not-found on a miss.
        """
        where = [
            {"field": "tokenHash", "operator": "eq", "value": token_hash},
            {"field": "downloads", "operator": "eq", "value": from_count},
        ]
        data = {"downloads": to_count}
        update_many = getattr(self.db, "update_many", None)
        if callable(update_many):
            return int(await update_many(model="fileShares", where=where, data=data, namespace=self.namespace) or 0) > 0
        try:
            return bool(await self.db.update(model="fileShares", where=where, data=data, namespace=self.namespace))
        except Exception as exc:
            if type(exc).__name__ == "NotFoundError":
                return False
            raise

    async def _read_usable_share(self, token_hash: str) -> FileShareRecord:
        current_data = await self.db.find_one(
            model="fileShares",
            where=[{"field": "tokenHash", "operator": "eq", "value": token_hash}],
            namespace=self.namespace,
        )
        if not current_data:
            raise errors.share_not_found()
        current = FileShareRecord(**current_data)
        if current.revokedAt:
            raise errors.share_revoked()
        if is_grant_expired(current.expiresAt):
            raise errors.share_expired()
        if current.maxDownloads is not None and current.downloads >= current.maxDownloads:
            raise errors.share_downloads_exceeded()
        return current

    async def _reserve_download(self, token_hash: str) -> FileShareRecord:
        for _ in range(5):
            current = await self._read_usable_share(token_hash)
            if await self._set_downloads_if(token_hash, current.downloads, current.downloads + 1):
                return current.model_copy(update={"downloads": current.downloads + 1})

        # The link may have been used up (or revoked) by the writes that won:
        # that is the answer, not a retryable conflict.
        await self._read_usable_share(token_hash)
        raise errors.FileFnError(
            code=errors.ErrorCodes.SHARE_DOWNLOAD_CONFLICT,
            message="Could not reserve share download",
            status=409,
            details={"tokenHash": token_hash},
        )

    async def create_share_link(self, input: CreateShareLinkInput, ctx: FileProviderContext) -> Dict[str, Any]:
        file = await self._get_file(input.fileId)
        if not file:
            raise errors.not_found("File")

        if not await self._can_share_file(file, ctx):
            raise errors.forbidden()

        expires_at: Optional[str] = None
        if input.expiresAt is not None and input.expiresAt != "":
            parsed = parse_iso_instant(input.expiresAt)
            if parsed is None:
                raise errors.FileFnError("FILEFN_INVALID_REQUEST", "expiresAt must be an ISO 8601 date-time", 400, {"field": "expiresAt"})
            if parsed <= datetime.now(timezone.utc):
                raise errors.FileFnError("FILEFN_INVALID_REQUEST", "expiresAt must be in the future", 400, {"field": "expiresAt"})
            expires_at = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if input.maxDownloads is not None and input.maxDownloads < 1:
            raise errors.FileFnError("FILEFN_INVALID_REQUEST", "maxDownloads must be a positive integer", 400, {"field": "maxDownloads"})

        if input.versionId:
            version = await self._get_version(input.versionId)
            if not version or version.fileId != file.fileId:
                raise errors.not_found("Version")

        token = self._generate_token()
        token_hash = self._hash_token(token)

        share = FileShareRecord(
            tokenHash=token_hash,
            fileId=input.fileId,
            versionId=input.versionId,
            expiresAt=expires_at,
            requiresAuth=input.requiresAuth if input.requiresAuth is not None else False,
            maxDownloads=input.maxDownloads,
            downloads=0,
            createdAt=datetime.now(timezone.utc).isoformat(),
            revokedAt=None,
        )

        await self.db.create(
            model="fileShares",
            data=share.model_dump(),
            namespace=self.namespace,
        )

        return {"token": token, "expiresAt": share.expiresAt}

    async def download_via_share_link(
        self,
        token: str,
        ctx: FileProviderContext,
        is_authenticated: bool = False,
    ) -> Dict[str, Any]:
        token_hash = self._hash_token(token)
        data = await self.db.find_one(
            model="fileShares",
            where=[{"field": "tokenHash", "operator": "eq", "value": token_hash}],
            namespace=self.namespace,
        )

        if not data:
            raise errors.share_not_found()

        share = FileShareRecord(**data)
        if share.revokedAt:
            raise errors.share_revoked()

        if is_grant_expired(share.expiresAt):
            raise errors.share_expired()

        if share.maxDownloads is not None and share.downloads >= share.maxDownloads:
            raise errors.share_downloads_exceeded()

        if share.requiresAuth and not is_authenticated:
            raise errors.auth_required()

        file = await self._get_file(share.fileId)
        if not file:
            raise errors.share_not_found()

        version_id = share.versionId or file.currentVersionId
        version = await self._get_version(version_id)
        if not version:
            raise errors.not_found("Version")
        if version.fileId != file.fileId:
            raise errors.not_found("Version")
        storage_target = self._storage_target_for_file(file)

        capabilities = get_storage_capabilities(self.storage, storage_target)
        # Streaming is judged for the file's own storage target.
        target_can_stream = getattr(self.storage, "can_stream_downloads", None)
        if callable(target_can_stream):
            can_stream = bool(target_can_stream(storage_target))
        else:
            can_stream = hasattr(self.storage, "open_download_stream") and capabilities.get("proxyStreamingDownload") is not False
        can_sign = hasattr(self.storage, "sign_download_url") and bool(capabilities.get("signedDownloadUrls"))
        if can_sign:
            # Counted first, then signed with the lifetime left at that moment; a
            # failed signing gives the count back. Under a second left, the link
            # counts as expired: the Python proxy result carries the stored
            # content type without the TypeScript proxy's protective headers, so
            # a working signer never hands a recipient over to it.
            written = await self._reserve_download_cancel_safe(token_hash)
            lifetime = self._signed_url_lifetime(share)
            result: Optional[Dict[str, Any]] = None
            if lifetime is not None:
                try:
                    result = await self.storage.sign_download_url(
                        key=version.storageKey,
                        expires_in_seconds=lifetime,
                        target=storage_target,
                    )
                except asyncio.CancelledError:
                    # Cancelled (a timeout) while signing: give the count back, then cancel.
                    await asyncio.shield(self._release_download(token_hash, written))
                    raise
                except Exception as exc:
                    await asyncio.shield(self._release_download(token_hash, written))
                    # Without streaming there is no fallback: the signing error is the answer.
                    if not can_stream:
                        raise
                    logger_warning = getattr(self.logger, "warning", None)
                    if callable(logger_warning):
                        logger_warning(
                            "share signed download url generation failed; falling back to proxy",
                            {
                                "fileId": file.fileId,
                                "versionId": version.versionId,
                                "storageKey": version.storageKey,
                                "error": str(exc),
                            },
                        )
            else:
                await asyncio.shield(self._release_download(token_hash, written))
                raise errors.share_expired()
            if result is not None:
                # Revoked or expired while signing: the URL is withheld. A failed
                # or cancelled read withholds it too, and gives the count back.
                try:
                    after = await self.db.find_one(
                        model="fileShares",
                        where=[{"field": "tokenHash", "operator": "eq", "value": token_hash}],
                        namespace=self.namespace,
                    )
                except (asyncio.CancelledError, Exception):
                    await asyncio.shield(self._release_download(token_hash, written))
                    raise
                if not after or after.get("revokedAt") or is_grant_expired(after.get("expiresAt")):
                    await asyncio.shield(self._release_download(token_hash, written))
                    if not after:
                        raise errors.share_not_found()
                    raise errors.share_revoked() if after.get("revokedAt") else errors.share_expired()
                return {
                    "url": result["url"],
                    "headers": result.get("headers"),
                    "fileName": file.name,
                    "mimeType": file.mimeType,
                }

        # Only a link that is still valid, on storage that can stream it, gets the proxy URL.
        if is_grant_expired(share.expiresAt):
            raise errors.share_expired()
        if not can_stream and can_sign:
            raise errors.share_expired()
        descriptor: Dict[str, Any] = {
            "url": f"/proxy/share-links/{token}/download",
            "fileName": file.name,
            "mimeType": file.mimeType,
        }
        return descriptor

    async def get_download_stream_via_share_link(
        self,
        token: str,
        ctx: FileProviderContext,
        is_authenticated: bool = False,
    ) -> Dict[str, Any]:
        token_hash = self._hash_token(token)
        data = await self.db.find_one(
            model="fileShares",
            where=[{"field": "tokenHash", "operator": "eq", "value": token_hash}],
            namespace=self.namespace,
        )
        if not data:
            raise errors.share_not_found()

        share = FileShareRecord(**data)
        if share.revokedAt:
            raise errors.share_revoked()
        if is_grant_expired(share.expiresAt):
            raise errors.share_expired()
        if share.maxDownloads is not None and share.downloads >= share.maxDownloads:
            raise errors.share_downloads_exceeded()
        if share.requiresAuth and not is_authenticated:
            raise errors.auth_required()

        file = await self._get_file(share.fileId)
        if not file:
            raise errors.share_not_found()

        version_id = share.versionId or file.currentVersionId
        version = await self._get_version(version_id)
        if not version or version.fileId != file.fileId:
            raise errors.not_found("Version")

        storage_target = self._storage_target_for_file(file)
        stream = await self.storage.open_download_stream(key=version.storageKey, target=storage_target)
        try:
            await self._reserve_download_cancel_safe(token_hash)
        except (asyncio.CancelledError, Exception):
            # Not counted (or given back): the opened stream is never handed out.
            await asyncio.shield(_close_stream(stream))
            raise
        return {
            "stream": stream,
            "contentType": version.mimeType,
            "size": version.size,
            "fileName": file.name,
            "mimeType": file.mimeType,
        }

    async def revoke_share_link(self, file_id: str, token: str, ctx: FileProviderContext) -> None:
        file = await self._get_file(file_id)
        if not file:
            raise errors.not_found("File")

        if not await self._can_share_file(file, ctx):
            raise errors.forbidden()

        token_hash = self._hash_token(token)
        share = await self.db.find_one(
            model="fileShares",
            where=[
                {"field": "tokenHash", "operator": "eq", "value": token_hash},
                {"field": "fileId", "operator": "eq", "value": file_id},
            ],
            namespace=self.namespace,
        )
        if not share:
            raise errors.share_not_found()

        await self.db.update(
            model="fileShares",
            where=[{"field": "tokenHash", "operator": "eq", "value": token_hash}],
            data={"revokedAt": datetime.now(timezone.utc).isoformat()},
            namespace=self.namespace,
        )

    async def list_share_links(self, file_id: str, ctx: FileProviderContext) -> List[Dict[str, Any]]:
        file = await self._get_file(file_id)
        if not file:
            raise errors.not_found("File")

        if not await self._can_share_file(file, ctx):
            raise errors.forbidden()

        shares_data = await self.db.find_many(
            model="fileShares",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )

        result: List[Dict[str, Any]] = []
        for raw in shares_data:
            share = FileShareRecord(**raw)
            row = share.model_dump()
            row.pop("tokenHash")
            row["tokenHashPrefix"] = share.tokenHash[:8]
            result.append(row)

        return result


def create_shares_service(config: SharesServiceConfig) -> SharesService:
    return SharesService(config)
