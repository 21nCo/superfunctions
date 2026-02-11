from typing import Any, Dict, List, Optional
from pydantic import BaseModel

from .files.service import FileService, create_file_service, FileServiceConfig, Authorizer
from .upload_sessions.service import UploadSessionService, create_upload_session_service, UploadSessionServiceConfig, QuotaProvider
from .processing.service import ProcessingService, create_processing_service, ProcessingServiceConfig, Processor, FlowFnProvider
from .dedup.service import DeduplicationService, create_deduplication_service, DeduplicationServiceConfig
from .authz.grants_service import GrantsService, create_grants_service, GrantsServiceConfig, CreateGrantInput
from .shares.service import SharesService, create_shares_service, SharesServiceConfig, CreateShareLinkInput
from .policies import PolicyRegistry, create_policy_registry, Policy
from .events import FileFnEventEmitter, create_event_emitter
from .schema import get_schema
from superfunctions.db import Adapter

class RateLimitConfig(BaseModel):
    persistence: Optional[Any] = None
    algorithm: Optional[str] = 'fixed-window'
    limits: Optional[Dict[str, int]] = None

class AuthConfig(BaseModel):
    pass # Placeholder

class FileFnConfig(BaseModel):
    db: Any # Adapter
    storage: Any # StorageAdapter
    policies: List[Policy] = []
    auth: Optional[AuthConfig] = None
    quota: Optional[QuotaProvider] = None
    rate_limit: Optional[RateLimitConfig] = None # Not implemented in python yet
    logger: Optional[Any] = None
    authorizer: Optional[Authorizer] = None
    namespace: str = 'filefn'
    default_chunk_size_bytes: Optional[int] = None
    upload_session_ttl_seconds: Optional[int] = None
    signed_url_ttl_seconds: Optional[int] = None
    processing: Optional[Dict[str, Any]] = None # {enabled, processors, flowFn}
    
    class Config:
        arbitrary_types_allowed = True

class FileFn:
    def __init__(self, 
                 upload_service: UploadSessionService,
                 file_service: FileService,
                 processing_service: ProcessingService,
                 grants_service: GrantsService,
                 shares_service: SharesService,
                 policy_registry: PolicyRegistry,
                 events: FileFnEventEmitter,
                 namespace: str):
        self.upload_service = upload_service
        self.file_service = file_service
        self.processing_service = processing_service
        self.grants_service = grants_service
        self.shares_service = shares_service
        self.policy_registry = policy_registry
        self.events = events
        self.namespace = namespace
    
    # FileProvider implementation delegation
    async def create_upload_session(self, input: Dict[str, Any], ctx: Any) -> Dict[str, Any]:
        from .upload_sessions.service import CreateSessionInput
        return await self.upload_service.create_session(CreateSessionInput(**input), ctx)

    async def get_upload_session_status(self, input: Dict[str, Any], ctx: Any) -> Dict[str, Any]:
         return await self.upload_service.get_session_status(input['uploadSessionId'], ctx)

    async def sign_upload_part(self, input: Dict[str, Any], ctx: Any) -> Dict[str, Any]:
         return await self.upload_service.sign_part(input['uploadSessionId'], input['partNumber'], input['contentLength'], ctx)

    async def complete_upload_part(self, input: Dict[str, Any], ctx: Any) -> None:
         await self.upload_service.complete_part(input['uploadSessionId'], input['partNumber'], input['etag'], input['size'], ctx)

    async def complete_upload_session(self, input: Dict[str, Any], ctx: Any) -> Dict[str, Any]:
         return await self.upload_service.complete_session(input['uploadSessionId'], ctx)

    async def abort_upload_session(self, input: Dict[str, Any], ctx: Any) -> None:
         await self.upload_service.abort_session(input['uploadSessionId'], ctx)

    async def get_file(self, input: Dict[str, Any], ctx: Any) -> Any:
         return await self.file_service.get_file(input['fileId'], ctx)

    async def list_files(self, input: Dict[str, Any], ctx: Any) -> Any:
         return await self.file_service.list_files(ctx, input)

    async def delete_file(self, input: Dict[str, Any], ctx: Any) -> None:
         await self.file_service.delete_file(input['fileId'], ctx)
    
    async def create_grant(self, input: Dict[str, Any], ctx: Any) -> Any:
        return await self.grants_service.create_grant(CreateGrantInput(**input), ctx)
    
    async def list_grants(self, input: Dict[str, Any], ctx: Any) -> Any:
        return await self.grants_service.list_grants(input['fileId'], ctx)

    async def revoke_grant(self, input: Dict[str, Any], ctx: Any) -> None:
        await self.grants_service.revoke_grant(input['fileId'], input['permissionId'], ctx)

    async def create_share_link(self, input: Dict[str, Any], ctx: Any) -> Any:
        return await self.shares_service.create_share_link(CreateShareLinkInput(**input), ctx)
    
    async def download_via_share_link(self, input: Dict[str, Any], ctx: Any) -> Any:
        return await self.shares_service.download_via_share_link(input['token'], ctx, is_authenticated=input.get('isAuthenticated', False))

    async def revoke_share_link(self, input: Dict[str, Any], ctx: Any) -> None:
        await self.shares_service.revoke_share_link(input['fileId'], input['token'], ctx)
    
    async def list_share_links(self, input: Dict[str, Any], ctx: Any) -> Any:
        return await self.shares_service.list_share_links(input['fileId'], ctx)

    def define_policy(self, name: str, policy: Dict[str, Any]) -> None:
        self.policy_registry.define(name, **policy)

    def get_schema(self) -> Any:
        return get_schema({'namespace': self.namespace})

