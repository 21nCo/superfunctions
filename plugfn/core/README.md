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

A callback grammar adds a required per-item `riskOf` and an optional provider-shaped `normalize`, and can classify risk:

```ts
const github = defineScopeGrammar({
  provider: 'example',
  dimensions: {
    permissions: { kind: 'exactSet', values: ['contents:read', 'contents:write'] },
    repositories: { kind: 'prefixGlobSet' },
  },
  // Provider-shaped input: { repositories, permissions: { contents: 'write' } }.
  normalize: (input: { repositories: string[]; permissions: Record<string, string> }) => ({
    repositories: input.repositories,
    permissions: Object.entries(input.permissions).map(([name, level]) => `${name}:${level}`),
  }),
  riskOf: ({ value }) => (String(value).endsWith(':write') ? 'write' : 'read'),
});

const decision = github.isSubset(
  { repositories: ['org/app'], permissions: { contents: 'write' } },
  { repositories: ['org/*'], permissions: { contents: 'write' } },
);
if (decision.ok) github.classifyScope(decision.scope); // 'write'
```

- Only four dimension kinds exist: `exactSet`, `prefixGlobSet` (a single trailing `*`), `numericMax` and `ttlMax` (whole seconds). An unknown kind, an option a kind does not have (such as `max` on a `ttlMax` dimension) or an `undefined` dimension entry throws `TypeError` when the grammar is defined. Optional options left `undefined` are treated as absent.
- The grammar is frozen and evaluates from its own copy of the definition, so later changes to the definition object or `grammar.dimensions` cannot change a decision. The definition is read once as plain data: the definition object, the `dimensions` object and every dimension entry must have a prototype of exactly `Object.prototype` or `null` and only enumerable string-keyed data properties. A `values` array must be dense, with no extra key. A class instance, an inherited option, a getter or setter, or a non-enumerable or symbol-keyed property throws `TypeError` instead of being silently dropped. Each object is read once, through its property descriptors (a polluted `Object.prototype` cannot make an accessor look like data), into the engine's own copy, which is the only thing compiled and published, so the engine always enforces exactly the definition it was given.
- Trust boundary: the grammar definition is trusted. Each request and envelope is untrusted and captured with one `structuredClone` before validation. The engine rejects values it cannot clone or that are not plain JSON-like data, including sparse arrays, cycles and shared references. Only own enumerable string-keyed data can contribute to the scope. `isSubset` captures the envelope before any request getter can change it. The engine never reads an input or its own arrays through the Array iteration protocol or an `Array.prototype` method looked up at call time (it uses index loops, captures `Array.isArray` at load, and fills every array it builds by own-property definition rather than index assignment), so a data-valued pollution, a replaced Array iterator or method, or an index property on `Array.prototype` or `Object.prototype` (writable, non-writable or an accessor) cannot change a decision or make `normalize` or `isSubset` throw. The same rule covers `defineScopeGrammar`: the definition object is trusted data, read once through its own property descriptors, and ambient `Array.prototype` or `Object.prototype` index properties, or a replaced Array iterator or method, present while a grammar is defined cannot change what it compiles, publishes or enforces. The set arrays in a returned scope are frozen ordinary arrays whose own indexes and `length` hold exactly the approved members; reading them after the call through the realm's Array iterator or methods belongs to the caller's realm. The realm's other built-in functions (the `Set`, `Map`, `String`, `Number`, `RegExp`, `JSON`, `Object` and `Math` methods) are trusted: caller code that replaces them, including from an input getter, acts with the caller's own authority and is outside this boundary. An input getter is same-realm caller code; the engine guarantees only that it runs once, during the clone, with the envelope captured first.
- When `isSubset` succeeds it returns that frozen snapshot as `scope`. Mint from `scope` because a request getter can answer differently on a second read. The snapshot and `grammar.dimensions` are frozen objects with a null prototype, so a name the grammar does not declare (`toString` included) is `undefined`.
- Every record the engine hands out (the `normalize` and `isSubset` results, ok or not, and each violation) is a frozen object with a null prototype in which every declared field is an own property, `undefined` when it does not apply: a result always has `ok`, `violations` (a fresh frozen array, empty when `ok`) and `scope` (`undefined` when not `ok`), and a violation always has `code`, `side`, `dimension`, `item`, `limit` and `message`. So a polluted `Object.prototype` can never supply a field a caller reads, such as a `scope` on a failed result.
- Types are precise only for an exact definition (literal dimension names, not a union). A definition widened to `ScopeDimensions`, mixing declared and index keys, using template-literal keys, declaring an optional key or a union takes the widened types as a whole: every lookup may be `undefined`. `AnyScopeGrammar` accepts every grammar.
- `SCOPE_LIMITS` bounds the input: a set may hold at most `maxSetItems` (100,000) items, checked on the engine's clone after the plain-data check and before any member is validated against the grammar (`structuredClone` has already copied every member by then, so an oversized input still costs one copy and one walk), and a member at most `maxMemberLength` (4,096) characters. A larger set or a longer member is `malformed`.
- A definition without callbacks is data-only: `defineScopeGrammar` returns a grammar with `normalize` and `isSubset` only. A definition with `riskOf` returns a callback grammar that also has `classifyRisk` and `classifyScope`; a `normalize` without `riskOf` throws `TypeError`. The callbacks are trusted grammar-author code; requests and envelopes stay untrusted data.
- `normalize(input)` receives the engine's detached clone of the input, only once that clone is plain JSON-like data: every record has a null prototype, and every array (still an array) has a frozen null-prototype prototype holding the standard `Array.prototype` methods captured at load (a fixed list of names, each copied only when it is an own function-valued data property), without `constructor`, so a field inherited from a polluted `Object.prototype` or `Array.prototype` never appears in the input. Primitive values and every object `normalize` builds itself belong to the callback's realm. Its result is cloned again, checked to be plain data and validated, so a request or envelope that does not fit (an unknown dimension, an interior `*`, a missing limit, a `normalize` throw) is `malformed`, never widened. `isSubset` clones, checks and normalizes the envelope before it clones the request, so no request getter or `normalize` call can change the envelope it is judged against.
- `classifyRisk` returns the highest `riskOf` result (`read` < `write` < `destructive`) over every requested item, `read` for an empty request. It calls `riskOf` for every item, so it throws `ScopeError` for a malformed request (with the clone or `normalize` error as `cause`), or when `riskOf` throws or returns anything other than `read`, `write` or `destructive` for any item, whatever the item order. Mint from the frozen snapshot `isSubset` returns and classify that snapshot with `classifyScope`, never the raw request: `classifyScope` accepts only a snapshot the same grammar returned. `ScopeError.violations` is a fresh frozen array and `cause` is always own; the item passed to `riskOf` is a frozen null-prototype record.
- Callbacks must be synchronous: an `async` function or async generator (in any realm) is rejected when the grammar is defined. That check reads the function's `Object.prototype.toString` tag, so it catches mistakes rather than proving anything (trusted code could change the tag with `Symbol.toStringTag`); the result is still checked on every call. A function that returns a promise fails closed (`normalize`: `malformed`; `riskOf`: `ScopeError`). The engine never awaits it and never calls a returned object's own `then`: it applies the intrinsic `Promise.prototype.then`, captured at load, with no-op fulfillment and rejection handlers, which marks a native promise's rejection handled; with the intrinsic `Promise` as the species (see below), the promise that `then` derives then fulfills. Containment never reads an own `then`; a `normalize` result is then copied with `structuredClone`, which reads an own `then` getter on a non-promise object like any other own enumerable property (a native promise cannot be cloned and fails first). `then` first looks up the species constructor (`constructor`, then `Symbol.species`); that lookup can run code that changes state and throws, and a custom species builds the derived promise itself and can reject it even when `then` succeeds. So the engine decides before `then` runs whether it can only use the default species, from the value's own `constructor` descriptor and prototype and the ambient species state read only from the `Object`, `Function.prototype` and `Object.prototype` captured at load (pinned by identity, so a Proxy put in that chain is never read through). Only a value with no own `constructor` and a `null` prototype, or `Object.prototype` while `Object.prototype.constructor` is the intrinsic `Object` and none of the three defines `Symbol.species`, qualifies: a plain record keeps that fast path and never sees a `defineProperty`. Anything else, or state it cannot read, has its own `constructor` descriptor made to read as `undefined` (defined on an extensible value without one, redefined when configurable, or set when non-configurable writable data) before `then` runs once, so `then` uses the intrinsic `Promise` without a species lookup, and that descriptor is restored afterwards, even when redefining it throws after applying the change. Residual: a promise whose own `constructor` is a non-configurable accessor or non-configurable non-writable data, or a non-extensible promise with no own `constructor`, gets `then` as is, so a species lookup that throws leaves its rejection unhandled and a custom species can reject the derived promise; only deliberately hostile callback code can build one, and the engine still fails closed. The exact boundary is documented on `ScopeCallbackGrammarDefinition` in `src/scopes/types.ts`.
- Evaluation is linear in the input. Glob coverage puts the envelope's glob prefixes, in the order given and without sorting, into a 16-ary radix trie keyed by nibble (each UTF-16 code unit is four 4-bit digits): a branching node holds a 16-slot child array, and each edge is a range of an envelope string rather than a copy. Building the index is linear in the envelope's code units, and a request item is checked with one walk over its own code units, each child lookup one array index, so no input can slow it down by colliding a hash function or a comparison sort. Memory grows with the number of envelope globs, not their length. Exact members, glob-envelope literals, request deduplication and an `exactSet` vocabulary use `Set`s in which a member that starts with a digit is keyed with a leading control character (which no member can contain): V8 hashes a string that reads as an array index (such as `"4096"`) from its numeric value, without the per-process seed, so input made of such strings could otherwise share one bucket chain. No key is an index, so every key is hashed with the seed.

