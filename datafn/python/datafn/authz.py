from typing import Any, Dict, List, Optional, Set
from .envelope import DatafnError
from .validation import SchemaIndex


def validate_query_authz(
    query: Dict[str, Any],
    resource_name: str,
    index: SchemaIndex,
) -> Optional[DatafnError]:
    """
    Validate field-level read authorization on a query.
    If the resource has permissions.read.fields defined, only those fields are readable.
    `id` is always readable.
    """
    resource_def = index.resources_by_name.get(resource_name)
    if not resource_def:
        return None

    permissions = resource_def.get("permissions")
    if not permissions:
        return None

    read_perms = permissions.get("read")
    if not read_perms:
        return None

    allowed_fields = read_perms.get("fields")
    if not allowed_fields:
        return None

    allowed_set: Set[str] = set(allowed_fields)
    allowed_set.add("id")  # id is always readable

    # Check select fields
    select = query.get("select", [])
    for field in select:
        base = field.split(".")[0]
        if base not in allowed_set:
            return DatafnError(
                code="FORBIDDEN",
                message=f"Access denied for field '{base}' on resource '{resource_name}'",
                details={"path": "select"}
            )

    # Check filter fields
    filters = query.get("filters", {})
    err = _check_filter_fields(filters, allowed_set, resource_name)
    if err:
        return err

    # Check sort fields
    sort = query.get("sort", [])
    for term in sort:
        if isinstance(term, str):
            field = term.lstrip("-").split(":")[0]
            if field not in allowed_set:
                return DatafnError(
                    code="FORBIDDEN",
                    message=f"Access denied for field '{field}' on resource '{resource_name}'",
                    details={"path": "sort"}
                )

    return None


def _check_filter_fields(
    filters: Any,
    allowed_set: Set[str],
    resource_name: str,
) -> Optional[DatafnError]:
    """Recursively check that filter fields are allowed."""
    if not isinstance(filters, dict):
        return None

    for key, value in filters.items():
        if key in ("$and", "$or"):
            if isinstance(value, list):
                for item in value:
                    err = _check_filter_fields(item, allowed_set, resource_name)
                    if err:
                        return err
        elif not key.startswith("$"):
            base = key.split(".")[0]
            if base not in allowed_set:
                return DatafnError(
                    code="FORBIDDEN",
                    message=f"Access denied for field '{base}' on resource '{resource_name}'",
                    details={"path": "filters"}
                )
    return None


def validate_mutation_authz(
    mutation: Dict[str, Any],
    resource_name: str,
    index: SchemaIndex,
) -> Optional[DatafnError]:
    """
    Validate field-level write authorization on a mutation.
    If the resource has permissions.write.fields defined, only those fields are writable.
    """
    resource_def = index.resources_by_name.get(resource_name)
    if not resource_def:
        return None

    permissions = resource_def.get("permissions")
    if not permissions:
        return None

    write_perms = permissions.get("write")
    if not write_perms:
        return None

    allowed_fields = write_perms.get("fields")
    if not allowed_fields:
        return None

    allowed_set: Set[str] = set(allowed_fields)

    # Check single record
    record = mutation.get("record", {})
    if record:
        for key in record.keys():
            if key not in allowed_set:
                return DatafnError(
                    code="FORBIDDEN",
                    message=f"Access denied for field '{key}' on resource '{resource_name}'",
                    details={"path": "record"}
                )

    # Check batch records
    records = mutation.get("records", [])
    if records:
        for i, rec in enumerate(records):
            if isinstance(rec, dict):
                for key in rec.keys():
                    if key not in allowed_set:
                        return DatafnError(
                            code="FORBIDDEN",
                            message=f"Access denied for field '{key}' on resource '{resource_name}'",
                            details={"path": f"records[{i}]"}
                        )

    return None


def check_payload_size(body: Any, max_bytes: int) -> Optional[DatafnError]:
    """
    Check if payload body exceeds max_bytes.
    body can be bytes, str, or have a length.
    Returns DatafnError if exceeded, None otherwise.
    """
    if max_bytes <= 0:
        return None

    size = 0
    if isinstance(body, bytes):
        size = len(body)
    elif isinstance(body, str):
        size = len(body.encode("utf-8"))
    elif hasattr(body, "__len__"):
        size = len(body)
    else:
        return None

    if size > max_bytes:
        return DatafnError(
            code="LIMIT_EXCEEDED",
            message=f"Payload size ({size} bytes) exceeds maximum of {max_bytes} bytes",
            details={"path": "$"}
        )
    return None
