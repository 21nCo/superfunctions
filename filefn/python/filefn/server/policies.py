from typing import Callable, List, Optional, Protocol, Dict, Union, Any
from dataclasses import dataclass, field
from pydantic import BaseModel

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
                 storagePath: Optional[Callable[[PolicyStoragePathContext], str]] = None):
        self.name = name
        self.contentTypes = contentTypes
        self.maxSizeBytes = maxSizeBytes
        self.visibility = visibility
        self.storagePath = storagePath

class PolicyRegistry(Protocol):
    def get(self, name: str) -> Optional[Policy]: ...
    def register(self, policy: Policy) -> None: ...
    def list(self) -> List[Policy]: ...
    def define(self, name: str, policy: Dict[str, Any]) -> None: ...

class InMemoryPolicyRegistry:
    def __init__(self, initial_policies: List[Policy] = None):
        self._policies: Dict[str, Policy] = {}
        if initial_policies:
            for p in initial_policies:
                self._policies[p.name] = p

    def get(self, name: str) -> Optional[Policy]:
        return self._policies.get(name)

    def register(self, policy: Policy) -> None:
        self._policies[policy.name] = policy

    def define(self, name: str, **kwargs) -> None:
        policy = Policy(name=name, **kwargs)
        self._policies[name] = policy

    def list(self) -> List[Policy]:
        return list(self._policies.values())

def create_policy_registry(initial_policies: List[Policy] = None) -> InMemoryPolicyRegistry:
    return InMemoryPolicyRegistry(initial_policies)

def validate_policy_constraints(policy: Policy, mime_type: str, size: int) -> Dict[str, Union[bool, str]]:
    if policy.contentTypes and len(policy.contentTypes) > 0:
        if mime_type not in policy.contentTypes:
            return {'valid': False, 'error': f"Content type '{mime_type}' not allowed by policy '{policy.name}'"}
    
    if policy.maxSizeBytes is not None and size > policy.maxSizeBytes:
        return {'valid': False, 'error': f"Size {size} exceeds max {policy.maxSizeBytes} for policy '{policy.name}'"}

    return {'valid': True}

def compute_storage_path(policy: Policy, ctx: PolicyStoragePathContext) -> str:
    if policy.storagePath:
        return policy.storagePath(ctx)
    
    parts = []
    if ctx.tenantId: parts.append(ctx.tenantId)
    if ctx.principalId: parts.append(ctx.principalId)
    parts.append(ctx.fileId)
    parts.append(f"{ctx.versionId}-{ctx.fileName}")
    return "/".join(parts)
