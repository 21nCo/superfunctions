
# Problem
- There are too many payment providers and many app stores to integrate with for a software provider to enable subscriptions or payments
- Other parts of the app should be able to use one source of truth for subscription information like status, plan, quotas, usage, etc


---
# Solution

- `@billfn/core` - Core library with types, shared primitives, schema, validation, normalization, error handling, etc
- `@billfn/client` - Client SDK for frontend clients (typescript)
- `@billfn/server` - Server SDK for backend servers (typescript, python)
- `@billfn/admin` - Admin SDK for managing plans, payments, configuration etc
- `@uifn/billing` - UI library for displaying subscription information
- Admin UI - Admin UI for managing plans, payments, configuration etc (connects to `@billfn/admin` exposed endpoints)