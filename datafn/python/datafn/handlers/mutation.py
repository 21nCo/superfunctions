from typing import Any, Dict, List, Optional, Union
from ..envelope import ok_response, error_response, DatafnError, classify_error
from ..validation import (
    SchemaIndex, validate_resource, validate_record_keys, validate_relation,
    validate_fields, validate_record_types, validate_required_fields,
    apply_defaults, validate_mutation_limits, validate_id_length,
)
from ..utils.validate_fields import check_prototype_pollution
from ..idempotency import check_idempotency, store_idempotency
from ..guards import evaluate_guard
from ..relations import execute_relate, execute_modify_relation, execute_unrelate
from ..hooks import run_before_hook, run_after_hook
from ..authz import validate_mutation_authz

RESERVED_FIELDS = {"id", "createdAt", "createdBy", "updatedAt", "updatedBy", "version"}


async def handle_mutation(ctx: Any, payload: Any, config: Any) -> Union[Dict[str, Any], List[Dict[str, Any]]]:
    if isinstance(payload, list):
        results = []
        for p in payload:
            results.append(await _handle_single_mutation(ctx, p, config))
        return results

    return await _handle_single_mutation(ctx, payload, config)


async def _handle_single_mutation(ctx: Any, payload: Any, config: Any) -> Dict[str, Any]:
    logger = getattr(config, "logger", None)
    plugins = getattr(config, "plugins", []) or []

    try:
        if not isinstance(payload, dict):
            return error_response({
                "code": "DFQL_INVALID",
                "message": "Invalid JSON",
                "details": {"path": "$"}
            })

        resource = payload.get("resource")
        if logger:
            logger.debug("Mutation request", {"resource": resource, "operation": payload.get("operation")})

        # Run before_mutation hooks
        if plugins:
            hook_result = await run_before_hook(plugins, "server", "before_mutation", ctx, payload, logger=logger)
            if not hook_result.get("ok"):
                if logger:
                    logger.error("Mutation rejected by plugin", {"error": hook_result.get("error", {}).get("message", "")})
                return hook_result
            payload = hook_result.get("value", payload)

        # Authorize
        if config.authorize:
            try:
                allowed = await config.authorize(ctx, "mutation", payload)
                if not allowed:
                    if logger:
                        logger.error("Mutation authorization denied", {"resource": resource})
                    return error_response({"code": "FORBIDDEN", "message": "Authorization denied", "details": {"path": "$"}})
            except Exception:
                if logger:
                    logger.error("Mutation authorization denied", {"resource": resource})
                return error_response({"code": "FORBIDDEN", "message": "Authorization denied", "details": {"path": "$"}})

        # Idempotency Check
        client_id = payload.get("clientId")
        mutation_id = payload.get("mutationId")

        if client_id and mutation_id:
            cached = await check_idempotency(config.db, "datafn", client_id, mutation_id)
            if cached:
                cached_result = dict(cached)
                cached_result["deduped"] = True
                return ok_response(cached_result)

        # Core Execution
        index = SchemaIndex(config.schema)
        limits = getattr(config, "limits", {}) or {}

        # Field-level authorization
        resource = payload.get("resource")
        if resource:
            authz_err = validate_mutation_authz(payload, resource, index)
            if authz_err:
                if logger:
                    logger.error("Mutation field authorization denied", {"code": authz_err.code, "message": authz_err.message})
                return authz_err.to_envelope()

        affected_ids, changes = await execute_mutation_core(config.db, index, payload, limits)

        result = {
            "ok": True,
            "mutationId": mutation_id,
            "affectedIds": affected_ids,
            "deduped": False,
            "errors": []
        }

        # Write change tracking
        if changes:
            for change in changes:
                try:
                    await _write_change(config.db, change)
                except Exception:
                    pass  # Change tracking failure is non-fatal

        # Store Idempotency
        if client_id and mutation_id:
            await store_idempotency(config.db, "datafn", client_id, mutation_id, result)

        response = ok_response(result)

        # Run after_mutation hooks
        if plugins:
            await run_after_hook(plugins, "server", "after_mutation", ctx, payload, response, logger=logger)

        if logger:
            logger.debug("Mutation completed", {"resource": resource})

        return response

    except DatafnError as e:
        if logger:
            logger.error("Mutation failed", {"code": e.code, "message": e.message})
        return e.to_envelope()
    except Exception as e:
        if logger:
            logger.error("Mutation failed", {"code": "INTERNAL", "message": str(e)})
        return error_response({
            "code": "INTERNAL",
            "message": str(e),
            "details": {}
        })


