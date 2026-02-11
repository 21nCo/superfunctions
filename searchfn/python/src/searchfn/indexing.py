import re
from typing import Any, Dict, List, Optional

DEFAULT_PREFIX = "_searchfn_"

def tokenize(text: str) -> List[str]:
    if not text:
        return []
    # Simple tokenizer similar to TS version
    clean = re.sub(r'[^\w\s]', '', str(text).lower())
    return [t for t in clean.split() if len(t) > 2]

async def index_data(
    schema: Any, 
    db: Any, 
    model: Optional[str] = None, 
    table_prefix: str = DEFAULT_PREFIX
) -> Dict[str, Any]:
    index_table = f"{table_prefix}index"
    
    # Python equivalent of accessing schema.models
    # Assuming schema is a dict or object with 'models' attribute
    models = getattr(schema, "models", schema.get("models") if isinstance(schema, dict) else {})
    
    target_models = [model] if model else list(models.keys())
    total_indexed = 0
    
    for model_name in target_models:
        model_def = models.get(model_name)
        if not model_def:
            continue
            
        # Identify string fields
        # Assuming model_def structure matches DataFn schema
        fields = model_def.get("fields", {})
        string_fields = [
            name for name, f in fields.items() 
            if f.get("type") == "string"
        ]
        
        if not string_fields:
            continue
            
        # Fetch records
        records = await db.find_many(model_name, {})
        
        for record in records:
            record_id = record.get("id")
            if not record_id:
                continue
                
            for field in string_fields:
                val = record.get(field)
                if isinstance(val, str):
                    tokens = tokenize(val)
                    for token in tokens:
                        # Write to index
                        try:
                            await db.create(index_table, {
                                "term": token,
                                "model": model_name,
                                "recordId": str(record_id),
                                "field": field
                            })
                        except Exception:
                            pass # Ignore duplicates/errors
            total_indexed += 1

    return {"totalIndexed": total_indexed}
