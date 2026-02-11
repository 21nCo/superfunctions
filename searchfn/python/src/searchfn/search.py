import re
from typing import Any, Dict, List, Optional
from collections import defaultdict

DEFAULT_PREFIX = "_searchfn_"

def tokenize(text: str) -> List[str]:
    if not text:
        return []
    clean = re.sub(r'[^\w\s]', '', str(text).lower())
    return [t for t in clean.split() if len(t) > 2]

async def search_index(
    schema: Any,
    db: Any,
    query: str,
    model: Optional[str] = None,
    limit: int = 20,
    table_prefix: str = DEFAULT_PREFIX
) -> List[Dict[str, Any]]:
    index_table = f"{table_prefix}index"
    tokens = tokenize(query)
    
    if not tokens:
        return []
        
    matches = []
    for token in tokens:
        where_clause = {"term": token}
        if model:
            where_clause["model"] = model
            
        token_matches = await db.find_many(index_table, where_clause)
        matches.extend(token_matches)
        
    # Aggregate and score
    scores = defaultdict(lambda: {"score": 0, "matches": []})
    
    for match in matches:
        key = f"{match['model']}:{match['recordId']}"
        entry = scores[key]
        if entry["score"] == 0:
            entry["id"] = match["recordId"]
            entry["model"] = match["model"]
            
        entry["score"] += 1
        entry["matches"].append(match["term"])
        
    # Sort
    results = sorted(scores.values(), key=lambda x: x["score"], reverse=True)
    return results[:limit]
