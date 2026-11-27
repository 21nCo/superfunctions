import hashlib
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Protocol, Union

DEFAULT_STORAGE_TARGET = "durable"
NUCLEUS_MAX_SIZE_BYTES = 100 * 1024 * 1024
NUCLEUS_ALLOWED_CONTENT_TYPES = [
    "image/*",
    "audio/*",
    "video/*",
    "application/pdf",
    "text/markdown",
    "text/plain",
]

@dataclass
class PolicyStoragePathContext:
    fileName: str
    fileId: str
    versionId: str
    principalId: Optional[str] = None
    tenantId: Optional[str] = None

class Policy:
    def __init__(self,
                 name: str,
                 contentTypes: Optional[List[str]] = None,
                 maxSizeBytes: Optional[int] = None,
                 visibility: Optional[str] = None, # 'public' | 'private' | 'shared'
                 storageTarget: Optional[str] = None,
                 artifactStorageTarget: Optional[str] = None,
                 lifecycle: Optional[str] = None,
                 renderProfile: Optional[str] = None,
                 storagePath: Optional[Callable[[PolicyStoragePathContext], str]] = None):
        self.name = name
        self.contentTypes = contentTypes
        self.maxSizeBytes = maxSizeBytes
        self.visibility = visibility
        self.storageTarget = storageTarget
        self.artifactStorageTarget = artifactStorageTarget
        self.lifecycle = lifecycle
        self.renderProfile = renderProfile
        self.storagePath = storagePath

class PolicyRegistry(Protocol):
    def get(self, name: str) -> Optional[Policy]: ...
    def register(self, policy: Policy) -> None: ...
    def list(self) -> List[Policy]: ...
    def define(self, name: str, policy: Optional[Dict[str, Any]] = None, **kwargs: Any) -> None: ...

class InMemoryPolicyRegistry:
    def __init__(self, initial_policies: Optional[List[Policy]] = None):
        self._policies: Dict[str, Policy] = {}
        if initial_policies:
            for p in initial_policies:
                self._policies[p.name] = p

    def get(self, name: str) -> Optional[Policy]:
        return self._policies.get(name)

    def register(self, policy: Policy) -> None:
        self._policies[policy.name] = policy

    def define(self, name: str, policy: Optional[Dict[str, Any]] = None, **kwargs: Any) -> None:
        payload: Dict[str, Any] = dict(policy or {})
        payload.update(kwargs)
        resolved_policy = Policy(name=name, **payload)
        self._policies[name] = resolved_policy

    def list(self) -> List[Policy]:
        return list(self._policies.values())

def create_policy_registry(initial_policies: Optional[List[Policy]] = None) -> InMemoryPolicyRegistry:
    return InMemoryPolicyRegistry(initial_policies)

def validate_policy_constraints(policy: Policy, mime_type: str, size: int) -> Dict[str, Union[bool, str]]:
    if policy.contentTypes and len(policy.contentTypes) > 0:
        if not any(matches_content_type(pattern, mime_type) for pattern in policy.contentTypes):
            return {'valid': False, 'error': f"Content type '{mime_type}' not allowed by policy '{policy.name}'"}

    if policy.maxSizeBytes is not None and size > policy.maxSizeBytes:
        return {'valid': False, 'error': f"Size {size} exceeds max {policy.maxSizeBytes} for policy '{policy.name}'"}

    return {'valid': True}

# C0 controls, DEL and C1 controls.
_STORAGE_KEY_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ENCODED_CHARACTERS = re.compile(r"[%\\/\x00-\x1f\x7f-\x9f]")
# Longest tenant, principal, file ID or file-name part of a default key, in UTF-8 bytes.
_MAX_KEY_PART_BYTES = 120


def _utf8(value: str) -> bytes:
    """UTF-8 as JavaScript's TextEncoder writes it (a lone surrogate becomes U+FFFD)."""
    return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def _percent_encode(match: "re.Match[str]") -> str:
    return "".join(f"%{byte:02X}" for byte in _utf8(match.group(0)))


def sanitize_storage_key_segment(value: str) -> str:
    """Turn one value into a single storage key segment without collisions.

    The same encoding as the TypeScript server: ``%``, path separators and
    control characters are percent-encoded, as are the dots of a leading run of
    two or more dots and a segment that is exactly ``.``. Everything else is
    kept, so distinct IDs never share a segment (``team/east`` becomes
    ``team%2Feast``, never ``team_east``). An empty value becomes ``%20``,
    which no other value produces.
    """
    # Explicit surrogate pairs become the code points they encode (as JavaScript
    # iterates them); a lone surrogate stays and is replaced when encoded.
    value = str(value).encode("utf-16", "surrogatepass").decode("utf-16", "surrogatepass")
    encoded = _ENCODED_CHARACTERS.sub(_percent_encode, value)
    encoded = re.sub(r"^\.\.+", lambda dots: "%2E" * len(dots.group(0)), encoded)
    # A leading drive letter and colon (`C:`), which Windows would read as a drive.
    encoded = re.sub(r"^([A-Za-z]):", r"\1%3A", encoded)
    if encoded == "":
        return "%20"
    if encoded == ".":
        return "%2E"
    return encoded