## Credential minters

A `CredentialMinter` turns a provider installation and a scope into a short-lived secret narrowed to that scope. Decide policy first with the minter's `grammar` (`grammar.isSubset(request, envelope)`), then mint the frozen snapshot it returns as `scope`, never the raw request: the minter builds the grant from that snapshot alone, so a request getter that answers differently on a second read cannot widen what is minted.

```ts
import type { CredentialMinter } from 'plugfn';

const decision = minter.grammar.isSubset(request, envelope);
if (!decision.ok) throw new Error('scope not allowed');
// mint({ installation, scope, ttl }) -> { secret, expiresAt, revokeHandle }
const { secret, expiresAt, revokeHandle } = await minter.mint({ installation, scope: decision.scope, ttl: 900 });
await minter.revoke(revokeHandle); // idempotent
```

- `mint` narrows the credential to exactly the requested scope. A scope the provider cannot grant rejects with `ScopeNotGrantable`; every other failure rejects with `CredentialMinterError`, whose `code` names the failure (`invalid_request`, `invalid_configuration`, `unauthorized`, `forbidden`, `installation_not_found`, `provider_unavailable`, `provider_error`, `rejected_credential_not_revoked` or `mint_outcome_unknown`), with the provider `status` and a `retryable` flag. Errors never carry the minted secret or the minter's signing material.
- Retries: pass an `idempotencyKey` (1 to 256 characters) to make a retried mint idempotent within one minter instance. Mints with the same key and the same installation, scope and `ttl` share one provider call and return the same credential until it is revoked or expires; then the key mints a new one. The same key with a different request rejects with `invalid_request` while the earlier credential is live. A key never sends a second provider request while a credential from an earlier one may be live: only a definite non-issuance (a failure before the request, or a provider refusal such as HTTP 4xx) frees it at once. Without a key, each mint asks the provider for a new credential.
- When the provider reports success but its response is lost or unusable, `mint` rejects with `mint_outcome_unknown`, which is not retryable: a credential may have been issued, and it stays active until it expires. For a keyed mint, a connection that fails after the request was sent and a provider 5xx are `mint_outcome_unknown` too. A keyed mint keeps reporting that failure for its key until any such credential has expired, and keeps reporting a `rejected_credential_not_revoked` failure, with the same `revokeHandle`, until that handle is revoked or the credential expires. Without a key, a connection failure or 5xx is a retryable `provider_unavailable`; a provider without its own idempotency key (GitHub has none) may still have issued a credential nobody can see, which expires on its own.
- When the provider issues a credential the minter rejects (wider or narrower than asked, or a response it cannot trust), the minter revokes it before failing. If that cleanup fails, `mint` rejects with `rejected_credential_not_revoked`; its `revokeHandle`, when set, lets you finish the cleanup with `revoke(error.revokeHandle)`.
- `revoke` is idempotent: a credential that is already revoked or expired resolves.
- `expiresAt` is when the provider stops accepting the secret. Each minter documents how it treats a `ttl` its provider cannot honour exactly.
- The interface and errors are also available from `plugfn/credentials`, and the scope engine from `plugfn/scopes`, without loading the rest of PlugFn (for Workers).

