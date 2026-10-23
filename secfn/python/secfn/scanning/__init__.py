"""Secret scanning module."""

from .patterns import DEFAULT_PATTERNS
from .scanner import SecretScanner, SecretScannerConfig

__all__ = ["SecretScanner", "SecretScannerConfig", "DEFAULT_PATTERNS"]
