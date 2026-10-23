"""Default secret patterns for scanning."""

from ..types import SecretPattern, Severity

DEFAULT_PATTERNS = [
    SecretPattern(
        name="AWS Access Key",
        pattern=r"AKIA[0-9A-Z]{16}",
        entropy=4.5,
        description="AWS Access Key ID",
        severity=Severity.CRITICAL,
    ),
    SecretPattern(
        name="Generic API Key",
        pattern=r"api[_-]?key[_-]?[=:]\s*['\"]?([a-zA-Z0-9]{32,})",
        entropy=4.0,
        description="Generic API key pattern",
        severity=Severity.HIGH,
    ),
    SecretPattern(
        name="Private Key",
        pattern=r"-----BEGIN (RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----",
        description="Private cryptographic key",
        severity=Severity.CRITICAL,
    ),
    SecretPattern(
        name="JWT Token",
        pattern=r"eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+",
        description="JSON Web Token",
        severity=Severity.HIGH,
    ),
    SecretPattern(
        name="GitHub Token",
        pattern=r"gh[pousr]_[A-Za-z0-9_]{36,}",
        entropy=4.5,
        description="GitHub personal access token",
        severity=Severity.CRITICAL,
    ),
    SecretPattern(
        name="Slack Token",
        pattern=r"xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}",
        description="Slack API token",
        severity=Severity.HIGH,
    ),
    SecretPattern(
        name="Database Connection String",
        pattern=r"(postgres|mysql|mongodb)://[^:]+:[^@]+@[^/]+",
        description="Database connection string with credentials",
        severity=Severity.CRITICAL,
    ),
]
