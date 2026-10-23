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
from superfunctions.db import Adapter # Import your specific adapter
from catchfn import CatchFnService, create_catchfn_router
from superfunctions.fastapi import to_fastapi # Hypothetical adapter

app = FastAPI()
db = Adapter(...) # Initialize your DB adapter

service = CatchFnService(db)
router = create_catchfn_router(service)

# Mount the router
app.include_router(to_fastapi(router), prefix="/api/catchfn")
```

## Features

- Works with `superfunctions` abstractions
- Stores bug reports with full context
- Pydantic models for type safety
