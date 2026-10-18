# catchfn

Python server implementation for CatchFn bug reporting.

## Installation

```bash
pip install catchfn sfns
```

## Usage

### FastAPI Example

```python
from fastapi import FastAPI
from superfunctions.db import Adapter  # Import your specific adapter
from catchfn import CatchFnService, create_catchfn_router
from superfunctions.fastapi import to_fastapi  # Hypothetical adapter

app = FastAPI()
db = Adapter(...)  # Initialize your DB adapter

service = CatchFnService(db)
router = create_catchfn_router(service)

# Mount the router
app.include_router(to_fastapi(router), prefix="/api/catchfn")
```

## Features

- Works with `superfunctions` abstractions
- Stores bug reports with full context
- Pydantic models for type safety

## Runtime and schema

The repaired distribution uses `superfunctions-core` and requires Python 3.10 or newer, matching the shared runtime. The former scaffold advertised Python 3.8 but depended on `sfns` and unavailable HTTP/DB APIs. Python 3.8 remains an unfulfilled historical support gate; this correction is not evidence of that compatibility.

Use `get_sqlalchemy_table(metadata)` to include CatchFn's table and indexes in application-owned migrations, then pass a shared SQLAlchemy adapter to `CatchFnService`. The service stores a JSON snapshot and uses server receipt time for retention. `create_catchfn_router` returns shared `RouterOptions` for FastAPI/Flask adapters. Bind an application scope on the service and supply the authorization callback or mount behind application authentication.
