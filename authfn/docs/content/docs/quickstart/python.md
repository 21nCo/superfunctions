---
title: Python (FastAPI / Flask)
description: Run authfn on a Python backend — same routes, same envelopes, same OpenAPI as the TypeScript kernel.
---

# Python quickstart

The Python `authfn` package mirrors the TypeScript kernel: same routes, same envelopes, same plugin set, same OpenAPI surface. You can serve a Python and a Node authfn instance side-by-side and clients won't be able to tell them apart.

## 1. Install

```bash
pip install authfn
pip install superfunctions-fastapi
pip install superfunctions-flask
```

## 2. Create the runtime

```python
# auth.py
from authfn import (
    AuthFnConfig,
    authfn_email_otp_plugin,
    authfn_password_plugin,
    authfn_social_oauth_plugin,
    create_authfn,
)
from authfn.plugins.social_oauth import SocialOAuthPluginConfig, SocialProviderConfig

# Replace `my_database_adapter` with your real adapter; see Adapters > Database.
auth = create_authfn(AuthFnConfig(
    database=my_database_adapter,
    namespace="authfn",
    plugins=[
        authfn_password_plugin(),
        authfn_email_otp_plugin({
            "delivery": my_delivery_provider,
        }),
        authfn_social_oauth_plugin(SocialOAuthPluginConfig(
            providers={
                "google": SocialProviderConfig(
                    client_id="...",
                    client_secret="...",
                    allowlisted_return_to=["https://app.example.com/post-auth"],
                ),
            },
            # Secret key (at least 32 bytes) that encrypts stored provider
            # tokens. Required: sign-in fails with AUTHFN_CONFIG_INVALID without it.
            encryption_key_resolver=lambda key_ref: load_secret(key_ref),
        )),
    ],
))
```

Upgrading from a release that stored social OAuth tokens without a configured key? Those tokens were encrypted with a key anyone can compute. Re-encrypt them once with `await SocialOAuthService(config, plugin_config).token_vault.migrate_legacy_tokens()`. If your resolver only knows a new key reference, pass it: `migrate_legacy_tokens(destination_key_ref="oauth-2026")` re-encrypts every legacy row under that reference.

## 3. Mount on FastAPI

```python
# main.py
from fastapi import FastAPI, Request
from superfunctions_fastapi import create_router
from auth import auth

app = FastAPI()
app.include_router(create_router(auth.get_routes()))

@app.get("/protected")
async def protected(request: Request):
    session = await auth.provider.authenticate(request)
    if not session:
        return {"error": "unauthorized"}, 401
    return {"user": session.primary_email}
```

## 4. Or mount on Flask

```python
# main.py
from flask import Flask, request
from superfunctions_flask import create_blueprint
from auth import auth

app = Flask(__name__)
app.register_blueprint(create_blueprint(auth.get_routes()))

@app.get("/protected")
async def protected():
    session = await auth.provider.authenticate(request)
    if not session:
        return {"error": "unauthorized"}, 401
    return {"user": session.primary_email}
```

## 5. Generate OpenAPI

```python
document = auth.open_api()
```

The output is identical in shape to the Node kernel's `auth.openApi()`.

## Next steps

- [SDKs → Python](../sdk/python) for full reference on Python types, error model, configuration, and advanced patterns.
- [Frameworks → FastAPI](../frameworks/fastapi), [Flask](../frameworks/flask), [Starlette](../frameworks/starlette).
- [Adapters → Database](../adapters/database) — Python supports SQLAlchemy adapters; the contract matches the Node kernel.
