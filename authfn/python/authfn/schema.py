"""Schema definition for authfn database tables."""

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
    """
    Get schema definition for authfn.

    Args:
        config: Optional configuration dict with 'namespace' key

    Returns:
        Schema definition with version and table schemas
    """
    namespace = (config or {}).get("namespace", "authfn")

    return {
        "version": 1,
        "schemas": [
            # API Keys table
            {
                "modelName": "apiKeys",
                "fields": {
                    "id": {
                        "type": "string",
                        "required": True,
                        "fieldName": "id",
                    },
                    "key": {
                        "type": "string",
                        "required": True,
                        "unique": True,
                        "fieldName": "key",
                    },
                    "name": {
                        "type": "string",
                        "required": True,
                        "fieldName": "name",
                    },
                    "resourceIds": {
                        "type": "json",
                        "required": True,
                        "fieldName": "resource_ids",
                    },
                    "scopes": {
                        "type": "json",
                        "required": False,
                        "fieldName": "scopes",
                    },
                    "metadata": {
                        "type": "json",
                        "required": False,
                        "fieldName": "metadata",
                    },
                    "expiresAt": {
                        "type": "date",
                        "required": False,
                        "fieldName": "expires_at",
                    },
                    "lastUsedAt": {
                        "type": "date",
                        "required": False,
                        "fieldName": "last_used_at",
                    },
                    "revokedAt": {
                        "type": "date",
                        "required": False,
                        "fieldName": "revoked_at",
                    },
                    "createdAt": {
                        "type": "date",
                        "required": True,
                        "fieldName": "created_at",
                    },
                },
                "indexes": [
                    {
                        "name": f"idx_{namespace}_api_keys_key",
                        "fields": ["key"],
                        "unique": True,
                    }
                ],
            }
        ],
    }
