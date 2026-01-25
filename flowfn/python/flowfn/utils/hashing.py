"""Hashing utilities for job deduplication."""

import hashlib
import json
from typing import Any


def hash_job(data: Any) -> str:
    """Generate SHA-256 hash of job data."""
    # Convert to stable JSON string
    json_str = json.dumps(data, sort_keys=True, default=str)
    
    # Create hash
    hash_obj = hashlib.sha256(json_str.encode('utf-8'))
    return hash_obj.hexdigest()


def generate_deduplication_key(queue_name: str, data_hash: str) -> str:
    """Generate deduplication key for a job."""
    return f"{queue_name}:{data_hash}"


def are_jobs_equivalent(job1_data: Any, job2_data: Any) -> bool:
    """Check if two jobs have equivalent data."""
    return hash_job(job1_data) == hash_job(job2_data)
