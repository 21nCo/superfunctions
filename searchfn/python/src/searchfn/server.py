from typing import Any, Dict, Optional, List
from .indexing import index_data
from .search import search_index

def create_searchfn_server(config: Dict[str, Any]) -> Dict[str, Any]:
    schema = config.get("schema")
    db = config.get("db")
    table_prefix = config.get("table_prefix", "_searchfn_")

    async def index_handler(ctx: Any, payload: Any) -> Dict[str, Any]:
        # Payload might be the request body if using datafn conventions
        # or we assume payload contains 'model'
        # Adjust based on how superfunctions http abstraction passes body
        
        model = payload.get("model") if isinstance(payload, dict) else None
        
        result = await index_data(schema, db, model, table_prefix)
        return {"ok": True, "result": result}

    async def search_handler(ctx: Any, payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid payload"}
            
        query = payload.get("query")
        model = payload.get("model")
        limit = payload.get("limit", 20)
        
        if not query:
            return {"ok": False, "error": "Missing query"}

        results = await search_index(schema, db, query, model, limit, table_prefix)
        return {"ok": True, "results": results}

    return {
        "routes": {
            "POST /searchfn/index": index_handler,
            "POST /searchfn/search": search_handler,
        }
    }
