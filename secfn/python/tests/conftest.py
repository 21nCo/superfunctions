"""Pytest configuration and fixtures."""

import os
import shutil
import tempfile
from pathlib import Path

import pytest

from secfn import SecFnConfig, create_secfn
from secfn.storage import FileStorage


@pytest.fixture
def temp_storage_path():
    """Create a temporary storage directory."""
    temp_dir = tempfile.mkdtemp(prefix="secfn_test_")
    yield temp_dir
    # Cleanup
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
def file_storage(temp_storage_path):
    """Create a FileStorage instance."""
    return FileStorage(temp_storage_path)


@pytest.fixture
def secfn_instance(temp_storage_path):
    """Create a SecFn instance with test configuration."""
    return create_secfn(
        SecFnConfig(master_key="test-master-key-do-not-use-in-production", storage_path=temp_storage_path)
    )


@pytest.fixture
def master_key():
    """Test master key."""
    return "test-master-key-for-encryption"
