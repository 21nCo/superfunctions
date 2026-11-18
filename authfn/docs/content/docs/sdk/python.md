---
title: Python SDK
description: The authfn Python kernel — same routes, same envelopes, same OpenAPI as the TypeScript kernel, on FastAPI / Flask / Starlette.
---

# Python SDK

The `authfn` Python package is a port of the Node kernel. It exposes the same `create_authfn` factory, the same plugin set, the same envelopes, and the same OpenAPI document. A client written against a Node authfn server will work against a Python authfn server without modification.

```bash
pip install authfn
# database adapter used below
pip install superfunctions-sqlalchemy
# plus a framework adapter
pip install superfunctions-fastapi
pip install superfunctions-flask
```

## Mental model

If you've read [Concepts → Architecture](../core-concepts/architecture) for the Node kernel, the Python version is a one-to-one shape:

- `create_authfn(config)` returns an `AuthFnInstance`-shaped object with a `router`, a `provider`, `get_schema()`, and `open_api()`.
- Plugins are descriptor objects produced by factory functions (`authfn_password_plugin()`, `authfn_email_otp_plugin()`, …).
- Hooks are async callables registered under `config.hooks`.
- The router speaks WSGI, ASGI, and a couple of native framework adapters.

## Quick start

```python
from authfn import (
    AuthFnConfig,
    authfn_password_plugin,
    create_authfn,
)
from sqlalchemy import Column, DateTime, Index, Integer, JSON, MetaData, String, Table, create_engine
from superfunctions_sqlalchemy import create_adapter

engine = create_engine("sqlite+pysqlite:///authfn.db")
database = create_adapter(engine)

auth = create_authfn(AuthFnConfig(
    database=database,
    namespace="authfn",
    plugins=[
        authfn_password_plugin(),
    ],
))

# superfunctions-sqlalchemy reflects existing tables. Bootstrap this local
# database from authfn's logical schema before serving requests.
metadata = MetaData()
column_types = {
    "date": lambda: DateTime(timezone=True),
    "json": JSON,
    "number": Integer,
    "session": JSON,
    "string": String,
}
for table_schema in auth.get_schema()["schemas"]:
    columns = [
        Column(
            field_name,
            column_types.get(field["type"], String)(),
            primary_key=field_name == "id",
            nullable=not field.get("required", False),
        )
        for field_name, field in table_schema["fields"].items()
    ]
    table = Table(f"authfn_{table_schema['modelName']}", metadata, *columns)
    for index_schema in table_schema.get("indexes", []):
        Index(
            index_schema["name"],
            *(table.c[field_name] for field_name in index_schema["fields"]),
            unique=index_schema.get("unique", False),
        )

metadata.create_all(engine)
```

The SQLAlchemy adapter does not run migrations or translate authfn's logical
field names to physical column names. In production, create the same logical
tables with your migration tool before starting the application.

## Mounting

### FastAPI

```python
from fastapi import FastAPI, Request
from superfunctions_fastapi import create_router

app = FastAPI()
app.include_router(create_router(auth.get_routes()))

@app.get("/openapi-authfn.json")
async def openapi_authfn():
    return auth.open_api()
```

### Flask

```python
from flask import Flask
from superfunctions_flask import create_blueprint

app = Flask(__name__)
app.register_blueprint(create_blueprint(auth.get_routes()))

@app.get("/openapi-authfn.json")
def openapi_authfn():
    return auth.open_api()
```

### Starlette

There is no `superfunctions_starlette` adapter. Mount through FastAPI (`pip install authfn superfunctions-fastapi`) — see [Frameworks → FastAPI](../frameworks/fastapi).

## Reading the session

```python
from authfn import AuthFnError

try:
    session = await auth.provider.authenticate(request)
except AuthFnError:
    # A bad Authorization header raises (InvalidCredentialsError,
    # ApiKeyRevokedError, ExpiredCredentialsError), not None.
    return Response(status_code=401)
if session is None:
    return Response(status_code=401)
```

`auth.provider.authenticate` checks the cookie session first: a valid cookie session is returned even when the request also has an `Authorization` header. Otherwise it returns `None` when the request has no `Authorization` header (including a missing, revoked or expired session cookie) and raises an `AuthFnError` subclass for an `Authorization` header that does not authenticate.

`AuthFnSession` has these fields: `id`, `type`, `subject`, `actor_type`, `actor_id`, `credential`, `tenant_id`, `region_id`, `resource_ids`, `methods`, `primary_email`, `expires_at`, `metadata`. API-key sessions follow the TypeScript rules (`authfn` 0.5.0 and later); see below.

