# PlugFn TypeScript Runtime

PlugFn for TypeScript is the reference runtime for the shared PlugFn product contract. It is the most complete implementation today, but it is still under production-readiness hardening and must be read together with the public provider matrix.

## Install

```bash
npm install plugfn @superfunctions/db@0.3.2 @superfunctions/http@0.2.0
```

## Quick start

```ts
import {
  createPlugFnRouter,
  githubProvider,
  linearProvider,
  plugFn,
} from 'plugfn';

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

`defineScopeGrammar` describes the scope of a provider credential request, and its grammar answers whether a request stays inside an allowed envelope and how risky the request is.

```ts
import { defineScopeGrammar } from 'plugfn';

const grammar = defineScopeGrammar({
  provider: 'example',
  dimensions: {
    permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write'] },
    repositories: { kind: 'prefixGlobSet' }, // literals or `prefix*`
    ttl: { kind: 'ttlMax', minSeconds: 900, maxSeconds: 3600 },
  },
  riskOf: ({ value }) => (String(value).endsWith(':write') ? 'write' : 'read'),
});

grammar.isSubset(
  { permissions: ['contents:read'], repositories: ['org/app'], ttl: 900 },
  { permissions: ['contents:read'], repositories: ['org/*'], ttl: 3600 },
); // { ok: true, violations: [], scope: { permissions: ['contents:read'], repositories: ['org/app'], ttl: 900 } }
grammar.classifyRisk({ permissions: ['contents:write'], repositories: [], ttl: 900 }); // 'write'
```

- Only four dimension kinds exist: `exactSet`, `prefixGlobSet` (a single trailing `*`), `numericMax` and `ttlMax` (whole seconds). An unknown kind, an option a kind does not have (such as `max` on a `ttlMax` dimension) or an `undefined` dimension entry throws `TypeError` when the grammar is defined. Optional options left `undefined` are treated as absent.
- The grammar is frozen and evaluates from its own copy of the definition, so later changes to the definition object or `grammar.dimensions` cannot change a decision. The definition is read once as plain data: the definition object, the `dimensions` object and every dimension entry must have a prototype of exactly `Object.prototype` or `null` and only enumerable string-keyed data properties. A `values` array must be dense, with no extra key. A class instance, an inherited option, a getter or setter, or a non-enumerable or symbol-keyed property throws `TypeError` instead of being silently dropped. Each object is read once, through its property descriptors (a polluted `Object.prototype` cannot make an accessor look like data), into the engine's own copy, which is the only thing compiled and published, so the engine always enforces exactly the definition it was given.
- Trust boundary: the grammar definition and its callbacks are trusted; every request and envelope is untrusted data. The engine reads untrusted input exactly once, as `structuredClone(input)`, and decides only from that clone. Own enumerable string-keyed data is what counts: a getter runs once during the clone, non-enumerable and symbol keys are dropped (they can only narrow a request), and anything that cannot be cloned (a Proxy, a promise, a function) is `malformed` with a fixed message. Every clone the engine makes, the input's and the re-cloned `normalize` result alike, must be plain JSON-like data before anything reads it: objects, dense arrays without extra keys, strings, finite numbers, booleans and `null`, without cycles or shared references (so one array object used for two dimensions is `malformed`). Anything else (a Map, Set, Date, SharedArrayBuffer, ArrayBuffer or view, boxed value, `undefined`, a sparse array or an array with an extra key) is `malformed`. With `normalize`, the input's clone is checked before `normalize` sees it, so `normalize` is not called for such input and never sees memory shared with the caller. Its result is cloned again, checked the same way and validated. `classifyRisk` keeps the clone error as the `ScopeError` cause. A runtime without `structuredClone` cannot define a grammar.
- An optional `normalize(input)` maps provider-shaped input to the grammar. It receives the engine's clone of the input and its result is cloned again and validated, so a request or envelope that does not fit (an unknown dimension, an interior `*`, a missing limit, a non-finite number, a `normalize` throw) is rejected as `malformed`, never widened. `isSubset` and `normalize` report this in their result and do not throw.
- `normalize` and `riskOf` must be synchronous: an `async` function is rejected when the grammar is defined, and the engine never waits for a promise. The exact callback boundary is documented on `ScopeGrammarDefinition.normalize` in `src/scopes/types.ts`.
- When `isSubset` succeeds it returns that frozen snapshot as `scope`. Mint from `scope` and classify it with `grammar.classifyScope(scope)`; never read the raw request again, because a getter can answer differently the next time. `classifyScope` accepts only a snapshot the same grammar returned. The snapshot and `grammar.dimensions` are frozen objects with a null prototype, so a name the grammar does not declare (`toString` included) is `undefined`.
- Types are precise only for an exact definition (literal dimension names, not a union). A definition widened to `ScopeDimensions`, mixing declared and index keys, using template-literal keys, declaring an optional key or a union takes the widened types as a whole: every lookup may be `undefined` and `riskOf` sees `dimension: string`. `AnyScopeGrammar` accepts every grammar.
- `SCOPE_LIMITS` bounds the input: a set may hold at most `maxSetItems` (100,000) items, checked on the engine's clone after the plain-data check and before any member is validated against the grammar (`structuredClone` has already copied every member by then, so an oversized input still costs one copy and one walk), and a member at most `maxMemberLength` (4,096) characters. A larger set or a longer member is `malformed`.
- `classifyRisk` returns the highest `riskOf` result over every requested item. It calls `riskOf` for every item, so it throws `ScopeError` for a malformed request, or when `riskOf` throws or returns anything other than `read`, `write` or `destructive` for any item, whatever the item order.
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

Apply PlugFn schema version 9 with `superfunctions generate` and your adapter's
migration runner before starting the upgraded webhook workers. The migration
preserves existing receipt keys and adds a separately indexed workflow receipt
key and a scope marker on deliveries. Upgrade all retry workers before enabling
workflow bindings. Scoped deliveries enter through provider redelivery or the SDK
with the original body, signature headers, and verification credential.

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
