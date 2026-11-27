import uuid
from datetime import datetime, timezone
from typing import Any, List, Optional

from pydantic import BaseModel

from .. import errors
from ..models import FilePermissionRecord, FileProviderContext, FileRecord
from .grant_expiry import parse_iso_instant
from .ownership import is_file_owner


class CreateGrantInput(BaseModel):
    fileId: str
    userId: Optional[str] = None
    role: Optional[str] = None
    tenantId: Optional[str] = None
    canRead: Optional[bool] = None
    canWrite: Optional[bool] = None
    canDelete: Optional[bool] = None
    canShare: Optional[bool] = None
    expiresAt: Optional[str] = None

MAX_GRANT_FIELD_LENGTH = 255


def _invalid_request(message: str, field: str) -> errors.FileFnError:
    return errors.FileFnError('FILEFN_INVALID_REQUEST', message, 400, {'field': field})


def _optional_text(value: Optional[str], field: str) -> Optional[str]:
    if value is None or value == '':
        return None
    if len(value) > MAX_GRANT_FIELD_LENGTH:
        raise _invalid_request(f'{field} must be a string of at most {MAX_GRANT_FIELD_LENGTH} characters', field)
    return value


class GrantsServiceConfig(BaseModel):
    db: Any # Adapter
    namespace: str = 'filefn'
    # Allow a grant to a tenant other than the file's own (off by default).
    allow_cross_tenant: bool = False

    class Config:
        arbitrary_types_allowed = True

class GrantsService:
    def __init__(self, config: GrantsServiceConfig):
        self.db = config.db
        self.namespace = config.namespace
        self.allow_cross_tenant = config.allow_cross_tenant

    async def _get_file(self, file_id: str) -> Optional[FileRecord]:
        data = await self.db.find_one(
            model='files',
            where=[{'field': 'fileId', 'operator': 'eq', 'value': file_id}],
            namespace=self.namespace
        )
        return FileRecord(**data) if data else None

    async def _can_manage_permissions(self, file: FileRecord, ctx: FileProviderContext) -> bool:
        return is_file_owner(file, ctx)

    async def create_grant(self, input: CreateGrantInput, ctx: FileProviderContext) -> FilePermissionRecord:
        file = await self._get_file(input.fileId)
        if not file:
            raise errors.not_found('File')

        if not await self._can_manage_permissions(file, ctx):
            raise errors.forbidden()

        user_id = _optional_text(input.userId, 'userId')
        role = _optional_text(input.role, 'role')
        tenant_id = _optional_text(input.tenantId, 'tenantId')
        if not user_id and not role and not tenant_id:
            raise errors.FileFnError('FILEFN_INVALID_GRANT', 'Grant must specify userId, role, or tenantId', 400)
        if tenant_id and tenant_id != (file.tenantId or None) and not self.allow_cross_tenant:
            raise errors.forbidden({'fileId': input.fileId, 'operation': 'grant', 'reason': 'cross-tenant'})
        expires_at: Optional[str] = None
        if input.expiresAt is not None and input.expiresAt != '':
            parsed = parse_iso_instant(input.expiresAt)
            if parsed is None:
                raise _invalid_request('expiresAt must be an ISO 8601 date-time', 'expiresAt')
            if parsed <= datetime.now(timezone.utc):
                raise _invalid_request('expiresAt must be in the future', 'expiresAt')
            expires_at = parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')

        permission = FilePermissionRecord(
            permissionId=str(uuid.uuid4()),
            fileId=input.fileId,
            userId=user_id,
            role=role,
            tenantId=tenant_id,
            canRead=input.canRead if input.canRead is not None else True,
            canWrite=input.canWrite if input.canWrite is not None else False,
            canDelete=input.canDelete if input.canDelete is not None else False,
            canShare=input.canShare if input.canShare is not None else False,
            expiresAt=expires_at,
            createdAt=datetime.now(timezone.utc).isoformat()
        )

        await self.db.create(
            model='filePermissions',
            data=permission.model_dump(),
            namespace=self.namespace
        )

        return permission

    async def list_grants(self, file_id: str, ctx: FileProviderContext) -> List[FilePermissionRecord]:
        file = await self._get_file(file_id)
        if not file:
            raise errors.not_found('File')

        if not await self._can_manage_permissions(file, ctx):
            raise errors.forbidden()

        data = await self.db.find_many(
            model='filePermissions',
            where=[{'field': 'fileId', 'operator': 'eq', 'value': file_id}],
            namespace=self.namespace
        )
        return [FilePermissionRecord(**p) for p in data]

    async def revoke_grant(self, file_id: str, permission_id: str, ctx: FileProviderContext) -> None:
        file = await self._get_file(file_id)
        if not file:
            raise errors.not_found('File')

        if not await self._can_manage_permissions(file, ctx):
            raise errors.forbidden()

        permission = await self.db.find_one(
            model='filePermissions',
            where=[
                {'field': 'permissionId', 'operator': 'eq', 'value': permission_id},
                {'field': 'fileId', 'operator': 'eq', 'value': file_id}
            ],
            namespace=self.namespace
        )

        if not permission:
            raise errors.permission_not_found()

        await self.db.delete(
            model='filePermissions',
            where=[{'field': 'permissionId', 'operator': 'eq', 'value': permission_id}],
            namespace=self.namespace
        )

def create_grants_service(config: GrantsServiceConfig) -> GrantsService:
    return GrantsService(config)