The Python SDK has no typed scopes yet. Its `AuthFnSession` has no `scopes` field for cookie or API-key sessions, and there is no scope registry or `requireScopes` check; those exist only in the TypeScript `authfn` package (0.6.0 and later). See [Plugins → API keys → Scopes](../plugins/api-keys#scopes).

### API key sessions

API-key sessions in the Python SDK (0.2.0 and later) follow the same rules as the TypeScript `authfn` package (0.5.0 and later):

- A user-owned key acts as its owner: `actor_type` is `'user'`, and `actor_id` and `subject.actor_id` are the owner's user ID. An unowned service key keeps `actor_type` `'api-key'` with the key ID as `actor_id`.
- Every API-key session carries `credential` (`AuthFnApiKeyCredential`, `type='api-key'` and the key ID as `id`). Check `session.type == "api-key"` or `session.credential is not None` to detect a key.
- A key whose owner was deleted or is disabled (`metadata["disabled"]` is `True` on the user record) fails authentication: `ApiKeyService.authenticate` returns `None`, no session is issued and the key's `lastUsedAt` is not updated. Through `auth.provider.authenticate` (the example above), a valid cookie session on the same request still takes precedence; otherwise the key raises `InvalidCredentialsError`, as any `Authorization` header that does not authenticate does. The placement-context issuer applies the same check and raises `UnauthorizedError`. Re-enabling the owner restores the key. In a placement context, an owned key's `subject` is its owner and `actor_type` stays `'api-key'`, as in TypeScript; an unowned key gets no placement context.
- A revoked key raises `ApiKeyRevokedError`, as in TypeScript. An expired key raises `ExpiredCredentialsError`, where TypeScript returns no session.
- `metadata["ownerUserId"]` (the owner's ID, or `None` for an unowned key) and `metadata["scopes"]` (the key's stored scopes) are written after the metadata stored on the key, so stored metadata cannot override them. Read `actor_id` instead of `ownerUserId`.

The Python SDK has no typed scopes: an API-key session has no `scopes` field and there is no `require_scopes` check, so `metadata["scopes"]` is display data, not a grant. See [Plugins → API keys](../plugins/api-keys#authentication-via-api-key) for the shared rules.

## Hooks

```python
async def before_user_create(ctx, payload):
    if is_disposable(payload["primaryEmail"]):
        raise AuthFnValidationError("disposable emails are not allowed")
    return payload

create_authfn(AuthFnConfig(
    # ...
    hooks={
        "before_user_create": before_user_create,
    },
))
```

Hook names use Python's `snake_case`. The behavior matches the Node kernel.

## Adapters

Pass any Superfunctions `db` adapter as `AuthFnConfig.database`. There is no `authfn.adapters` package.

- Tests and examples typically use a local in-memory adapter that implements the contract.
- Production Python apps use `superfunctions_sqlalchemy.create_adapter(engine)` for Postgres / SQLite.

The contract matches the Node adapter — see [Adapters → Database](../adapters/database).

## OpenAPI parity

```python
document = auth.open_api()
```

The output is byte-for-byte equivalent to the Node kernel's `auth.openApi()` for the same plugin set. CI diffs them.

## Type stubs

`authfn` ships type stubs (`authfn-stubs`). All public API is typed.

## Cross-language deployments

A common pattern is a Python data-science backend that uses a Node-served authfn for sign-in. As long as both share the same database (and the same `namespace`), they're interchangeable. The session cookie / bearer token works against either.

If you go this route, lock the kernel versions on both sides to versions that share the same wire contract. The [changelog](../reference/changelog) documents wire-contract bumps.

## Placement-bound auth context

Trusted gateway code can derive an immutable routing context after a valid session. This is opt-in and is not a public AuthFn route. See [Placement-bound auth context](../recipes/placement-bound-auth-context).

```python
from authfn import create_placement_context_issuer

issuer = create_placement_context_issuer(
    region_id="us-east-1",  # region owning config.database
    config=config,
    public_authority="https://account.example.com",
    placement_directory=directory,
    identity_key_for_user_id=identity_keys.from_user_id,
    subject_secret=subject_secret,
    audiences=["nucleum-datafn"],
)
context = await issuer.derive(request)
```

## Related

- [Quickstart → Python](../quickstart/python)
- [Frameworks → FastAPI / Flask / Starlette](../frameworks)
- [Adapters → Database](../adapters/database)
- [Recipes → Placement-bound auth context](../recipes/placement-bound-auth-context)
