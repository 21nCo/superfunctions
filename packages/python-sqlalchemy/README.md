# superfunctions-sqlalchemy

SQLAlchemy adapter for `superfunctions.db`

**Location:** `packages/python-sqlalchemy/`  
**Package:** `superfunctions-sqlalchemy`  
**Import:** `from superfunctions_sqlalchemy import create_adapter`

Version 0.1.1 requires `superfunctions-core>=0.1.1,<0.2.0`, including typed AND/OR query connectors and the current adapter error and capability models.

## Installation

```bash
pip install superfunctions-sqlalchemy

# With PostgreSQL
pip install superfunctions-sqlalchemy[postgres]

# With MySQL
pip install superfunctions-sqlalchemy[mysql]

# Optional async driver dependency for applications that also use SQLAlchemy async APIs separately
pip install superfunctions-sqlalchemy[asyncpg]
```

## Usage

```python
from sqlalchemy import create_engine
from superfunctions_sqlalchemy import create_adapter

# Create SQLAlchemy engine
engine = create_engine("postgresql://user:password@localhost/dbname")

# Create adapter
adapter = create_adapter(engine)

# Use with superfunctions libraries
from authfn import create_authfn, AuthFnConfig

auth = create_authfn(
    AuthFnConfig(
        database=adapter,
        namespace="authfn",
    )
)
```

## Features

- ✅ Full CRUD operations
- ✅ Transaction support
- ✅ Batch operations
- ✅ Query builders (where, orderBy, limit, offset)
- ✅ All SQL operators
- ✅ Works with PostgreSQL, MySQL, SQLite
- ✅ Sync SQLAlchemy engines

## Example

```python
import asyncio

from sqlalchemy import create_engine
from superfunctions_sqlalchemy import create_adapter
from superfunctions.db import CreateParams, FindManyParams, WhereClause, Operator

async def main() -> None:
    engine = create_engine("postgresql://localhost/mydb")
    adapter = create_adapter(engine)

    # Create
    user = await adapter.create(
        CreateParams(
            model="users",
            data={"name": "Alice", "email": "alice@example.com"},
        )
    )

    # Query
    users = await adapter.find_many(
        FindManyParams(
            model="users",
            where=[
                WhereClause(field="email", operator=Operator.LIKE, value="%@example.com")
            ],
            limit=10,
        )
    )

    print(user, users)


asyncio.run(main())
```

## License

MIT

### Atomic conditional updates inside transactions

The SQLAlchemy transaction adapter supports `update_many(UpdateManyParams(...))`
(or equivalent keyword arguments) on its existing transaction connection. Every
WHERE predicate remains in one SQL UPDATE, and the method returns the driver's
row count. For optimistic concurrency, include the expected revision and update
that revision; require exactly one changed row before creating related records
in the same transaction. A stale revision returns zero. Raising from the callback
rolls back both the conditional update and other transaction writes.

`superfunctions.db.AtomicUpdateTransactionAdapter` describes this optional
extension without changing the existing `TransactionAdapter` protocol. Consumers
must feature-detect `callable(getattr(transaction, 'update_many', None))` and reject
adapters that lack it. Do not emulate a conditional update using a read followed
by an ordinary update. Driver no-op/unknown row-count behavior is unchanged;
revision-changing CAS must fail closed unless the result is exactly one.