def create_file_fn(config: FileFnConfig) -> FileFn:
    policy_registry = create_policy_registry(config.policies)
    events = create_event_emitter()
    
    # Defaults
    namespace = config.namespace
    signed_url_ttl = config.signed_url_ttl_seconds or 900
    upload_ttl = config.upload_session_ttl_seconds or 86400
    chunk_size = config.default_chunk_size_bytes or 8 * 1024 * 1024

    processing_config = config.processing or {}
    processing_service = create_processing_service(ProcessingServiceConfig(
        db=config.db,
        storage=config.storage,
        events=events,
        processors=processing_config.get('processors', []),
        flow_fn=processing_config.get('flowFn'),
        namespace=namespace,
        enabled=processing_config.get('enabled', True)
    ))

    file_service = create_file_service(FileServiceConfig(
        db=config.db,
        storage=config.storage,
        events=events,
        logger=config.logger,
        quota=config.quota,
        authorizer=config.authorizer,
        namespace=namespace,
        signed_url_ttl_seconds=signed_url_ttl
    ))

    dedup_service = create_deduplication_service(DeduplicationServiceConfig(
        db=config.db,
        namespace=namespace,
        enabled=True 
    ))

    upload_service = create_upload_session_service(UploadSessionServiceConfig(
        db=config.db,
        storage=config.storage,
        policies=policy_registry,
        events=events,
        logger=config.logger,
        quota=config.quota,
        dedup=dedup_service,
        file_write_checker=file_service, # FileService implements can_write_file
        processing_service=processing_service,
        namespace=namespace,
        default_chunk_size_bytes=chunk_size,
        upload_session_ttl_seconds=upload_ttl,
        signed_url_ttl_seconds=signed_url_ttl
    ))

    grants_service = create_grants_service(GrantsServiceConfig(
        db=config.db,
        namespace=namespace
    ))

    shares_service = create_shares_service(SharesServiceConfig(
        db=config.db,
        storage=config.storage,
        namespace=namespace,
        signed_url_ttl_seconds=signed_url_ttl
    ))

    return FileFn(
        upload_service=upload_service,
        file_service=file_service,
        processing_service=processing_service,
        grants_service=grants_service,
        shares_service=shares_service,
        policy_registry=policy_registry,
        events=events,
        namespace=namespace
    )
