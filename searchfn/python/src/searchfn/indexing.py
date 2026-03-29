from typing import Any, Dict, Optional

from .utils import DEFAULT_PREFIX, get_schema_models, tokenize


def _is_duplicate_error(error: Exception) -> bool:
    message = str(error).lower()
    return (
        "duplicate" in message
        or "unique constraint" in message
        or "already exists" in message
    )


async def index_data(
    schema: Any,
    db: Any,
    model: Optional[str] = None,
    table_prefix: str = DEFAULT_PREFIX,
) -> Dict[str, Any]:
    index_table = f"{table_prefix}index"
    models = get_schema_models(schema)

    target_models = [model] if model else list(models.keys())
    total_indexed = 0
    total_terms = 0

    for model_name in target_models:
        model_def = models.get(model_name)
        if not isinstance(model_def, dict):
            continue

        fields = model_def.get("fields", {})
        if not isinstance(fields, dict):
            continue

        string_fields = [
            name for name, field in fields.items()
            if isinstance(field, dict) and field.get("type") == "string"
        ]
        if not string_fields:
            continue

        records = await db.find_many(model_name, [])

        for record in records:
            if not isinstance(record, dict):
                continue

            record_id = record.get("id")
            if record_id is None:
                continue

            indexed_terms_for_record = 0
            await db.delete(index_table, [
                {"field": "model", "operator": "eq", "value": model_name},
                {"field": "recordId", "operator": "eq", "value": str(record_id)},
            ])

            for field in string_fields:
                value = record.get(field)
                if not isinstance(value, str):
                    continue

                for token in tokenize(value):
                    try:
                        await db.create(index_table, {
                            "term": token,
                            "model": model_name,
                            "recordId": str(record_id),
                            "field": field,
                        })
                    except Exception as error:
                        if _is_duplicate_error(error):
                            continue
                        raise
                    indexed_terms_for_record += 1

            if indexed_terms_for_record > 0:
                total_indexed += 1
                total_terms += indexed_terms_for_record

    return {
        "totalIndexed": total_indexed,
        "totalTerms": total_terms,
    }
