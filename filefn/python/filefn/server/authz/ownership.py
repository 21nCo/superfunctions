from typing import Any, Optional

ANONYMOUS_PRINCIPAL_ID = "anonymous"


def is_anonymous_principal(principal_id: Optional[str]) -> bool:
    """Whether the caller is unauthenticated (no principal, or the shared ``anonymous`` ID)."""
    return not principal_id or principal_id == ANONYMOUS_PRINCIPAL_ID


def is_file_owner(file: Any, ctx: Any) -> bool:
    """Whether the caller owns the file.

    Every unauthenticated caller shares the principal ``anonymous``, so nobody
    owns a file uploaded anonymously: it is readable only through its
    visibility, a grant or a share link.
    """
    principal_id = getattr(ctx, "principalId", None)
    if is_anonymous_principal(principal_id):
        return False
    owner_id = getattr(file, "ownerId", None)
    return bool(owner_id) and owner_id == principal_id
