# PlugFn TypeScript Runtime

PlugFn for TypeScript is the reference runtime for the shared PlugFn product contract. It is the most complete implementation today, but it is still under production-readiness hardening and must be read together with the public provider matrix.

## Install

```bash
npm install plugfn @plugfn/providers @superfunctions/db@0.3.4 @superfunctions/http@0.2.0
```

## Quick start

```ts
import { createPlugFnRouter, plugFn } from 'plugfn';
import { githubProvider, linearProvider } from '@plugfn/providers';

const plug = plugFn({
  database: adapter,
  auth: authProvider,
  baseUrl: 'https://app.example.com',
  encryptionKey: process.env.ENCRYPTION_KEY!,
  integrations: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    linear: {
      clientId: process.env.LINEAR_CLIENT_ID!,
      clientSecret: process.env.LINEAR_CLIENT_SECRET!,
    },
  },
});

plug.providers.register(githubProvider);
plug.providers.register(linearProvider);

const router = createPlugFnRouter(plug);
```

## Shared foundations

PlugFn TypeScript is expected to build on shared packages rather than bespoke copies of generic infrastructure:

- `@superfunctions/db`
- `@superfunctions/http`
- `@superfunctions/oauth-core`
- `@superfunctions/oauth-flow`
- `@superfunctions/oauth-http`
- `@superfunctions/oauth-storage`
- `@superfunctions/oauth-providers`

## Route mounting

Route exposure should flow through `@superfunctions/http` adapters.

### Express

```ts
import express from 'express';
import { createExpressAdapter } from '@superfunctions/http-express';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter, plugFn } from 'plugfn';

const app = express();
const adapter = createExpressAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

### Fastify

```ts
import Fastify from 'fastify';
import { createFastifyAdapter } from '@superfunctions/http-fastify';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter, plugFn } from 'plugfn';

const app = Fastify();
const adapter = createFastifyAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

### Hono

```ts
import { Hono } from 'hono';
import { createHonoAdapter } from '@superfunctions/http-hono';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter, plugFn } from 'plugfn';

const app = new Hono();
const adapter = createHonoAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

## Provider scope

The core provider set tracked by release gating is:

- `github`
- `linear`
- `clickup`
- `gmail`
- `notion`

Other exported providers may still be useful, but they should be treated according to the readiness matrix rather than assumed production-ready by default.

See [../docs/provider-readiness-matrix.md](../docs/provider-readiness-matrix.md).

## Credential scope envelopes

`defineScopeGrammar` describes the scope of a provider credential request, and its grammar answers whether a request stays inside an allowed envelope.

```ts
import { defineScopeGrammar } from 'plugfn';

const grammar = defineScopeGrammar({
  provider: 'example',
  dimensions: {
    permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write'] },
    repositories: { kind: 'prefixGlobSet' }, // literals or `prefix*`
    ttl: { kind: 'ttlMax', minSeconds: 900, maxSeconds: 3600 },
  },
});

