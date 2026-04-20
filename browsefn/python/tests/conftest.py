"""
Test configuration
"""

# pytest configuration
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "browsefn" / "python"))
sys.path.insert(0, str(ROOT / "packages" / "python-core"))


def pytest_configure(config):
    """Configure pytest"""
    config.addinivalue_line(
        "markers", "asyncio: mark test as async"
    )