def _bounded_key_part(value: str, keep_extension: bool) -> str:
    """A sanitized key part, shortened past 120 UTF-8 bytes as the TypeScript server does.

    A shortened part keeps its start, then ``%~`` and 128 bits of the SHA-256 of
    the whole part, then (for file names) its extension. ``%~`` never appears in
    a sanitized value, so a shortened part never equals another ID's segment.
    """
    sanitized = sanitize_storage_key_segment(value)
    if len(_utf8(sanitized)) <= _MAX_KEY_PART_BYTES:
        return sanitized
    extension_match = re.search(r"\.[A-Za-z0-9]{1,10}\Z", sanitized) if keep_extension else None
    extension = extension_match.group(0) if extension_match else ""
    suffix = f"%~{hashlib.sha256(_utf8(sanitized)).hexdigest()[:32]}{extension}"
    head = ""
    for char in sanitized:
        if len(_utf8(head + char)) + len(suffix) > _MAX_KEY_PART_BYTES:
            break
        head += char
    # Never end the head inside a percent-escape.
    head = re.sub(r"%[0-9A-F]?\Z", "", head)
    return f"{head}{suffix}"


def unsafe_storage_key_reason(key: str) -> Optional[str]:
    """Return why a storage key is unsafe, or None when it is safe."""
    if not isinstance(key, str) or not key:
        return "empty key"
    if _STORAGE_KEY_CONTROL_CHARACTERS.search(key):
        return "control character"
    if "\\" in key:
        return "backslash"
    # Slash-rooted, or starting with a Windows drive (`C:/x` or drive-relative `C:x`).
    if key.startswith("/") or re.match(r"[A-Za-z]:", key):
        return "absolute key"
    for segment in key.split("/"):
        if segment == "":
            return "empty segment"
        if segment in (".", ".."):
            return "dot segment"
    return None


def compute_storage_path(policy: Policy, ctx: PolicyStoragePathContext) -> str:
    if policy.storagePath:
        return policy.storagePath(ctx)

    parts = []
    if ctx.tenantId:
        parts.append(_bounded_key_part(ctx.tenantId, False))
    if ctx.principalId:
        parts.append(_bounded_key_part(ctx.principalId, False))
    parts.append(_bounded_key_part(ctx.fileId, False))
    parts.append(f"{sanitize_storage_key_segment(ctx.versionId)}-{_bounded_key_part(ctx.fileName, True)}")
    return "/".join(parts)

def resolve_storage_target(policy: Any) -> str:
    target = getattr(policy, "storageTarget", None) if policy is not None else None
    return target or DEFAULT_STORAGE_TARGET

def resolve_artifact_storage_target(policy: Any) -> str:
    target = getattr(policy, "artifactStorageTarget", None) if policy is not None else None
    return target or resolve_storage_target(policy)

def matches_content_type(pattern: str, mime_type: str) -> bool:
    if pattern == "*/*":
        return True
    if pattern.endswith("/*"):
        prefix = pattern[:-1]
        # SVG can run script, so `image/*` does not admit it; name `image/svg+xml` to allow it.
        if prefix.lower() == "image/" and mime_type.split(";", 1)[0].strip().lower() == "image/svg+xml":
            return False
        return mime_type.startswith(prefix)
    return pattern == mime_type

def create_nucleus_policies() -> List[Policy]:
    return [
        Policy(
            name="nucleus-durable-default",
            contentTypes=list(NUCLEUS_ALLOWED_CONTENT_TYPES),
            maxSizeBytes=NUCLEUS_MAX_SIZE_BYTES,
            visibility="private",
            storageTarget="durable",
            artifactStorageTarget="durable",
            lifecycle="durable",
            renderProfile="nucleus",
        ),
        Policy(
            name="nucleus-temporary-default",
            contentTypes=list(NUCLEUS_ALLOWED_CONTENT_TYPES),
            maxSizeBytes=NUCLEUS_MAX_SIZE_BYTES,
            visibility="private",
            storageTarget="temporary",
            artifactStorageTarget="temporary",
            lifecycle="temporary",
            renderProfile="nucleus",
        ),
    ]
