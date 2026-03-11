from typing import Any, Dict, List
from ..envelope import ok_response, error_response, DatafnError
from ..db import Adapter
from ..validation import SchemaIndex
from ..change_tracking import get_changes_since, get_latest_cursor, write_change, get_next_server_seq
from ..idempotency import check_idempotency, store_idempotency
from ..utils.date import coerce_date_fields_to_epoch
from ..utils.joins import get_join_table_name, enumerate_join_store_keys
from .mutation import execute_mutation_core

SEED_TABLE = "__datafn_seed"
DEFAULT_NAMESPACE = "datafn"
DEFAULT_MAX_PULL_LIMIT = 5000


async def handle_seed(ctx: Any, payload: Any, config: Any) -> Dict[str, Any]:
    logger = getattr(config, "logger", None)
    try:
        if logger:
            logger.debug("Seed request", {})
        if not isinstance(payload, dict):
            return error_response({"code": "DFQL_INVALID", "message": "Invalid JSON", "details": {"path": "$"}})

        client_id = payload.get("clientId")
        if not client_id:
            return error_response({"code": "DFQL_INVALID", "message": "Missing clientId", "details": {"path": "clientId"}})

        if config.authorize:
            if not await config.authorize(ctx, "seed", payload):
                return error_response({"code": "FORBIDDEN", "message": "Authorization denied", "details": {"path": "$"}})

        namespace = _get_namespace(ctx)
        seed_rec = await config.db.find_one(SEED_TABLE, [{"field": "id", "operator": "eq", "value": client_id}], namespace=namespace)

        if not seed_rec:
            await config.db.create(SEED_TABLE, {"id": client_id, "timestamp": 0}, namespace=namespace)

        return ok_response({"ok": True})

    except Exception as e:
        return error_response({"code": "INTERNAL", "message": str(e), "details": {}})


async def handle_clone(ctx: Any, payload: Any, config: Any) -> Dict[str, Any]:
    logger = getattr(config, "logger", None)
    try:
        if logger:
            logger.debug("Clone request", {})
        if not isinstance(payload, dict):
            return error_response({"code": "DFQL_INVALID", "message": "Invalid JSON", "details": {"path": "$"}})

        client_id = payload.get("clientId")
        tables = payload.get("tables", [])

        if not client_id:
            return error_response({"code": "DFQL_INVALID", "message": "Missing clientId", "details": {"path": "clientId"}})

        if config.authorize:
            if not await config.authorize(ctx, "clone", payload):
                return error_response({"code": "FORBIDDEN", "message": "Authorization denied", "details": {"path": "$"}})

        namespace = _get_namespace(ctx)
        index = SchemaIndex(config.schema)
        data = {}
        cursors = {}

        for table in tables:
            res_def = index.resources_by_name.get(table)
            if not res_def:
                return error_response({"code": "DFQL_UNKNOWN_RESOURCE", "message": f"Unknown resource: {table}", "details": {"path": "tables"}})

            if res_def.get("isRemoteOnly"):
                return error_response({
                    "code": "DFQL_INVALID",
                    "message": "Table is remote-only and cannot be cloned",
                    "details": {"path": "tables", "table": table}
                })

            records = await config.db.find_many(table, [], sort=["id:asc"], namespace=namespace)
            data[table] = records

            cursor = await get_latest_cursor(config.db, namespace, table)
            if cursor:
                cursors[table] = cursor

        return ok_response({
            "data": data,
            "cursors": cursors
        })

    except Exception as e:
        return error_response({"code": "INTERNAL", "message": str(e), "details": {}})