`@plugfn/providers/github-app` provides `createGitHubAppMinter({ appId, privateKey })`, which mints GitHub App installation tokens:

- It signs the App JWT (RS256, `iat` back-dated 60 seconds, `exp` 10 minutes after `iat`) with WebCrypto only, so it runs on Node and Workers. The private key may be PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`, as GitHub issues it) or PKCS#8 PEM (`BEGIN PRIVATE KEY`).
- The grammar's input is `{ repositories: ['app'], permissions: { contents: 'read', issues: 'write' } }`: repository names without the owner (compared case-insensitively) and each permission at `read`, `write` or `admin`. A level covers the lower ones in `isSubset`. Any `admin` level and every `administration` permission classify as `destructive`.
- `mint` takes as `scope` the snapshot `minter.grammar.isSubset` returned, and builds the grant from it alone. It also accepts the provider-shaped input, normalised once, for a caller that checks no envelope.
- It calls `POST /app/installations/{id}/access_tokens` with exactly those repositories and permissions. The scope must name at least one repository and one permission, because GitHub widens an omitted list to the whole installation. The 201 must grant exactly the request: `repository_selection: "selected"`, every requested repository and no other, and every requested permission at the requested level and no other (GitHub's read-only `metadata` permission, listed on every token, is allowed), with `expires_at` an ISO-8601 UTC timestamp in the future and no later than one hour plus a five-minute clock-skew tolerance from now. Otherwise the minter revokes the returned token, retrying a 429, 5xx or network failure of that `DELETE` up to three attempts (`cleanupRetryDelayMs`, 250 ms by default, apart), and fails with `provider_error`. If the cleanup still fails, it fails with `rejected_credential_not_revoked` and a `revokeHandle`: the rejected token stays active until `minter.revoke(error.revokeHandle)` succeeds or it expires. A 422 (a repository or permission outside the installation) rejects with `ScopeNotGrantable`.
- GitHub has no idempotency key, so the minter keeps `idempotencyKey`s itself, in memory, per minter instance. A 201 whose body cannot be read within 10 seconds, or carries no usable token, is `mint_outcome_unknown`; a body that arrives later (within a minute) is still read and any token in it is revoked, never returned. Error bodies that do not arrive within 10 seconds are cancelled.
- GitHub installation tokens always live one hour: a `ttl` above 3600 seconds is `ScopeNotGrantable`, and for a shorter `ttl` `expiresAt` reports GitHub's real expiry, so revoke the token at your own deadline if it must not outlive it.
- `revoke` calls `DELETE /installation/token` with the token, even after the local clock passes `expiresAt`. A 401 (the token no longer works, revoked or expired) counts as revoked; the minter does not wait for a body when the status decides. The revoke handle keeps the token outside the object, so serialising or inspecting it never reveals the token, and only the minter that returned it can use it, in the same process.
- The minter never logs the App JWT or the installation token, and redacts them (and anything shaped like a JWT or GitHub token) from provider messages in errors.

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
