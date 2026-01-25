"""Schema definition for secfn database tables."""

from typing import Any, Dict, List, TypedDict


class FieldSchema(TypedDict, total=False):
    """Schema for a field in a table."""

    type: str
    required: bool
    unique: bool
    fieldName: str


class IndexSchema(TypedDict):
    """Schema for an index."""

    name: str
    fields: List[str]
    unique: bool


class TableSchema(TypedDict):
    """Schema for a database table."""

    modelName: str
    fields: Dict[str, FieldSchema]
    indexes: List[IndexSchema]


class SchemaDefinition(TypedDict):
    """Complete schema definition."""

    version: int
    schemas: List[TableSchema]


def get_schema(config: Dict[str, Any] = None) -> SchemaDefinition:
    """Get schema definition for secfn.
    
    Args:
        config: Optional configuration dict with 'namespace' key
        
    Returns:
        Schema definition with version and table schemas
    """
    namespace = (config or {}).get("namespace", "secfn")

    return {
        "version": 1,
        "schemas": [
            # Secrets table
            {
                "modelName": "secrets",
                "fields": {
                    "id": {"type": "string", "required": True, "fieldName": "id"},
                    "key": {
                        "type": "string",
                        "required": True,
                        "unique": True,
                        "fieldName": "key",
                    },
                    "value": {"type": "string", "required": True, "fieldName": "value"},
                    "encrypted": {"type": "boolean", "required": True, "fieldName": "encrypted"},
                    "version": {"type": "integer", "required": True, "fieldName": "version"},
                    "tags": {"type": "json", "required": False, "fieldName": "tags"},
                    "environment": {
                        "type": "string",
                        "required": False,
                        "fieldName": "environment",
                    },
                    "expiresAt": {"type": "date", "required": False, "fieldName": "expires_at"},
                    "rotateEvery": {
                        "type": "integer",
                        "required": False,
                        "fieldName": "rotate_every",
                    },
                    "lastRotated": {
                        "type": "date",
                        "required": False,
                        "fieldName": "last_rotated",
                    },
                    "lastAccessed": {
                        "type": "date",
                        "required": False,
                        "fieldName": "last_accessed",
                    },
                    "accessCount": {
                        "type": "integer",
                        "required": True,
                        "fieldName": "access_count",
                    },
                    "createdBy": {"type": "string", "required": True, "fieldName": "created_by"},
                    "createdAt": {"type": "date", "required": True, "fieldName": "created_at"},
                    "updatedAt": {"type": "date", "required": True, "fieldName": "updated_at"},
                },
                "indexes": [
                    {"name": f"idx_{namespace}_secrets_key", "fields": ["key"], "unique": True}
                ],
            },
            # Secret access log table
            {
                "modelName": "secretAccess",
                "fields": {
                    "id": {"type": "string", "required": True, "fieldName": "id"},
                    "secretId": {"type": "string", "required": True, "fieldName": "secret_id"},
                    "userId": {"type": "string", "required": True, "fieldName": "user_id"},
                    "action": {"type": "string", "required": True, "fieldName": "action"},
                    "timestamp": {"type": "date", "required": True, "fieldName": "timestamp"},
                    "ip": {"type": "string", "required": False, "fieldName": "ip"},
                    "userAgent": {"type": "string", "required": False, "fieldName": "user_agent"},
                },
                "indexes": [
                    {
                        "name": f"idx_{namespace}_secret_access_secret_id",
                        "fields": ["secretId"],
                        "unique": False,
                    }
                ],
            },
            # Roles table
            {
                "modelName": "roles",
                "fields": {
                    "id": {"type": "string", "required": True, "fieldName": "id"},
                    "name": {"type": "string", "required": True, "fieldName": "name"},
                    "description": {"type": "string", "required": True, "fieldName": "description"},
                    "permissions": {"type": "json", "required": True, "fieldName": "permissions"},
                    "inherits": {"type": "json", "required": False, "fieldName": "inherits"},
                    "metadata": {"type": "json", "required": False, "fieldName": "metadata"},
                    "createdAt": {"type": "date", "required": True, "fieldName": "created_at"},
                    "updatedAt": {"type": "date", "required": True, "fieldName": "updated_at"},
                },
                "indexes": [
                    {"name": f"idx_{namespace}_roles_name", "fields": ["name"], "unique": True}
                ],
            },
            # User roles table
            {
                "modelName": "userRoles",
                "fields": {
                    "userId": {"type": "string", "required": True, "fieldName": "user_id"},
                    "roleId": {"type": "string", "required": True, "fieldName": "role_id"},
                    "resourceIds": {
                        "type": "json",
                        "required": False,
                        "fieldName": "resource_ids",
                    },
                    "expiresAt": {"type": "date", "required": False, "fieldName": "expires_at"},
                    "assignedAt": {"type": "date", "required": True, "fieldName": "assigned_at"},
                },
                "indexes": [
                    {
                        "name": f"idx_{namespace}_user_roles_user_id",
                        "fields": ["userId"],
                        "unique": False,
                    }
                ],
            },
            # Security events table
            {
                "modelName": "events",
                "fields": {
                    "id": {"type": "string", "required": True, "fieldName": "id"},
                    "timestamp": {"type": "date", "required": True, "fieldName": "timestamp"},
                    "type": {"type": "string", "required": True, "fieldName": "type"},
                    "severity": {"type": "string", "required": True, "fieldName": "severity"},
                    "userId": {"type": "string", "required": False, "fieldName": "user_id"},
                    "ip": {"type": "string", "required": True, "fieldName": "ip"},
                    "userAgent": {"type": "string", "required": False, "fieldName": "user_agent"},
                    "resource": {"type": "string", "required": False, "fieldName": "resource"},
                    "action": {"type": "string", "required": False, "fieldName": "action"},
                    "metadata": {"type": "json", "required": True, "fieldName": "metadata"},
                    "resolved": {"type": "boolean", "required": True, "fieldName": "resolved"},
                    "resolvedAt": {"type": "date", "required": False, "fieldName": "resolved_at"},
                    "resolvedBy": {"type": "string", "required": False, "fieldName": "resolved_by"},
                    "notes": {"type": "string", "required": False, "fieldName": "notes"},
                },
                "indexes": [
                    {
                        "name": f"idx_{namespace}_events_timestamp",
                        "fields": ["timestamp"],
                        "unique": False,
                    },
                    {"name": f"idx_{namespace}_events_type", "fields": ["type"], "unique": False},
                ],
            },
            # Rate limits table
            {
                "modelName": "rateLimits",
                "fields": {
                    "key": {"type": "string", "required": True, "fieldName": "key"},
                    "count": {"type": "integer", "required": True, "fieldName": "count"},
                    "resetAt": {"type": "date", "required": True, "fieldName": "reset_at"},
                    "blocked": {"type": "boolean", "required": True, "fieldName": "blocked"},
                    "blockedUntil": {
                        "type": "date",
                        "required": False,
                        "fieldName": "blocked_until",
                    },
                },
                "indexes": [
                    {"name": f"idx_{namespace}_rate_limits_key", "fields": ["key"], "unique": True}
                ],
            },
        ],
    }