async def handle_pull(ctx: Any, payload: Any, config: Any) -> Dict[str, Any]:
    logger = getattr(config, "logger", None)
    try:
        if logger:
            logger.debug("Pull request", {})
        if not isinstance(payload, dict):
            return error_response({"code": "DFQL_INVALID", "message": "Invalid JSON", "details": {"path": "$"}})

        client_id = payload.get("clientId")
        cursors = payload.get("cursors", {})

        if not client_id:
            return error_response({"code": "DFQL_INVALID", "message": "Missing clientId", "details": {"path": "clientId"}})

        if config.authorize:
            if not await config.authorize(ctx, "pull", payload):
                return error_response({"code": "FORBIDDEN", "message": "Authorization denied", "details": {"path": "$"}})

        # Validate cursor format
        for table_name, cursor_val in cursors.items():
            if cursor_val is not None:
                err = _validate_cursor(cursor_val, table_name)
                if err:
                    return err

        namespace = _get_namespace(ctx)
        index = SchemaIndex(config.schema)
        limits = getattr(config, "limits", {}) or {}
        max_pull_limit = limits.get("maxPullLimit", DEFAULT_MAX_PULL_LIMIT)

        result_records = {}
        result_deleted = {}
        result_cursors = {}
        has_more = False

        # Collect tables to pull: all non-remote-only resources + join tables
        tables_to_pull = []
        for res_name, res_def in index.resources_by_name.items():
            if res_def.get("isRemoteOnly"):
                continue
            tables_to_pull.append(res_name)

        # Add join tables from many-many relations
        relations = config.schema.get("relations", [])
        join_keys = enumerate_join_store_keys(relations)
        for jk in join_keys:
            tables_to_pull.append(jk["joinTable"])

        # Collect all changes across tables
        all_resource_changes: Dict[str, Any] = {}
        total_changes = 0

        for table_name in tables_to_pull:
            cursor = cursors.get(table_name)
            # Fetch limit+1 to detect hasMore
            fetch_limit = max_pull_limit - total_changes + 1 if max_pull_limit else None
            if fetch_limit is not None and fetch_limit <= 0:
                has_more = True
                break

            changes_result = await get_changes_since(config.db, namespace, table_name, cursor, limit=fetch_limit)
            changes = changes_result["changes"]
            new_cursor = changes_result["cursor"]

            if changes:
                # Check if we exceeded the pull limit
                if max_pull_limit and total_changes + len(changes) > max_pull_limit:
                    # Trim to fit within limit
                    allowed = max_pull_limit - total_changes
                    if allowed > 0:
                        changes = changes[:allowed]
                        new_cursor = str(changes[-1]["serverSeq"])
                    else:
                        changes = []
                    has_more = True

                if changes:
                    all_resource_changes[table_name] = {
                        "changes": changes,
                        "new_cursor": new_cursor,
                    }
                    total_changes += len(changes)
            elif new_cursor:
                result_cursors[table_name] = new_cursor

        # Batch-fetch records for all upserts
        for table_name, info in all_resource_changes.items():
            changes = info["changes"]
            new_cursor = info["new_cursor"]

            upsert_ids = list(set(
                c["recordId"] for c in changes if c["operation"] != "delete"
            ))
            delete_ids = list(set(
                c["recordId"] for c in changes if c["operation"] == "delete"
            ))

            upserts: List[Dict[str, Any]] = []
            if upsert_ids:
                rows = await config.db.find_many(
                    table_name,
                    where=[{"field": "id", "operator": "in", "value": upsert_ids}],
                    namespace=namespace,
                )
                upserts = rows

            if upserts:
                result_records[table_name] = upserts
            if delete_ids:
                result_deleted[table_name] = delete_ids
            if new_cursor:
                result_cursors[table_name] = new_cursor

        response = {
            "records": result_records,
            "deleted": result_deleted,
            "cursors": result_cursors,
            "hasMore": has_more,
        }

        return ok_response(response)

    except Exception as e:
        return error_response({"code": "INTERNAL", "message": str(e), "details": {}})


