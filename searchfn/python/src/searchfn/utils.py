import re
from typing import Any, Dict, List

DEFAULT_PREFIX = "_searchfn_"


def tokenize(text: str) -> List[str]:
    if not text:
        return []
    clean = re.sub(r"[^\w\s]", "", str(text).lower())
    return [token for token in clean.split() if len(token) > 2]


def get_schema_models(schema: Any) -> Dict[str, Dict[str, Any]]:
    if isinstance(schema, dict):
        resources = schema.get("resources")
        if isinstance(resources, dict):
            return resources
        models = schema.get("models")
        if isinstance(models, dict):
            return models
        return {}

    resources = getattr(schema, "resources", None)
    if isinstance(resources, dict):
        return resources

    models = getattr(schema, "models", None)
    if isinstance(models, dict):
        return models

    return {}
