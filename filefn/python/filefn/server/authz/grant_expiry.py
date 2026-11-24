import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

# ISO 8601 calendar date, or date-time with optional seconds, fraction and
# zone (an offset with or without its colon); the same forms the TypeScript
# server accepts. A date-time without a
# zone is read as UTC.
# ASCII digits only and a full match: `\d` would accept other scripts' digits
# and `$` a trailing newline, which the TypeScript parser refuses.
_ISO_INSTANT = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?"
)


def parse_iso_instant(value: Any) -> Optional[datetime]:
    """Parses an ISO 8601 date or date-time to an aware UTC datetime, or None when it is not one."""
    if not isinstance(value, str):
        return None
    match = _ISO_INSTANT.fullmatch(value)
    if not match:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        parsed = datetime(
            int(year),
            int(month),
            int(day),
            int(hour or 0),
            int(minute or 0),
            int(second or 0),
            int(((fraction or ".")[1:] + "000000")[:6]),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None
    if zone and zone != "Z":
        zone_hours, zone_minutes = int(zone[1:3]), int(zone[-2:])
        if zone_hours > 23 or zone_minutes > 59:
            return None
        offset = timedelta(hours=zone_hours, minutes=zone_minutes)
        try:
            parsed = parsed - offset if zone[0] == "+" else parsed + offset
        except OverflowError:
            # Outside years 1-9999 once converted to UTC.
            return None
    return parsed


def is_grant_expired(expires_at: Any) -> bool:
    """Whether a grant's or share link's expiresAt has passed. A value that is not ISO 8601 counts as expired."""
    if expires_at is None or expires_at == "":
        return False
    parsed = parse_iso_instant(expires_at)
    return parsed is None or parsed <= datetime.now(timezone.utc)