async def handle_push(ctx: Any, payload: Any, config: Any) -> Dict[str, Any]:
    logger = getattr(config, "logger", None)
    try:
        if logger:
            logger.debug("Push request", {})
        if not isinstance(payload, dict):
            return error_response({"code": "DFQL_INVALID", "message": "Invalid JSON", "details": {"path": "$"}})

        client_id = payload.get("clientId")
        mutations = payload.get("mutations", [])

        if not client_id:
            return error_response({"code": "DFQL_INVALID", "message": "Missing clientId", "details": {"path": "clientId"}})

        if config.authorize:
            if not await config.authorize(ctx, "push", payload):
                return error_response({"code": "FORBIDDEN", "message": "Authorization denied", "details": {"path": "$"}})

        namespace = _get_namespace(ctx)
        applied = []
        errors = []
        index = SchemaIndex(config.schema)

        for mutation in mutations:
            m_client_id = mutation.get("clientId")
            m_id = mutation.get("mutationId")

            if m_client_id != client_id:
                errors.append({
                    "mutationId": m_id,
                    "error": {"code": "DFQL_INVALID", "message": "ClientId mismatch"}
                })
                continue

            # Idempotency
            cached = await check_idempotency(config.db, namespace, m_client_id, m_id)
            if cached:
                applied.append(m_id)
                continue

            try:
                # Date coercion on mutation record
                resource = mutation.get("resource", "")
                date_fields = index.date_fields.get(resource, set())
                if date_fields:
                    record = mutation.get("record")
                    if record and isinstance(record, dict):
                        coerce_date_fields_to_epoch(record, list(date_fields))
                    # Also coerce batch records
                    records_list = mutation.get("records")
                    if records_list and isinstance(records_list, list):
                        for rec in records_list:
                            if isinstance(rec, dict):
                                coerce_date_fields_to_epoch(rec, list(date_fields))

                # Execute
                affected_ids, _changes = await execute_mutation_core(config.db, index, mutation)

                # Change Tracking
                server_seq = await get_next_server_seq(config.db, namespace)

                for aid in affected_ids:
                    await write_change(
                        config.db,
                        namespace,
                        mutation["resource"],
                        mutation["operation"],
                        aid,
                        server_seq
                    )

                # Store idempotency
                result = {
                    "ok": True,
                    "mutationId": m_id,
                    "affectedIds": affected_ids,
                    "deduped": False,
                    "errors": []
                }
                await store_idempotency(config.db, namespace, m_client_id, m_id, result)

                applied.append(m_id)

            except DatafnError as e:
                errors.append({
                    "mutationId": m_id,
                    "error": {"code": e.code, "message": e.message, "details": e.details}
                })
            except Exception as e:
                errors.append({
                    "mutationId": m_id,
                    "error": {"code": "INTERNAL", "message": str(e)}
                })

        return ok_response({
            "applied": applied,
            "errors": errors
        })

    except Exception as e:
        return error_response({"code": "INTERNAL", "message": str(e), "details": {}})


def _get_namespace(ctx: Any) -> str:
    """Extract namespace from request context, defaulting to 'datafn'."""
    if isinstance(ctx, dict):
        return ctx.get("namespace", DEFAULT_NAMESPACE)
    return DEFAULT_NAMESPACE


def _validate_cursor(cursor_val: Any, table_name: str) -> Any:
    """Validate cursor is a non-negative integer string. Returns error response or None."""
    if not isinstance(cursor_val, (str, int)):
        return error_response({
            "code": "DFQL_INVALID",
            "message": "Invalid cursor format",
            "details": {"path": f"cursors.{table_name}"}
        })
    try:
        val = int(cursor_val)
        if val < 0:
            return error_response({
                "code": "DFQL_INVALID",
                "message": "Invalid cursor format",
                "details": {"path": f"cursors.{table_name}"}
            })
    except (ValueError, TypeError):
        return error_response({
            "code": "DFQL_INVALID",
            "message": "Invalid cursor format",
            "details": {"path": f"cursors.{table_name}"}
        })
    return None
