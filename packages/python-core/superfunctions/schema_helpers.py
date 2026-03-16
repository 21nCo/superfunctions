"""Shared TypedDict primitives for superfunctions schema modules."""

from typing import Dict, List, TypedDict


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