async def _write_change(db: Any, change: Dict[str, Any]) -> None:
    await db.create("__datafn_changes", change)


async def execute_mutation_core(
    db: Any, index: SchemaIndex, payload: Dict[str, Any], limits: Optional[Dict[str, Any]] = None
) -> tuple:
    """
    Executes a single mutation payload.
    Returns (affected_ids, changes) tuple.
    """
    limits = limits or {}
    resource = payload.get("resource")
    operation = payload.get("operation")

    if not resource:
        raise DatafnError(code="DFQL_INVALID", message="Missing resource", details={"path": "resource"})

    err = validate_resource(index, resource, "resource")
    if err:
        raise err

    # ID length validation
    record_id = payload.get("id")
    max_id_length = limits.get("maxIdLength", 255)
    id_err = validate_id_length(record_id, max_id_length)
    if id_err:
        raise id_err

    # Batch insert via records[]
    records_list = payload.get("records")
    if records_list is not None:
        if not isinstance(records_list, list):
            raise DatafnError(code="DFQL_INVALID", message="records must be an array", details={"path": "records"})

        # Batch size limit
        batch_err = validate_mutation_limits(payload, limits)
        if batch_err:
            raise batch_err

        affected_ids = []
        changes = []
        for i, rec in enumerate(records_list):
            # Prototype pollution check
            poisoned = check_prototype_pollution(rec)
            if poisoned:
                raise DatafnError(code="DFQL_INVALID", message=f"Prototype pollution detected: {poisoned}", details={"path": f"records[{i}]"})

            # ID length check per record
            rec_id = rec.get("id")
            id_err = validate_id_length(rec_id, max_id_length)
            if id_err:
                raise id_err

            # Field validation
            err = validate_record_keys(index, resource, rec, f"records[{i}]")
            if err:
                raise err

            type_errors = validate_record_types(rec, resource, index)
            if type_errors:
                raise DatafnError(code="DFQL_INVALID", message=type_errors[0], details={"path": f"records[{i}]"})

            # Required fields + defaults for insert
            missing = validate_required_fields(rec, resource, index)
            if missing:
                raise DatafnError(code="DFQL_INVALID", message=f"Required field '{missing[0]}' missing", details={"path": f"records[{i}]"})

            rec = apply_defaults(rec, resource, index)

            try:
                await db.create(resource, rec)
            except Exception as e:
                code = classify_error(e)
                raise DatafnError(code=code, message=str(e), details={"path": f"records[{i}]"})

            rid = rec.get("id")
            if rid:
                affected_ids.append(rid)
                changes.append({"table": resource, "operation": "insert", "recordId": rid})

        return affected_ids, changes

    # Single record path
    record = payload.get("record", {})

    # Prototype pollution check
    poisoned = check_prototype_pollution(record)
    if poisoned:
        raise DatafnError(code="DFQL_INVALID", message=f"Prototype pollution detected: {poisoned}", details={"path": "record"})

    # Guard Evaluation
    guard = payload.get("if")

    if guard:
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Guard requires id", details={"path": "id"})

        # When adapter supports transactions, wrap guard+mutation atomically
        if hasattr(db, "transaction"):
            async with db.transaction() as tx_db:
                match = await evaluate_guard(tx_db, resource, record_id, guard, tx_db=tx_db)
                if not match:
                    raise DatafnError(code="CONFLICT", message="Guard condition not met", details={"path": "if"})
                # Execute mutation within the same transaction, guard already passed
                payload_no_guard = {k: v for k, v in payload.items() if k != "if"}
                return await execute_mutation_core(tx_db, index, payload_no_guard, limits)
        else:
            # No transaction support — sequential with TOCTOU risk
            match = await evaluate_guard(db, resource, record_id, guard)
            if not match:
                raise DatafnError(code="CONFLICT", message="Guard condition not met", details={"path": "if"})

    affected_ids = []
    changes = []

    if operation == "insert":
        err = validate_record_keys(index, resource, record, "record")
        if err:
            raise err

        type_errors = validate_record_types(record, resource, index)
        if type_errors:
            raise DatafnError(code="DFQL_INVALID", message=type_errors[0], details={"path": "record"})

        # Required fields + defaults
        missing = validate_required_fields(record, resource, index)
        if missing:
            raise DatafnError(code="DFQL_INVALID", message=f"Required field '{missing[0]}' missing", details={"path": "record"})

        record = apply_defaults(record, resource, index)

        if "id" not in record and record_id:
            record["id"] = record_id

        try:
            await db.create(resource, record)
        except Exception as e:
            code = classify_error(e)
            raise DatafnError(code=code, message=str(e), details={"path": "record"})

        rid = record.get("id")
        affected_ids.append(rid)
        changes.append({"table": resource, "operation": "insert", "recordId": rid})

    elif operation == "merge":
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Missing id", details={"path": "id"})

        err = validate_record_keys(index, resource, record, "record")
        if err:
            raise err

        type_errors = validate_record_types(record, resource, index)
        if type_errors:
            raise DatafnError(code="DFQL_INVALID", message=type_errors[0], details={"path": "record"})

        # Merge decision: check existence
        existing = await db.find_one(resource, [{"field": "id", "operator": "eq", "value": record_id}])

        if existing:
            # Update path — partial merge, no required field check
            try:
                await db.update(resource, [{"field": "id", "operator": "eq", "value": record_id}], record)
            except Exception as e:
                code = classify_error(e)
                raise DatafnError(code=code, message=str(e), details={"path": "record"})
            changes.append({"table": resource, "operation": "update", "recordId": record_id})
        else:
            # Insert path — validate required fields, apply defaults
            missing = validate_required_fields(record, resource, index)
            if missing:
                raise DatafnError(code="DFQL_INVALID", message=f"Required field '{missing[0]}' missing", details={"path": "record"})

            record = apply_defaults(record, resource, index)
            record["id"] = record_id

            try:
                await db.create(resource, record)
            except Exception as e:
                code = classify_error(e)
                raise DatafnError(code=code, message=str(e), details={"path": "record"})
            changes.append({"table": resource, "operation": "insert", "recordId": record_id})

        affected_ids.append(record_id)

    elif operation == "replace":
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Missing id", details={"path": "id"})

        # Fetch existing to preserve system fields
        existing = await db.find_one(resource, [{"field": "id", "operator": "eq", "value": record_id}])

        # Build replacement record: all schema fields set to null or default
        all_writable = index.writable_fields_by_resource.get(resource, set())
        defaults = index.field_defaults.get(resource, {})

        replace_record = {}
        for f in all_writable:
            if f in RESERVED_FIELDS:
                continue
            replace_record[f] = defaults.get(f, None)

        # Apply incoming record (strip readonly/system fields from input)
        readonly = index.readonly_fields.get(resource, set())
        for key, value in record.items():
            if key in readonly or key in RESERVED_FIELDS:
                continue
            replace_record[key] = value

        # Type validation on the final replacement
        type_errors = validate_record_types(replace_record, resource, index)
        if type_errors:
            raise DatafnError(code="DFQL_INVALID", message=type_errors[0], details={"path": "record"})

        try:
            await db.update(resource, [{"field": "id", "operator": "eq", "value": record_id}], replace_record)
        except Exception as e:
            code = classify_error(e)
            raise DatafnError(code=code, message=str(e), details={"path": "record"})

        affected_ids.append(record_id)
        changes.append({"table": resource, "operation": "update", "recordId": record_id})

    elif operation == "delete":
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Missing id", details={"path": "id"})

        # Idempotent delete: check existence first
        existing = await db.find_one(resource, [{"field": "id", "operator": "eq", "value": record_id}])
        if existing:
            try:
                await db.delete(resource, [{"field": "id", "operator": "eq", "value": record_id}])
            except Exception as e:
                code = classify_error(e)
                raise DatafnError(code=code, message=str(e), details={"path": "id"})
            affected_ids.append(record_id)
            changes.append({"table": resource, "operation": "delete", "recordId": record_id})
        # If not exists: return empty affectedIds, no change tracking

    elif operation == "relate":
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Missing id", details={"path": "id"})
        await execute_relate(db, index, payload)
        affected_ids.append(record_id)

    elif operation == "modifyRelation":
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Missing id", details={"path": "id"})
        await execute_modify_relation(db, index, payload)
        affected_ids.append(record_id)

    elif operation == "unrelate":
        if not record_id:
            raise DatafnError(code="DFQL_INVALID", message="Missing id", details={"path": "id"})
        await execute_unrelate(db, index, payload)
        affected_ids.append(record_id)

    else:
        raise DatafnError(code="DFQL_INVALID", message=f"Unknown operation: {operation}", details={"path": "operation"})

    return affected_ids, changes
