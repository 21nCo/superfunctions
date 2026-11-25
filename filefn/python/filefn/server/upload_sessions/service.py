import hashlib
import json
import math
import re
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from tempfile import SpooledTemporaryFile
from typing import Any, Dict, List, Optional, Protocol, Union, cast

from pydantic import BaseModel, StrictFloat, StrictInt
from superfunctions.db.errors import DuplicateKeyError, NotFoundError

from .. import errors
from ..events import (
    FileFnEventEmitter,
    create_file_uploaded_event,
    create_part_recorded_event,
    create_upload_started_event,
)
from ..models import FileProviderContext, UploadSessionRecord
from ..policies import (
    PolicyStoragePathContext,
    compute_storage_path,
    matches_content_type,
    resolve_storage_target,
    unsafe_storage_key_reason,
)
from ..routed_storage import get_storage_capabilities


class QuotaProvider(Protocol):
    async def check_quota(self, input: Dict[str, Any]) -> Dict[str, Any]: ...

    async def record_usage(self, input: Dict[str, Any]) -> None: ...


class FileWriteAuthChecker(Protocol):
    async def can_write_file(self, file_id: str, ctx: FileProviderContext) -> bool: ...


class ProcessingService(Protocol):
    async def trigger_processing(self, input: Dict[str, Any], ctx: FileProviderContext) -> Dict[str, Any]: ...


class UploadSessionServiceConfig(BaseModel):
    db: Any
    storage: Any
    policies: Any
    events: FileFnEventEmitter
    logger: Optional[Any] = None
    quota: Optional[Any] = None
    dedup: Optional[Any] = None
    file_write_checker: Optional[Any] = None
    processing_service: Optional[Any] = None
    namespace: str = "filefn"
    allow_anonymous_uploads: bool = True
    default_chunk_size_bytes: int = 8 * 1024 * 1024
    upload_session_ttl_seconds: int = 86400
    signed_url_ttl_seconds: int = 900

    class Config:
        arbitrary_types_allowed = True


class CreateSessionInput(BaseModel):
    policy: str
    fileName: str
    # Strict: "12" or True is refused instead of being coerced; an integral
    # float such as 1.0 (JSON allows it, as the TypeScript server does) is
    # accepted and normalised to int by _validate_upload_init.
    size: Union[StrictInt, StrictFloat]
    mimeType: str
    fileId: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    idempotencyKey: Optional[str] = None


MAX_FILE_NAME_LENGTH = 255
MAX_MIME_TYPE_LENGTH = 1024
MAX_IDEMPOTENCY_KEY_LENGTH = 255
MAX_METADATA_BYTES = 16 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_MIME_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")
# type "/" subtype, each an HTTP token (RFC 9110), plus optional parameters.
# RFC 9110 media type, as the TypeScript server checks it: type/subtype tokens,
# then parameters `token=token` or `token=quoted-string` (quoted text and
# quoted pairs: tab, visible ASCII and Latin-1 obs-text); empty parameter
# slots are allowed. Nothing above U+00FF, which no HTTP header can carry.
_MIME_TOKEN = r"[!#$%&'*+.^_`|~0-9A-Za-z-]+"
_MIME_QUOTED = r'"(?:[\t \x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t \x21-\x7E\x80-\xFF])*"'
_MIME_TYPE = re.compile(
    rf"{_MIME_TOKEN}/{_MIME_TOKEN}(?:[ \t]*;(?:[ \t]*{_MIME_TOKEN}=(?:{_MIME_TOKEN}|{_MIME_QUOTED}))?)*[ \t]*"
)


_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


