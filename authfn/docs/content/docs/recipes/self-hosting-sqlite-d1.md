---
title: Self-hosting authfn on SQLite and D1
description: Run password sign-in, sessions and API keys on a single SQLite file or on Cloudflare D1 through @superfunctions/db.
---

# Self-hosting authfn on SQLite and D1

## Goal

Run authfn with the password and API key plugins on SQLite: a local
better-sqlite3 file on Node, or Cloudflare D1 on Workers. Both use the same
generated schema and the same migration.

## What is verified

The [SQLite storage conformance suite](https://github.com/21nCo/super-functions/tree/dev/authfn/core/src/__tests__/sqlite)
runs in CI against better-sqlite3 on Node 22 and against a local D1 database
in workerd (Miniflare). It applies the migration below to an empty database
and covers:

- sign-up, password sign-in and wrong-password rejection;
- session create, validate (cookie and bearer), revoke and expiry;
- API key create (secret shown once), validate, revoke, expiry and last-used updates;
- the unique indexes, including concurrent sign-ups for the same email.

The suite runs on drizzle-orm 0.35.3; the migration below was generated with
drizzle-kit 0.31.10. It does not run against a deployed D1 database. OAuth
providers, multi-region, email OTP and two-factor are not covered on SQLite.

## Versions

| Package | Version | Why |
| --- | --- | --- |
| `authfn` | 0.4.1 or later | Concurrent sign-ups for one email return `409` instead of `500`. |
| `@authfn/password`, `@authfn/api-keys` | 0.1.3 or later | Depend on `authfn` 0.4.1. 0.1.2 pins `authfn` 0.3.0, which installs a second copy without the fix. |
| `@superfunctions/cli` | 0.2.1 or later | First release with `generate-schema --dialect`. 0.2.0 has no `--dialect` option and emits Postgres only. |

## Install

```bash
npm install authfn@^0.4.1 @authfn/password@^0.1.3 @authfn/api-keys@^0.1.3 @superfunctions/db drizzle-orm
npm install better-sqlite3            # Node only
npm install --save-dev @superfunctions/cli@^0.2.1 drizzle-kit
```

## 1. Declare the app

```ts
// src/auth.ts
import { authfn, authFnPlugins } from 'authfn';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnPasswordPlugin } from '@authfn/password';

export const authApp = authfn({
  plugins: authFnPlugins(authFnPasswordPlugin(), authFnApiKeyPlugin()),
});
```

## 2. Generate the schema and the migration

```js
// superfunctions.config.mjs
export default {
  adapter: { type: 'drizzle', drizzle: { dialect: 'sqlite' } },
  libraries: ['./src/auth.ts'],
};
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/generated/authfn-schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: './authfn.db' },
});
```

```bash
npx superfunctions generate-schema --config ./superfunctions.config.mjs --adapter drizzle --dialect sqlite --output ./db/generated --force
npx drizzle-kit generate --name authfn_sqlite
```

`npx superfunctions` runs the CLI installed above. With `@superfunctions/cli`
0.2.0 the `--dialect` option does not exist; upgrade rather than editing a
Postgres schema by hand.

Drizzle Kit 0.31 refuses to run with older drizzle-orm releases and asks you to
update drizzle-orm. The conformance suite runs on drizzle-orm 0.35.3, so a
newer drizzle-orm at runtime is outside what CI verifies.

The migration creates four tables: `authfn_users`, `authfn_sessions`,
`authfn_password_credentials` and `authfn_api_keys`. In SQLite form:

- Timestamps are `INTEGER` milliseconds since the Unix epoch. Drizzle reads them back as `Date`.
- JSON fields (`methods`, `metadata`, `scopes`) are `TEXT`.
- Unique indexes cover the primary email, the session token hash, the API key
  secret hash and one password credential per user.
- `authfn_sessions.user_id` references `authfn_users.id` without `ON DELETE CASCADE`.
  better-sqlite3 and D1 both enforce foreign keys, so delete a user's sessions
  before the user. authfn's account deletion already does this.

## 3a. Node with better-sqlite3

Apply the migration with `npx drizzle-kit migrate`, then:

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import * as schema from './db/generated/authfn-schema.js';
import { authApp } from './auth.js';

const sqlite = new Database('authfn.db');
sqlite.pragma('journal_mode = WAL');

export const auth = authApp.createServer({
  database: drizzleAdapter({ db: drizzle(sqlite, { schema }), dialect: 'sqlite' }),
});
```

## 3b. Cloudflare Workers with D1

authfn uses `node:crypto` (SHA-256, scrypt, random bytes), so the Worker needs
the `nodejs_compat` flag. Point the D1 binding's migration directory at the
Drizzle Kit output:

```jsonc
// wrangler.jsonc
{
  "compatibility_date": "2025-11-13",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "authfn",
      "database_id": "replace-me",
      "migrations_dir": "./drizzle"
    }
  ]
}
```

```bash
npx wrangler d1 migrations apply authfn --local
npx wrangler d1 migrations apply authfn --remote
```

```ts
import { drizzle } from 'drizzle-orm/d1';
import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import * as schema from './db/generated/authfn-schema.js';
import { authApp } from './auth.js';

export default {
  fetch(request: Request, env: { DB: D1Database }) {
    const auth = authApp.createServer({
      database: drizzleAdapter({ db: drizzle(env.DB, { schema }), dialect: 'sqlite' }),
    });
    return auth.router.handle(request);
  },
};
```

## API keys on SQLite

`POST /auth/api-keys` returns the secret once, with `secretReturnedOnce: true`.
Only its SHA-256 hex digest is stored, in `authfn_api_keys.secret_hash`, and
`GET /auth/api-keys` never returns either. Every successful validation writes
`last_used_at`, so each API-key request costs one D1 write.

## Concurrency

`drizzleAdapter` does not run transactions on SQLite, and authfn does not need
them for these flows. The unique indexes protect the data. When two sign-ups
for the same email race, one succeeds and the others get `409 AUTHFN_CONFLICT`,
the same response as a sequential duplicate.

## Related

- [SQLite adapter](../adapters/database/sqlite)
- [Drizzle adapter](../adapters/database/drizzle), including MySQL and Postgres.
- [CLI authentication](./cli-auth): issuing API keys for command-line tools.
