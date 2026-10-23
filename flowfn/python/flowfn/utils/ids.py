"""ID generation utilities."""

import uuid
import time
from typing import Literal, Optional


IDStrategy = Literal['uuid-v4', 'uuid-v1', 'nanoid', 'timestamp', 'deterministic']


def generate_id(strategy: IDStrategy = 'uuid-v4', *args: str) -> str:
    """Generate ID using specified strategy."""
    if strategy == 'uuid-v4':
        return str(uuid.uuid4())
    
    elif strategy == 'uuid-v1':
        return str(uuid.uuid1())
    
    elif strategy == 'nanoid':
        # Simple nanoid-like implementation
        import random
        import string
        alphabet = string.ascii_letters + string.digits + '_-'
        return ''.join(random.choices(alphabet, k=21))
    
    elif strategy == 'timestamp':
        return f"{int(time.time() * 1000000)}"
    
    elif strategy == 'deterministic':
        # UUID v5 based on namespace and name
        namespace = args[0] if args else 'default'
        name = args[1] if len(args) > 1 else str(uuid.uuid4())
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{namespace}:{name}"))
    
    else:
        return str(uuid.uuid4())


def generate_job_id() -> str:
    """Generate a job ID."""
    return generate_id('uuid-v4')


def generate_execution_id() -> str:
    """Generate a workflow execution ID."""
    return generate_id('uuid-v4')


def generate_message_id() -> str:
    """Generate a message ID."""
    return generate_id('uuid-v4')
