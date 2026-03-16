"""Schema definition for authfn database tables."""

from typing import Any, Dict

from superfunctions.schema_helpers import (
    FieldSchema,
    IndexSchema,
    SchemaDefinition,
    TableSchema,
)


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
