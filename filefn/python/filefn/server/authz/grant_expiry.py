from datetime import datetime, timezone
from typing import Any


def is_grant_expired(expires_at: Any) -> bool:
    """Whether a grant's expiresAt has passed. A value that does not parse counts as expired."""
    if expires_at is None or expires_at == "":
        return False
    if not isinstance(expires_at, str):
        return True
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed <= datetime.now(timezone.utc)