MAX_METADATA_DEPTH = 32
# The characters JavaScript's String.prototype.trim removes, so both servers
# agree on what a blank name is.
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _has_lone_surrogate(value: Any, depth: int = 0) -> bool:
    """Whether the value holds a surrogate code point, or nests deeper than MAX_METADATA_DEPTH (also refused)."""
    # Python strings hold code points, so any surrogate code point is unpaired.
    if isinstance(value, str):
        return bool(_LONE_SURROGATE.search(value))
    if not isinstance(value, (dict, list, tuple)):
        return False
    if depth >= MAX_METADATA_DEPTH:
        return True
    if isinstance(value, dict):
        return any(_has_lone_surrogate(k, depth + 1) or _has_lone_surrogate(v, depth + 1) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return any(_has_lone_surrogate(item, depth + 1) for item in value)
    return False


def _js_number_text(value: float) -> str:
    """Format a float exactly as JavaScript's Number.prototype.toString does."""
    if not math.isfinite(value):
        return "null"  # JSON.stringify writes non-finite numbers as null
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # Decimal(str) is exact and ignores the context (normalize() would not).
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(str(d) for d in digit_tuple)
    exponent = int(exponent)
    stripped = digits.rstrip("0")
    exponent += len(digits) - len(stripped)
    digits = stripped.lstrip("0") or "0"
    k = len(digits)
    n = int(exponent) + k
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        text = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
        text = f"{mantissa}e{'+' if e > 0 else '-'}{abs(e)}"
    return sign + text


def _js_json(value: Any) -> str:
    """Serialise as JavaScript's JSON.stringify does (compact, numbers in JS format)."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            # Stored as sent, so a non-finite number (e.g. 1e400) is refused
            # rather than counted as JSON.stringify's null.
            raise ValueError("non-finite number")
        return _js_number_text(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + _js_json(v) for k, v in value.items()) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_js_json(v) for v in value) + "]"
    raise TypeError(f"not JSON-serialisable: {type(value).__name__}")


def _integral(value: Any) -> Any:
    """A finite whole-number float (JSON `1.0`) as an int, as JavaScript reads it; anything else unchanged."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _utf16_length(value: str) -> int:
    # Lengths are counted in UTF-16 code units, as the TypeScript server does;
    # surrogatepass counts a lone surrogate (valid in JSON) as one unit.
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _validate_upload_init(input: CreateSessionInput) -> None:
    """Validate the init body as the TypeScript server does; raise a 400 on failure."""
    # No length cap: the name must match a registered policy anyway.
    if not isinstance(input.policy, str) or not input.policy or _has_lone_surrogate(input.policy):
        raise errors.invalid_request("policy must be a non-empty string", {"field": "policy"})

    name = input.fileName
    if not isinstance(name, str) or not name.strip(JS_WHITESPACE):
        raise errors.invalid_request("fileName must not be empty", {"field": "fileName"})
    if _utf16_length(name) > MAX_FILE_NAME_LENGTH:
        raise errors.invalid_request(
            f"fileName must be at most {MAX_FILE_NAME_LENGTH} characters",
            {"field": "fileName", "maxLength": MAX_FILE_NAME_LENGTH},
        )
    if "/" in name or "\\" in name:
        raise errors.invalid_request("fileName must not contain path separators", {"field": "fileName"})
    if _CONTROL_CHARACTERS.search(name):
        raise errors.invalid_request("fileName must not contain control characters", {"field": "fileName"})
    if name in (".", ".."):
        raise errors.invalid_request("fileName must not be a dot segment", {"field": "fileName"})
    if _has_lone_surrogate(name):
        raise errors.invalid_request("fileName must be well-formed Unicode", {"field": "fileName"})

    size = input.size
    if isinstance(size, float) and size.is_integer():
        size = int(size)
    if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > MAX_SAFE_INTEGER:
        raise errors.invalid_request("size must be a non-negative integer number of bytes", {"field": "size"})
    input.size = size

    mime_type = input.mimeType
    if (
        not isinstance(mime_type, str)
        or _utf16_length(mime_type) > MAX_MIME_TYPE_LENGTH
        or not _MIME_TYPE.fullmatch(mime_type.strip(" \t"))
        # C0 controls other than tab, and DEL; U+0080-U+00FF is left to the
        # quoted-string grammar (obs-text), as in TypeScript.
        or _MIME_CONTROL_CHARACTERS.search(mime_type)
        or _has_lone_surrogate(mime_type)
    ):
        raise errors.invalid_request('mimeType must be a MIME type such as "image/png"', {"field": "mimeType"})

    # An explicit `metadata: null` is refused, as in TypeScript; omitting it is fine.
    if input.metadata is None and "metadata" in input.model_fields_set:
        raise errors.invalid_request("metadata must be a JSON object", {"field": "metadata"})
    if input.metadata is not None:
        if not isinstance(input.metadata, dict) or _has_lone_surrogate(input.metadata):
            raise errors.invalid_request(
                f"metadata must be a JSON object of well-formed text, nested at most {MAX_METADATA_DEPTH} levels",
                {"field": "metadata"},
            )
        try:
            # Counted as JSON.stringify writes it (floats in JavaScript's format),
            # so both servers accept the same metadata. Integers are counted with
            # every digit, since they are stored exactly as sent: one past 2**53
            # (which JavaScript would round) can only make Python stricter.
            encoded = _js_json(input.metadata)
            # surrogatepass: a lone surrogate is counted (3 bytes) rather than raising.
            encoded_size = len(encoded.encode("utf-8", "surrogatepass"))
        except (TypeError, ValueError):
            raise errors.invalid_request("metadata must be a JSON object with finite numbers", {"field": "metadata"}) from None
        if encoded_size > MAX_METADATA_BYTES:
            raise errors.invalid_request(
                f"metadata must be at most {MAX_METADATA_BYTES} bytes as JSON",
                {"field": "metadata", "maxBytes": MAX_METADATA_BYTES},
            )

    key = input.idempotencyKey
    if key is not None and (
        not isinstance(key, str)
        or _utf16_length(key) > MAX_IDEMPOTENCY_KEY_LENGTH
        or _CONTROL_CHARACTERS.search(key)
        or _has_lone_surrogate(key)
    ):
        raise errors.invalid_request(
            f"idempotency key must be a string of at most {MAX_IDEMPOTENCY_KEY_LENGTH} characters",
            {"field": "idempotencyKey"},
        )



def _scope_idempotency_key(idempotency_key: str, ctx: FileProviderContext) -> str:
    """Hash the client's key with the caller's owner and tenant (same value as the TypeScript server)."""
    scope = json.dumps(
        [getattr(ctx, "principalId", None) or "anonymous", getattr(ctx, "tenantId", None) or None, idempotency_key],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return "idem_" + hashlib.sha256(scope.encode("utf-8")).hexdigest()


class UploadSessionService:
    def __init__(self, config: UploadSessionServiceConfig):
        self.db = config.db
        self.storage = config.storage
        self.policies = config.policies
        self.events = config.events
        self.logger = config.logger
        self.quota = config.quota
        self.dedup = config.dedup
        self.file_write_checker = config.file_write_checker
        self.processing_service = config.processing_service
        self.namespace = config.namespace
        self.allow_anonymous_uploads = config.allow_anonymous_uploads
        self.default_chunk_size_bytes = config.default_chunk_size_bytes
        self.upload_session_ttl_seconds = config.upload_session_ttl_seconds
        self.signed_url_ttl_seconds = config.signed_url_ttl_seconds

    def _generate_id(self) -> str:
        return f"upl_{secrets.token_urlsafe(16)}"

    def _hash_payload(self, input: CreateSessionInput, ctx: FileProviderContext) -> str:
        payload = {
            "p": input.policy,
            "fn": input.fileName,
            "s": input.size,
            "mt": input.mimeType,
            "fid": input.fileId,
            "md": input.metadata,
            "pr": ctx.principalId,
            "tn": ctx.tenantId,
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def _hash_session_token(self, token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _extract_upload_session_token(self, ctx: Any) -> Optional[str]:
        for attr in ("uploadSessionToken", "upload_session_token", "sessionToken", "session_token"):
            value = getattr(ctx, attr, None)
            if isinstance(value, str) and value:
                return value

        headers = getattr(ctx, "headers", None)
        if isinstance(headers, dict):
            for key in ("x-upload-session-token", "X-Upload-Session-Token", "x_upload_session_token"):
                value = headers.get(key)
                if isinstance(value, str) and value:
                    return value

        return None

    def _as_utc(self, value: str) -> datetime:
        normalized = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    def _is_expired(self, expires_at: str) -> bool:
        return self._as_utc(expires_at) <= datetime.now(timezone.utc)

    def _assert_session_binding(self, session_data: Dict[str, Any], ctx: Any) -> None:
        owner_id = session_data.get("ownerId")
        tenant_id = session_data.get("tenantId")

        # Every session row records its owner; one without is refused.
        if not owner_id:
            raise errors.forbidden({"uploadSessionId": session_data.get("uploadSessionId")})

        if owner_id != "anonymous":
            if getattr(ctx, "principalId", None) != owner_id:
                raise errors.forbidden({"uploadSessionId": session_data.get("uploadSessionId")})
            if tenant_id != getattr(ctx, "tenantId", None):
                raise errors.forbidden({"uploadSessionId": session_data.get("uploadSessionId")})
            return

        provided_token = self._extract_upload_session_token(ctx)
        if not provided_token:
            raise errors.FileFnError(
                code="FILEFN_SESSION_TOKEN_REQUIRED",
                message="Upload session token required",
                status=401,
                details={"uploadSessionId": session_data.get("uploadSessionId")},
            )

        expected_hash = session_data.get("sessionTokenHash")
        if not expected_hash or self._hash_session_token(provided_token) != expected_hash:
            raise errors.FileFnError(
                code="FILEFN_SESSION_TOKEN_INVALID",
                message="Invalid upload session token",
                status=403,
                details={"uploadSessionId": session_data.get("uploadSessionId")},
            )

    def _proxy_part_key(self, session: UploadSessionRecord, part_number: int) -> str:
        return f"{session.storageKey}.parts/{part_number}"

    def _select_upload_mode(self, storage_target: Optional[str] = None) -> str:
        capabilities = get_storage_capabilities(self.storage, storage_target)

        supports_multipart = bool(capabilities.get("signedUploadUrls") and capabilities.get("multipart"))
        supports_proxy = bool(capabilities.get("proxyStreamingUpload"))

        if not capabilities:
            supports_multipart = all(
                hasattr(self.storage, name)
                for name in (
                    "create_multipart_upload",
                    "sign_multipart_upload_part_url",
                    "complete_multipart_upload",
                )
            )
            supports_proxy = hasattr(self.storage, "put_object") and hasattr(
                self.storage, "open_download_stream"
            )

        if supports_multipart:
            return "multipart-signed-url"
        if supports_proxy:
            return "proxy"

        raise errors.no_supported_upload_mode()

    async def _get_session_data(self, upload_session_id: str) -> Dict[str, Any]:
        session_data = await self.db.find_one(
            model="uploadSessions",
            where=[{"field": "uploadSessionId", "operator": "eq", "value": upload_session_id}],
            namespace=self.namespace,
        )
        if not session_data:
            raise errors.session_not_found()
        return cast(Dict[str, Any], session_data)

    async def create_session(self, input: CreateSessionInput, ctx: FileProviderContext) -> Dict[str, Any]:
        warnings: List[str] = []

        if not ctx.principalId and not self.allow_anonymous_uploads:
            raise errors.auth_required()

        _validate_upload_init(input)

        # The stored key is scoped to the caller, so one caller's key never finds
        # or blocks another caller's session.
        # Anonymous callers get no idempotency: they share one scope, and a replay
        # could only return the session without its token (which only the
        # creator holds). A retry gets a fresh session and token instead.
        anonymous = not ctx.principalId or ctx.principalId == "anonymous"
        scoped_idempotency_key = (
            _scope_idempotency_key(input.idempotencyKey, ctx) if input.idempotencyKey and not anonymous else None
        )
        if scoped_idempotency_key:
            existing_data = await self.db.find_one(
                model="uploadSessions",
                where=[{"field": "idempotencyKey", "operator": "eq", "value": scoped_idempotency_key}],
                namespace=self.namespace,
            )
            # A row found under the scoped value must be this caller's (a legacy raw
            # key could equal it).
            if existing_data and (
                existing_data.get("ownerId") != ctx.principalId
                or (existing_data.get("tenantId") or None) != (getattr(ctx, "tenantId", None) or None)
            ):
                raise errors.idempotency_conflict()
            if not existing_data and not re.fullmatch(r"idem_[0-9a-f]{64}", input.idempotencyKey or ""):
                # A session created before keys were scoped stores the raw key; it
                # is this caller's only if owner and tenant match. A raw key shaped
                # like a scoped one is never treated as legacy.
                legacy = await self.db.find_one(
                    model="uploadSessions",
                    where=[{"field": "idempotencyKey", "operator": "eq", "value": input.idempotencyKey}],
                    namespace=self.namespace,
                )
                if (
                    legacy
                    # Exactly the key sent (a case-insensitive column could match another).
                    and legacy.get("idempotencyKey") == input.idempotencyKey
                    and legacy.get("ownerId") == ctx.principalId
                    and (legacy.get("tenantId") or None) == (getattr(ctx, "tenantId", None) or None)
                ):
                    existing_data = legacy
            if existing_data:
                existing = UploadSessionRecord(**existing_data)
                expected_hash = self._hash_payload(input, ctx)
                if existing.idempotencyPayloadHash != expected_hash:
                    raise errors.idempotency_conflict()
                # An ended session can't take parts: a restart needs a new key.
                if existing.status in ("aborted", "refused"):
                    raise errors.FileFnError(
                        errors.ErrorCodes.UPLOAD_ABORTED,
                        "The upload session for this idempotency key was aborted; start again with a new idempotency key",
                        410,
                        {"reason": "aborted", "field": "idempotencyKey"},
                    )

                return {
                    "uploadSessionId": existing.uploadSessionId,
                    "fileId": existing.fileId,
                    "uploadMode": existing.uploadMode,
                    "chunkSizeBytes": existing.chunkSizeBytes,
                    "totalParts": existing.totalParts,
                    "expiresAt": existing.expiresAt,
                    "warnings": [],
                }

        policy = self.policies.get(input.policy)
        if not policy:
            raise errors.policy_not_found(input.policy)

        if policy.contentTypes and not any(matches_content_type(pattern, input.mimeType) for pattern in policy.contentTypes):
            raise errors.policy_content_type_not_allowed(input.policy, input.mimeType)
        if policy.maxSizeBytes is not None and input.size > policy.maxSizeBytes:
            raise errors.policy_max_size_exceeded(input.policy, policy.maxSizeBytes, int(input.size))

        if input.fileId and self.file_write_checker:
            if not await self.file_write_checker.can_write_file(input.fileId, ctx):
                raise errors.forbidden({"fileId": input.fileId, "operation": "replace"})

        if self.quota:
            quota_result = await self.quota.check_quota(
                {
                    "principalId": ctx.principalId,
                    "tenantId": ctx.tenantId,
                    "requestedBytes": input.size,
                }
            )
            if not quota_result.get("allowed"):
                raise errors.quota_exceeded(
                    quota_result.get("current", 0),
                    quota_result.get("limit", 0),
                    int(input.size),
                )
            warning = quota_result.get("warning")
            if warning:
                warnings.append(warning)

        storage_target = resolve_storage_target(policy)
        upload_mode = self._select_upload_mode(storage_target)
        chunk_size_bytes = self.default_chunk_size_bytes
        total_parts = max(1, (input.size + chunk_size_bytes - 1) // chunk_size_bytes)

        upload_session_id = self._generate_id()
        now = datetime.now(timezone.utc)
        expires_at = (now + timedelta(seconds=self.upload_session_ttl_seconds)).isoformat()

        file_id = input.fileId or f"file_{secrets.token_urlsafe(12)}"
        version_id = f"ver_{secrets.token_urlsafe(12)}"

        storage_ctx = PolicyStoragePathContext(
            fileName=input.fileName,
            principalId=ctx.principalId,
            tenantId=ctx.tenantId,
            fileId=file_id,
            versionId=version_id,
        )
        storage_key = compute_storage_path(policy, storage_ctx)
        # A `.`/`..` segment, backslash or control character could resolve onto
        # another file's object on adapters that normalize paths.
        unsafe_reason = unsafe_storage_key_reason(storage_key)
        if unsafe_reason:
            raise errors.invalid_request(
                "The storage key for this upload is not safe",
                {"policy": input.policy, "reason": unsafe_reason},
            )
        # The key must contain this session's version ID, so two sessions (for
        # example two anonymous inits that are no longer replayed) never share
        # an object; a storagePath that drops it is refused, as in TypeScript.
        if version_id not in storage_key:
            # A policy misconfiguration, answered as the TypeScript server does.
            raise errors.FileFnError(
                "FILEFN_STORAGE_PATH_NOT_PER_VERSION",
                "Policy storagePath must return a key that contains the full versionId",
                500,
                {"policy": input.policy},
            )

        storage_upload_id: Optional[str] = None
        if upload_mode == "multipart-signed-url":
            storage_upload_id = cast(
                str,
                await self.storage.create_multipart_upload(
                key=storage_key,
                metadata={"contentType": input.mimeType},
                content_type=input.mimeType,
                target=storage_target,
                ),
            )

        upload_session_token: Optional[str] = None
        session_token_hash: Optional[str] = None
        owner_id = ctx.principalId or "anonymous"
        if owner_id == "anonymous":
            upload_session_token = secrets.token_urlsafe(32)
            session_token_hash = self._hash_session_token(upload_session_token)

        await self.db.create(
            model="uploadSessions",
            data={
                "uploadSessionId": upload_session_id,
                "status": "pending",
                "policy": input.policy,
                "fileId": file_id,
                "fileName": input.fileName,
                "mimeType": input.mimeType,
                "size": input.size,
                "uploadMode": upload_mode,
                "chunkSizeBytes": chunk_size_bytes,
                "totalParts": total_parts,
                "storageKey": storage_key,
                "storageUploadId": storage_upload_id,
                # The version this session publishes; its ID is part of the key.
                "completionVersionId": version_id,
                "ownerId": owner_id,
                "tenantId": ctx.tenantId,
                "metadata": input.metadata or {},
                "idempotencyKey": scoped_idempotency_key,
                "idempotencyPayloadHash": self._hash_payload(input, ctx) if scoped_idempotency_key else None,
                "uploadSessionToken": None,
                "sessionTokenHash": session_token_hash,
                "expiresAt": expires_at,
                "createdAt": now.isoformat(),
            },
            namespace=self.namespace,
        )

        self.events.emit(
            "upload.started",
            create_upload_started_event(
                {
                    "uploadSessionId": upload_session_id,
                    "fileName": input.fileName,
                    "size": input.size,
                    "mimeType": input.mimeType,
                    "policy": input.policy,
                    "principalId": ctx.principalId,
                    "tenantId": ctx.tenantId,
                },
                ctx.requestId,
            ),
        )

        session_result: Dict[str, Any] = {
            "uploadSessionId": upload_session_id,
            "fileId": file_id,
            "uploadMode": upload_mode,
            "chunkSizeBytes": chunk_size_bytes,
            "totalParts": total_parts,
            "expiresAt": expires_at,
            "warnings": warnings,
        }
        if upload_session_token:
            session_result["uploadSessionToken"] = upload_session_token
        return session_result

    async def get_session_status(self, upload_session_id: str, ctx: Any) -> Dict[str, Any]:
        session_data = await self._get_session_data(upload_session_id)
        self._assert_session_binding(session_data, ctx)

        session = UploadSessionRecord(**session_data)
        if self._is_expired(session.expiresAt):
            raise errors.upload_expired()

        parts_data = await self.db.find_many(
            model="uploadParts",
            where=[{"field": "uploadSessionId", "operator": "eq", "value": upload_session_id}],
            namespace=self.namespace,
        )
        recorded_parts = sorted(part["partNumber"] for part in parts_data)

        return {
            "uploadSessionId": upload_session_id,
            "fileId": session.fileId,
            # `refused` is internal (cleanup still pending); clients see aborted, as in TypeScript.
            "status": "aborted" if session.status == "refused" else session.status,
            "totalParts": session.totalParts,
            "recordedParts": recorded_parts,
            "chunkSizeBytes": session.chunkSizeBytes,
            "fileSize": session.size,
            "expiresAt": session.expiresAt,
        }

    @staticmethod
    def _max_part_bytes(session: "UploadSessionRecord", part_number: int) -> int:
        # The chunk size, or what is left of the declared size for the last part.
        if part_number < session.totalParts:
            return session.chunkSizeBytes
        return max(0, session.size - (session.totalParts - 1) * session.chunkSizeBytes)

    async def sign_part(
        self,
        upload_session_id: str,
        part_number: int,
        content_length: int,
        ctx: Any,
    ) -> Dict[str, Any]:
        session_data = await self._get_session_data(upload_session_id)
        self._assert_session_binding(session_data, ctx)

        session = UploadSessionRecord(**session_data)
        if session.status in ("aborted", "refused"):
            raise errors.upload_aborted()
        if session.status == "completed":
            raise errors.upload_already_completed()
        if self._is_expired(session.expiresAt):
            raise errors.upload_expired()

        if part_number < 1 or part_number > session.totalParts:
            raise errors.invalid_part_number()
        part_limit = self._max_part_bytes(session, part_number)
        content_length = _integral(content_length)
        # Zero only for the empty part of a zero-byte upload.
        if (
            isinstance(content_length, bool)
            or not isinstance(content_length, int)
            or content_length < 0
            or (content_length == 0 and part_limit != 0)
        ):
            raise errors.invalid_request("contentLength must be a positive integer", {"field": "contentLength"})
        if content_length > part_limit:
            raise errors.part_too_large(part_number, part_limit)

        if session.uploadMode == "proxy":
            return {
                "url": f"/upload/{upload_session_id}/parts/{part_number}",
                "headers": {"content-type": session.mimeType},
                "expiresAt": session.expiresAt,
            }

        policy = self.policies.get(session.policy)
        storage_target = resolve_storage_target(policy)
        result = cast(
            Dict[str, Any],
            await self.storage.sign_multipart_upload_part_url(
            key=session.storageKey,
            upload_id=session.storageUploadId,
            part_number=part_number,
            expires_in_seconds=self.signed_url_ttl_seconds,
            constraints={"contentLength": content_length},
            target=storage_target,
            ),
        )

        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=self.signed_url_ttl_seconds)).isoformat()
        return {
            "url": result["url"],
            "headers": result.get("headers"),
            "expiresAt": expires_at,
        }

    async def complete_part(
        self,
        upload_session_id: str,
        part_number: int,
        etag: str,
        size: int,
        ctx: Any,
    ) -> Dict[str, Any]:
        session_data = await self._get_session_data(upload_session_id)
        self._assert_session_binding(session_data, ctx)

        session = UploadSessionRecord(**session_data)
        if session.status in ("aborted", "refused"):
            raise errors.upload_aborted()
        if session.status == "completed":
            raise errors.upload_already_completed()
        if self._is_expired(session.expiresAt):
            raise errors.upload_expired()
        if part_number < 1 or part_number > session.totalParts:
            raise errors.invalid_part_number()
        size = _integral(size)
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise errors.invalid_request("size must be a non-negative integer", {"field": "size"})
        part_limit = self._max_part_bytes(session, part_number)
        if size > part_limit:
            raise errors.part_too_large(part_number, part_limit)

        existing = await self.db.find_one(
            model="uploadParts",
            where=[
                {"field": "uploadSessionId", "operator": "eq", "value": upload_session_id},
                {"field": "partNumber", "operator": "eq", "value": part_number},
            ],
            namespace=self.namespace,
        )

        if existing:
            if existing.get("etag") == etag and existing.get("size") == size:
                return {"recorded": True}
            raise errors.part_conflict(upload_session_id, part_number)

        await self.db.create(
            model="uploadParts",
            data={
                "uploadSessionId": upload_session_id,
                "partNumber": part_number,
                "etag": etag,
                "size": size,
            },
            namespace=self.namespace,
        )

        if session.status == "pending":
            await self._set_status_if(upload_session_id, "pending", "in_progress")

        self.events.emit(
            "part.recorded",
            create_part_recorded_event(
                {"uploadSessionId": upload_session_id, "partNumber": part_number, "size": size},
                getattr(ctx, "requestId", None),
            ),
        )
        return {"recorded": True}

    async def record_proxy_part(
        self,
        upload_session_id: str,
        part_number: int,
        data: bytes,
        ctx: Any,
    ) -> Dict[str, Any]:
        session_data = await self._get_session_data(upload_session_id)
        self._assert_session_binding(session_data, ctx)
        session = UploadSessionRecord(**session_data)

        if session.uploadMode != "proxy":
            raise errors.no_supported_upload_mode()

        if session.status in ("aborted", "refused"):
            raise errors.upload_aborted()
        if session.status == "completed":
            raise errors.upload_already_completed()
        if self._is_expired(session.expiresAt):
            raise errors.upload_expired()
        if part_number < 1 or part_number > session.totalParts:
            raise errors.invalid_part_number()
        part_limit = self._max_part_bytes(session, part_number)
        if len(data) > part_limit:
            raise errors.part_too_large(part_number, part_limit)

        etag = f"proxy-sha256-{hashlib.sha256(data).hexdigest()}"
        existing = await self.db.find_one(
            model="uploadParts",
            where=[
                {"field": "uploadSessionId", "operator": "eq", "value": upload_session_id},
                {"field": "partNumber", "operator": "eq", "value": part_number},
            ],
            namespace=self.namespace,
        )
        if existing:
            stored_etag = existing.get("etag")
            if existing.get("size") == len(data):
                if stored_etag == etag:
                    return {"etag": etag, "size": len(data), "recorded": True}
                if isinstance(stored_etag, str) and re.fullmatch(r"[a-f0-9]{32}", stored_etag):
                    # Older proxy parts used MD5. Compare bytes to preserve exact
                    # retries without treating a weak digest as proof of equality.
                    if await self._proxy_part_matches(session, part_number, data):
                        return {"etag": stored_etag, "size": len(data), "recorded": True}
            raise errors.part_conflict(upload_session_id, part_number)

        part_key = self._proxy_part_key(session, part_number)
        policy = self.policies.get(session.policy)
        storage_target = resolve_storage_target(policy)
        await self.storage.put_object(
            key=part_key,
            data=data,
            metadata={"contentType": session.mimeType},
            target=storage_target,
        )
        await self.complete_part(upload_session_id, part_number, etag, len(data), ctx)

        return {"etag": etag, "size": len(data), "recorded": True}

    async def _proxy_part_matches(self, session: UploadSessionRecord, part_number: int, data: bytes) -> bool:
        policy = self.policies.get(session.policy)
        stream = await self.storage.open_download_stream(
            key=self._proxy_part_key(session, part_number), target=resolve_storage_target(policy)
        )
        incoming = memoryview(data)
        offset = 0
        matches = True
        async for chunk in stream:
            end = offset + len(chunk)
            matches = matches and incoming[offset:end] == chunk
            offset = end
        return matches and offset == len(incoming)

    async def _finalize_proxy_upload(self, session: UploadSessionRecord, parts: List[Dict[str, Any]]) -> None:
        policy = self.policies.get(session.policy)
        storage_target = resolve_storage_target(policy)
        sorted_parts = sorted(parts, key=lambda p: p["partNumber"])
        with SpooledTemporaryFile(max_size=8 * 1024 * 1024) as payload:
            for part in sorted_parts:
                part_key = self._proxy_part_key(session, part["partNumber"])
                stream = await self.storage.open_download_stream(key=part_key, target=storage_target)
                async for chunk in stream:
                    payload.write(chunk)

            stitched_size = payload.tell()
            if stitched_size != session.size:
                raise errors.upload_size_mismatch(session.size, stitched_size)
            payload.seek(0)
            await self.storage.put_object(
                key=session.storageKey,
                data=payload,
                metadata={"contentType": session.mimeType},
                target=storage_target,
            )

        for part in sorted_parts:
            part_key = self._proxy_part_key(session, part["partNumber"])
            try:
                await self.storage.delete_object(key=part_key, target=storage_target)
            except Exception:
                pass

    @staticmethod
    def _key_is_session_owned(session: "UploadSessionRecord", session_data: Dict[str, Any]) -> bool:
        """Whether the session's storage key contains its own version ID, so no other session shares it."""
        version_id = session.completionVersionId
        return bool(version_id) and version_id is not None and version_id in session.storageKey

    async def _finalize_upload_storage(
        self,
        session: "UploadSessionRecord",
        session_data: Dict[str, Any],
        upload_session_id: str,
        storage_target: str,
    ) -> None:
        """Checks the recorded parts and finalizes the session's object, verifying its stored size."""
        parts_data = await self.db.find_many(
            model="uploadParts",
            where=[{"field": "uploadSessionId", "operator": "eq", "value": upload_session_id}],
            namespace=self.namespace,
        )
        if len(parts_data) != session.totalParts:
            raise errors.upload_incomplete()
        uploaded_size = sum(int(part.get("size") or 0) for part in parts_data)
        if uploaded_size != session.size:
            raise errors.upload_size_mismatch(session.size, uploaded_size)

        owned = self._key_is_session_owned(session, session_data)
        if not owned and session.uploadMode == "multipart-signed-url":
            # A multipart session from before per-version keys: finalizing
            # consumes its upload ID, and its key alone can't prove a later retry
            # that the object there is its own, so it restarts instead.
            await self._mark_aborted(upload_session_id)
            raise errors.invalid_request(
                "This upload must be restarted: it was started before this server version",
                {"reason": "legacy multipart session"},
            )
        if not owned:
            # A session from before per-version keys may share its key with a
            # published version; finalizing would overwrite that version's bytes.
            referencing = await self.db.find_many(
                model="fileVersions",
                where=[{"field": "storageKey", "operator": "eq", "value": session.storageKey}],
                namespace=self.namespace,
            )
            if referencing:
                await self._mark_aborted(upload_session_id)
                raise errors.invalid_request(
                    "This upload must be restarted: its storage key is in use by a published version",
                    {"reason": "shared storage key"},
                )

        if session.uploadMode == "multipart-signed-url":
            parts = sorted(parts_data, key=lambda p: p["partNumber"])
            completion: Any = None
            try:
                completion = await self.storage.complete_multipart_upload(
                    key=session.storageKey,
                    upload_id=session.storageUploadId,
                    parts=[{"partNumber": p["partNumber"], "etag": p["etag"]} for p in parts],
                    target=storage_target,
                )
            except Exception:
                # A retry after an earlier call finalized the upload (and then
                # failed, for example at the size check below) finds the upload
                # ID consumed. A session-owned key holding an object is that
                # finalized upload, and the size check below decides.
                if not owned or await self._stored_size(session.storageKey, storage_target, None) is None:
                    raise

            # The client reports part sizes; the stored object is what counts.
            actual = await self._stored_size(session.storageKey, storage_target, completion)
            if actual is None:
                raise errors.FileFnError(
                    "FILEFN_STORAGE_ERROR",
                    "The stored upload's size could not be read, so it was not published",
                    502,
                    {"uploadSessionId": upload_session_id},
                )
            if actual != session.size:
                # Refused first, so a retry never reaches storage again and the
                # expiry sweep knows a finalized, unpublished object is left;
                # once that (session-owned) object is deleted it is aborted.
                await self._set_status(upload_session_id, "refused")
                try:
                    await self.storage.delete_object(key=session.storageKey, target=storage_target)
                    await self._set_status(upload_session_id, "aborted")
                except Exception:
                    # The session stays refused: the sweep finishes the cleanup,
                    # and the caller still learns why the upload was refused.
                    pass
                raise errors.upload_size_mismatch(session.size, actual)
        elif session.uploadMode == "proxy":
            await self._finalize_proxy_upload(session, parts_data)

    async def _set_status_if(self, upload_session_id: str, expected: str, status: str) -> None:
        """Moves the session to `status` only while it is still `expected` (never over a terminal state)."""
        where = [
            {"field": "uploadSessionId", "operator": "eq", "value": upload_session_id},
            {"field": "status", "operator": "eq", "value": expected},
        ]
        update_many = getattr(self.db, "update_many", None)
        if callable(update_many):
            await update_many(model="uploadSessions", where=where, data={"status": status}, namespace=self.namespace)
            return
        try:
            await self.db.update(model="uploadSessions", where=where, data={"status": status}, namespace=self.namespace)
        except Exception as error:
            if type(error).__name__ != "NotFoundError":
                raise

    async def _mark_aborted(self, upload_session_id: str) -> None:
        await self._set_status(upload_session_id, "aborted")

    async def _set_status(self, upload_session_id: str, status: str) -> None:
        await self.db.update(
            model="uploadSessions",
            where=[{"field": "uploadSessionId", "operator": "eq", "value": upload_session_id}],
            data={"status": status},
            namespace=self.namespace,
        )

    async def _stored_size(self, key: str, target: str, completion: Any) -> Optional[int]:
        """The stored object's size: stat_object, else the completion result, else get_object; None if unreadable."""

        def size_of(value: Any) -> Optional[int]:
            size = value.get("size") if isinstance(value, dict) else getattr(value, "size", None)
            return size if isinstance(size, int) and not isinstance(size, bool) else None

        stat_object = getattr(self.storage, "stat_object", None)
        if callable(stat_object):
            try:
                return size_of(await stat_object(key=key, target=target))
            except NotImplementedError:
                pass
            except Exception:
                return None
        if completion is not None and size_of(completion) is not None:
            return size_of(completion)
        get_object = getattr(self.storage, "get_object", None)
        if callable(get_object):
            try:
                return size_of(await get_object(key=key, target=target))
            except Exception:
                return None
        return None

    async def complete_session(self, upload_session_id: str, ctx: Any) -> Dict[str, str]:
        session_data = await self._get_session_data(upload_session_id)
        self._assert_session_binding(session_data, ctx)
        session = UploadSessionRecord(**session_data)

        if session.status == "completed":
            completed_file_id = session.fileId or ""
            completion_version_id = cast(
                str,
                session_data.get("completionVersionId") or session_data.get("versionId") or "",
            )
            return {
                "fileId": completed_file_id,
                "versionId": completion_version_id,
            }

        # An aborted session (including one refused for a size mismatch) never
        # reaches storage again.
        if session.status in ("aborted", "refused"):
            raise errors.upload_aborted()

        file_id = session.fileId or f"file_{secrets.token_urlsafe(12)}"
        # The version allocated at init (its ID is in the key); sessions created
        # before that get a fresh one.
        version_id = session.completionVersionId or f"ver_{secrets.token_urlsafe(12)}"

        # A retry after an attempt that wrote this version and then failed (for
        # example on the session update below) finds the version already
        # published. It touches no storage (the parts may be gone, or the object
        # deduplicated away) and only finishes the session. Version IDs are unique.
        published: Optional[Dict[str, Any]] = None
        if session.completionVersionId:
            published = await self.db.find_one(
                model="fileVersions",
                where=[{"field": "versionId", "operator": "eq", "value": version_id}],
                namespace=self.namespace,
            )
            if published and published.get("fileId") != file_id:
                published = None

        # A published version only needs its session finished, even after the
        # session expired (the file is live); anything else is checked first.
        if not published:
            if self._is_expired(session.expiresAt):
                raise errors.upload_expired()
            if session.fileId and self.file_write_checker:
                if not await self.file_write_checker.can_write_file(session.fileId, ctx):
                    raise errors.forbidden({"fileId": session.fileId, "operation": "replace"})

        policy = self.policies.get(session.policy)
        storage_target = resolve_storage_target(policy)

        if not published:
            await self._finalize_upload_storage(session, session_data, upload_session_id, storage_target)

        now_str = datetime.now(timezone.utc).isoformat()
        metadata = session_data.get("metadata") or {}

        if published:
            final_storage_key = cast(str, published.get("storageKey") or session.storageKey)
            checksum_sha256_base64: Optional[str] = published.get("checksumSha256Base64")
        else:
            final_storage_key = session.storageKey
            checksum_sha256_base64 = None
            if self.dedup and self.dedup.is_enabled():
                dedup_res = await self.dedup.compute_and_check_duplicate(
                    session.storageKey,
                    session.tenantId,
                    storage_target,
                    self.storage,
                )
                checksum_sha256_base64 = dedup_res.checksumSha256Base64
                if dedup_res.isDuplicate and dedup_res.existingStorageKey:
                    final_storage_key = dedup_res.existingStorageKey
                    if final_storage_key != session.storageKey:
                        try:
                            await self.storage.delete_object(key=session.storageKey, target=storage_target)
                        except Exception:
                            # Best effort: the duplicate's own object is no longer referenced.
                            pass

            existing_file = await self.db.find_one(
                model="files",
                where=[{"field": "fileId", "operator": "eq", "value": file_id}],
                namespace=self.namespace,
            )

            def refuse_replace() -> None:
                # The finalized object is left in place: without a completion fence
                # another call for this session may still be publishing it, so
                # deleting it here could remove a published version's bytes.
                raise errors.forbidden({"fileId": file_id, "operation": "replace"})

            if existing_file and existing_file.get("currentVersionId") != version_id:
                # Another completion created the file meanwhile: replacing it needs
                # write access to that row, checked now (FILE-30 F-02).
                if self.file_write_checker and not await self.file_write_checker.can_write_file(file_id, ctx):
                    refuse_replace()

            if existing_file:
                # Conditional on the row that was authorized: a row deleted or
                # replaced since is not overwritten.
                # A single conditional UPDATE where the adapter has one (update_many
                # returns the row count); a zero-row or not-found result is refused.
                conditional_update = getattr(self.db, "update_many", None) or self.db.update
                current = existing_file
                updated = None
                # A concurrent authorized replacement may advance the row between the
                # read and the update: reload, re-authorize and try again (bounded).
                for _ in range(3):
                    try:
                        updated = await conditional_update(
                            model="files",
                            where=[
                                {"field": "fileId", "operator": "eq", "value": file_id},
                                {"field": "currentVersionId", "operator": "eq", "value": current.get("currentVersionId")},
                            ],
                            data={
                                "currentVersionId": version_id,
                                "size": session.size,
                                "mimeType": session.mimeType,
                                "metadata": metadata,
                                "updatedAt": now_str,
                            },
                            namespace=self.namespace,
                        )
                    except NotFoundError:
                        # Only a missing row counts as losing it; other errors propagate.
                        updated = None
                    if updated:
                        break
                    current = await self.db.find_one(
                        model="files",
                        where=[{"field": "fileId", "operator": "eq", "value": file_id}],
                        namespace=self.namespace,
                    )
                    if not current:
                        break
                    if self.file_write_checker and not await self.file_write_checker.can_write_file(file_id, ctx):
                        break
                if not updated:
                    refuse_replace()
            else:
                try:
                    await self.db.create(
                    model="files",
                    data={
                        "fileId": file_id,
                        "currentVersionId": version_id,
                        "ownerId": session.ownerId,
                        "tenantId": session.tenantId,
                        "visibility": getattr(policy, "visibility", "private"),
                        "policy": session.policy,
                        "mimeType": session.mimeType,
                        "size": session.size,
                        "name": session.fileName,
                        "metadata": metadata,
                        "createdAt": now_str,
                        "updatedAt": now_str,
                    },
                    namespace=self.namespace,
                    )
                except DuplicateKeyError:
                    # Another completion created this file ID first (its unique key):
                    # this one may not publish over it. Other errors propagate.
                    refuse_replace()

            await self.db.create(
                model="fileVersions",
                data={
                    "versionId": version_id,
                    "fileId": file_id,
                    "storageKey": final_storage_key,
                    "mimeType": session.mimeType,
                    "size": session.size,
                    "checksumSha256Base64": checksum_sha256_base64,
                    "tenantId": session.tenantId,
                    "createdAt": now_str,
                },
                namespace=self.namespace,
            )

        await self.db.update(
            model="uploadSessions",
            where=[{"field": "uploadSessionId", "operator": "eq", "value": upload_session_id}],
            data={
                "status": "completed",
                "fileId": file_id,
                "completionVersionId": version_id,
            },
            namespace=self.namespace,
        )

        if self.quota:
            await self.quota.record_usage(
                {
                    "principalId": getattr(ctx, "principalId", None),
                    "tenantId": getattr(ctx, "tenantId", None),
                    "bytes": session.size,
                }
            )

        self.events.emit(
            "file:uploaded",
            create_file_uploaded_event(
                {
                    "fileId": file_id,
                    "versionId": version_id,
                    "fileName": session.fileName,
                    "size": session.size,
                    "mimeType": session.mimeType,
                    "ownerId": session.ownerId,
                    "tenantId": session.tenantId,
                },
                getattr(ctx, "requestId", None),
            ),
        )

        if self.processing_service:
            await self.processing_service.trigger_processing(
                {
                    "fileId": file_id,
                    "versionId": version_id,
                    "storageKey": final_storage_key,
                    "mimeType": session.mimeType,
                    "size": session.size,
                    "fileName": session.fileName,
                    "tenantId": session.tenantId,
                },
                ctx,
            )

        return {"fileId": file_id, "versionId": version_id}

    async def abort_session(self, upload_session_id: str, ctx: Any) -> None:
        session_data = await self._get_session_data(upload_session_id)
        self._assert_session_binding(session_data, ctx)
        session = UploadSessionRecord(**session_data)

        if session.status == "completed":
            raise errors.upload_already_completed()
        # A refused session keeps that status: the expiry sweep still has its
        # unpublished object to delete.
        if session.status == "refused":
            return

        policy = self.policies.get(session.policy)
        storage_target = resolve_storage_target(policy)

        if session.storageUploadId:
            try:
                await self.storage.abort_multipart_upload(
                    key=session.storageKey,
                    upload_id=session.storageUploadId,
                    target=storage_target,
                )
            except Exception:
                pass

        parts_data = await self.db.find_many(
            model="uploadParts",
            where=[{"field": "uploadSessionId", "operator": "eq", "value": upload_session_id}],
            namespace=self.namespace,
        )
        for part in parts_data:
            part_key = self._proxy_part_key(session, part["partNumber"])
            try:
                await self.storage.delete_object(key=part_key, target=storage_target)
            except Exception:
                pass

        # Only from the state read above: a completion that refused (or
        # finished) the session meanwhile keeps its state.
        await self._set_status_if(upload_session_id, session.status, "aborted")

    async def garbage_collect_expired_sessions(self) -> Dict[str, int]:
        now = datetime.now(timezone.utc)
        sessions: List[Dict[str, Any]] = []
        seen_session_ids: set[str] = set()
        for status in ("pending", "in_progress", "aborted", "refused", "expired"):
            status_rows = await self.db.find_many(
                model="uploadSessions",
                where=[{"field": "status", "operator": "eq", "value": status}],
                namespace=self.namespace,
            )
            for row in status_rows:
                upload_session_id = row.get("uploadSessionId")
                if not upload_session_id or upload_session_id in seen_session_ids:
                    continue
                seen_session_ids.add(upload_session_id)
                sessions.append(row)

        completed_sessions = await self.db.find_many(
            model="uploadSessions",
            where=[{"field": "status", "operator": "eq", "value": "completed"}],
            namespace=self.namespace,
        )

        deleted_sessions = 0
        preserved_completed_sessions = len(completed_sessions)

        for session_data in sessions:
            expires_at_raw = session_data.get("expiresAt")
            if not expires_at_raw:
                continue

            expires_at = self._as_utc(expires_at_raw)
            if expires_at > now:
                continue

            session = UploadSessionRecord(**session_data)

            # A completion that published its version but failed to write
            # `completed` is left for the client's retry, which finishes it
            # through the normal path (quota, upload event, processing): the
            # file is live, so the session must not be swept.
            if session.status in ("pending", "in_progress") and session.completionVersionId:
                published = await self.db.find_one(
                    model="fileVersions",
                    where=[{"field": "versionId", "operator": "eq", "value": session.completionVersionId}],
                    namespace=self.namespace,
                )
                if published and published.get("fileId") and (not session.fileId or published.get("fileId") == session.fileId):
                    continue

            policy = self.policies.get(session.policy)
            storage_target = resolve_storage_target(policy)

            if session.storageUploadId:
                try:
                    await self.storage.abort_multipart_upload(
                        key=session.storageKey,
                        upload_id=session.storageUploadId,
                        target=storage_target,
                    )
                except Exception:
                    pass

            # A refused session finalized an object that was never published (it
            # failed the size check) and whose delete failed. Its key is its own
            # (only session-owned keys are finalized), so the object is deleted
            # here; until that succeeds, the session row stays for the next sweep.
            if session.status == "refused":
                try:
                    await self.storage.delete_object(key=session.storageKey, target=storage_target)
                except Exception:
                    continue

            parts = await self.db.find_many(
                model="uploadParts",
                where=[{"field": "uploadSessionId", "operator": "eq", "value": session.uploadSessionId}],
                namespace=self.namespace,
            )
            for part in parts:
                part_key = self._proxy_part_key(session, part["partNumber"])
                try:
                    await self.storage.delete_object(key=part_key, target=storage_target)
                except Exception:
                    pass

            await self.db.delete_many(
                model="uploadParts",
                where=[{"field": "uploadSessionId", "operator": "eq", "value": session.uploadSessionId}],
                namespace=self.namespace,
            )
            # Only while the row is still in the state this sweep read: a
            # completion that refused or finished it meanwhile keeps it (a refused
            # one for the next sweep).
            removed = await self.db.delete_many(
                model="uploadSessions",
                where=[
                    {"field": "uploadSessionId", "operator": "eq", "value": session.uploadSessionId},
                    {"field": "status", "operator": "eq", "value": session.status},
                ],
                namespace=self.namespace,
            )
            if removed:
                deleted_sessions += 1

        return {
            "deletedSessions": deleted_sessions,
            "preservedCompletedSessions": preserved_completed_sessions,
        }


def create_upload_session_service(config: UploadSessionServiceConfig) -> UploadSessionService:
    return UploadSessionService(config)
