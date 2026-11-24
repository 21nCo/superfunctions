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

_STORAGE_KEY_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _sanitize_segment(value: str, collapse_underscores: bool) -> str:
    sanitized = _STORAGE_KEY_CONTROL_CHARACTERS.sub("", value)
    sanitized = re.sub(r"[\\/]+", "_", sanitized)
    sanitized = re.sub(r"\.\.+", "_", sanitized)
    if collapse_underscores:
        sanitized = re.sub(r"_+", "_", sanitized)
    # Strip what JavaScript's trim() strips, as the TypeScript server does.
    sanitized = sanitized.strip(
        "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
        "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    )
    if not sanitized or sanitized == ".":
        return "_"
    return sanitized


def sanitize_storage_key_segment(value: str) -> str:
    """Turn one value into a single storage key segment.

    Path separators become ``_``, runs of dots collapse to ``_``, runs of ``_``
    collapse to one, control characters are dropped, and an empty or dot-only
    result becomes ``_``. Default keys stay unique because the version ID in
    them is never collapsed.
    """
    return _sanitize_segment(value, True)


def unsafe_storage_key_reason(key: str) -> Optional[str]:
    """Return why a storage key is unsafe, or None when it is safe."""
    if not isinstance(key, str) or not key:
        return "empty key"
    if _STORAGE_KEY_CONTROL_CHARACTERS.search(key):
        return "control character"
    if "\\" in key:
        return "backslash"
    if key.startswith("/"):
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
        parts.append(sanitize_storage_key_segment(ctx.tenantId))
    if ctx.principalId:
        parts.append(sanitize_storage_key_segment(ctx.principalId))
    parts.append(sanitize_storage_key_segment(ctx.fileId))
    # Underscores in the version ID are kept: two distinct version IDs must never share a key.
    parts.append(f"{_sanitize_segment(ctx.versionId, False)}-{sanitize_storage_key_segment(ctx.fileName)}")
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
        return mime_type.startswith(pattern[:-1])
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