grammar.isSubset(
  { permissions: ['contents:read'], repositories: ['org/app'], ttl: 900 },
  { permissions: ['contents:read'], repositories: ['org/*'], ttl: 3600 },
); // { ok: true, violations: [], scope: { permissions: ['contents:read'], repositories: ['org/app'], ttl: 900 } }
```

- Only four dimension kinds exist: `exactSet`, `prefixGlobSet` (a single trailing `*`), `numericMax` and `ttlMax` (whole seconds). An unknown kind, an option a kind does not have (such as `max` on a `ttlMax` dimension) or an `undefined` dimension entry throws `TypeError` when the grammar is defined. Optional options left `undefined` are treated as absent.
- The grammar is frozen and evaluates from its own copy of the definition, so later changes to the definition object or `grammar.dimensions` cannot change a decision. The definition is read once as plain data: the definition object, the `dimensions` object and every dimension entry must have a prototype of exactly `Object.prototype` or `null` and only enumerable string-keyed data properties. A `values` array must be dense, with no extra key. A class instance, an inherited option, a getter or setter, or a non-enumerable or symbol-keyed property throws `TypeError` instead of being silently dropped. Each object is read once, through its property descriptors (a polluted `Object.prototype` cannot make an accessor look like data), into the engine's own copy, which is the only thing compiled and published, so the engine always enforces exactly the definition it was given.
- Trust boundary: the grammar definition is trusted. Each request and envelope is untrusted and captured with one `structuredClone` before validation. The engine rejects values it cannot clone or that are not plain JSON-like data, including sparse arrays, cycles and shared references. Only own enumerable string-keyed data can contribute to the scope. `isSubset` captures the envelope before any request getter can change it. The engine never reads an input or its own arrays through the Array iteration protocol or an `Array.prototype` method looked up at call time (it uses index loops, captures `Array.isArray` at load, and fills every array it builds by own-property definition rather than index assignment), so a data-valued pollution, a replaced Array iterator or method, or an index property on `Array.prototype` or `Object.prototype` (writable, non-writable or an accessor) cannot change a decision or make `normalize` or `isSubset` throw. The same rule covers `defineScopeGrammar`: the definition object is trusted data, read once through its own property descriptors, and ambient `Array.prototype` or `Object.prototype` index properties, or a replaced Array iterator or method, present while a grammar is defined cannot change what it compiles, publishes or enforces. The set arrays in a returned scope are frozen ordinary arrays whose own indexes and `length` hold exactly the approved members; reading them after the call through the realm's Array iterator or methods belongs to the caller's realm. The realm's other built-in functions (the `Set`, `Map`, `String`, `Number`, `RegExp`, `JSON`, `Object` and `Math` methods) are trusted: caller code that replaces them, including from an input getter, acts with the caller's own authority and is outside this boundary. An input getter is same-realm caller code; the engine guarantees only that it runs once, during the clone, with the envelope captured first.
- When `isSubset` succeeds it returns that frozen snapshot as `scope`. Mint from `scope` because a request getter can answer differently on a second read. The snapshot and `grammar.dimensions` are frozen objects with a null prototype, so a name the grammar does not declare (`toString` included) is `undefined`.
- Every record the engine hands out (the `normalize` and `isSubset` results, ok or not, and each violation) is a frozen object with a null prototype in which every declared field is an own property, `undefined` when it does not apply: a result always has `ok`, `violations` (a fresh frozen array, empty when `ok`) and `scope` (`undefined` when not `ok`), and a violation always has `code`, `side`, `dimension`, `item`, `limit` and `message`. So a polluted `Object.prototype` can never supply a field a caller reads, such as a `scope` on a failed result.
- Types are precise only for an exact definition (literal dimension names, not a union). A definition widened to `ScopeDimensions`, mixing declared and index keys, using template-literal keys, declaring an optional key or a union takes the widened types as a whole: every lookup may be `undefined`. `AnyScopeGrammar` accepts every grammar.
- `SCOPE_LIMITS` bounds the input: a set may hold at most `maxSetItems` (100,000) items, checked on the engine's clone after the plain-data check and before any member is validated against the grammar (`structuredClone` has already copied every member by then, so an oversized input still costs one copy and one walk), and a member at most `maxMemberLength` (4,096) characters. A larger set or a longer member is `malformed`.
- Evaluation is linear in the input. Glob coverage puts the envelope's glob prefixes, in the order given and without sorting, into a 16-ary radix trie keyed by nibble (each UTF-16 code unit is four 4-bit digits): a branching node holds a 16-slot child array, and each edge is a range of an envelope string rather than a copy. Building the index is linear in the envelope's code units, and a request item is checked with one walk over its own code units, each child lookup one array index, so no input can slow it down by colliding a hash function or a comparison sort. Memory grows with the number of envelope globs, not their length. Exact members, glob-envelope literals, request deduplication and an `exactSet` vocabulary use `Set`s in which a member that starts with a digit is keyed with a leading control character (which no member can contain): V8 hashes a string that reads as an array index (such as `"4096"`) from its numeric value, without the per-process seed, so input made of such strings could otherwise share one bucket chain. No key is an index, so every key is hashed with the seed.

## OAuth migration

Version 0.2.0 removes the legacy `OAuthFlowHandler` export and
`plugfn/auth/oauth-flow` compatibility module at their announced removal target.
Use `createOAuthFlowService` from `@superfunctions/oauth-flow` with the shared
HTTP/storage packages. The connection manager already uses this canonical stack;
there is no legacy delegate or import-time deprecation shim.

## Browser safety

PlugFn publishes `@plugfn/client`, a thin browser-safe helper for provider discovery, connection lifecycle, and sync-job routes. Provider credentials, token exchange, webhook verification, and privileged provider actions stay on the server. See [../docs/client-sdk-boundary.md](../docs/client-sdk-boundary.md).

## Webhook workflow bindings

Automatic webhook workflows require an explicit `tenantId` on the workflow and
`definition.trigger.connectionId` in its definition. PlugFn matches the provider,
event, tenant, and connection before loading a workflow for execution.

Configure `webhooks.workflowBindings[provider]` with the provider's trusted
signing authorities. Give each authority a stable `id`, the SHA-256 hex
`credentialFingerprints` of its accepted verification credentials, and a
`resolve(subject)` function that searches only its own installation or
connection registry. Multiple credentials for one app can share the authority
when rotating its secret. PlugFn requires exactly one matching authority and one
active installation match with its authoritative `tenantId`, `connectionId`,
and a registry-managed `revoked` signal. Return the same active `AbortSignal`
for the lifetime of a binding generation. Abort it on a binding change or
revocation in every runtime that can deliver events for that authority. Build
the mapping when provisioning the integration and authorize the workflow's connection
when writing its definition. Keep each authenticated subject assigned to its
original tenant, including after revocation. Provision a distinct subject and
connection ID for a different tenant. A retained receipt prevents that delivery
from being admitted under a different binding through either HTTP or the
`PlugFn.webhooks.handle` API.

GitHub App webhooks use the numeric `installation.id` from the HMAC-verified
body as the subject, passed to the resolver as a string. The verified body also
identifies the event. Scoped GitHub ingress rejects actions outside the known
payload families so an unfamiliar event cannot enter an existing workflow.
Configure the GitHub App's server-held webhook secret in
the router. Custom providers can expose the authenticated subject and event
through `getWorkflowSubject` and `getWorkflowEvent`. When the verifier also
authenticates a unique delivery ID, the trigger can expose it through
`getAuthenticatedDeliveryId`. Otherwise PlugFn
uses the authenticated body hash to identify redeliveries. For a provider listed
in `workflowBindings`, pass the original request bytes as `rawBody` to
`PlugFn.webhooks.handle` and leave signature verification enabled. This applies
even when only standalone listeners are registered. PlugFn parses the verified
bytes for these providers. An SDK call with only a parsed payload, or with
signature verification disabled, rejects with `WEBHOOK_WORKFLOW_BINDING_REQUIRED`.
Use a credential for the same signing authority for a scoped delivery. The
lower-level `WebhookHandler.handleWebhook` supports standalone listeners.

In the host application that contains your upgraded PlugFn dependency and
migration config, install the Superfunctions CLI and TypeScript together.
CLI 0.2.2 uses TypeScript to find the PlugFn initialization in your source files.

```sh
npm install --save-dev @superfunctions/cli@0.2.2 typescript
npx superfunctions generate-migration plugfn
```

The command defaults to `superfunctions.config.js`. It accepts JavaScript
(`.js`, `.mjs`, or `.cjs`) and JSON config files. For a different name, pass
`--config <path>`. Compile a TypeScript config to JavaScript before passing it.

Apply the generated schema version 9 migration with your adapter's migration
runner before deploying upgraded HTTP or SDK ingress and retry workers, even if
workflow bindings are disabled. The migration
preserves existing receipt keys and adds a separately indexed workflow receipt
key and a scope marker on deliveries. Upgrade all retry workers before enabling
workflow bindings. Resubmit scoped deliveries through the provider or the SDK. For GitHub Apps,
request redelivery manually or through the GitHub API. SDK resubmission needs the
original body, signature headers, and verification credential.

Previously stored definitions without both binding fields are skipped during
webhook registration. To restore automatic dispatch, an administrator should
verify the owning tenant and connection, set `tenantId` on the workflow row and
`definition.trigger.connectionId` in the stored definition, then restart the
runtime or rehydrate its workflow triggers. This backfill uses existing columns. Each
single-tenant deployment must also configure an explicit binding. Manual
workflow execution remains available. When a provider has a resolver, a
verified delivery without a workflow subject can still reach an explicitly
registered server-side listener for its event.

An in-flight delivery may run its listener twice when you enable tenant binding.
Signed, bound deliveries use a separate receipt history for each verified signing
authority. Make listener effects idempotent with a durable key for the provider
and relevant tenant or connection. Use an event ID from the verified payload or a
stable business operation key. Enforce uniqueness in the transaction that applies
a local effect, or pass the key to the downstream service when it accepts an
idempotency key.

Use a new workflow ID when moving a bound workflow to a different tenant or
connection. This keeps execution history with the workflow's original tenant.

## Development

```bash
npm run build
npm test -- --run
npm run type-check
```
