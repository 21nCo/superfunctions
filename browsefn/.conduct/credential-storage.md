# Credential handling and deployment storage

BrowseFn accepts provider credentials in process memory; it does not implement a credential database or write provider configuration to cache, logs or artifacts. Default cache option identities use SHA-256, so Authorization/cookies are not persisted as key text. TypeScript uses browser-compatible synchronous @noble/hashes to retain the public synchronous memory-cache has() API; Python uses hashlib. URLs containing userinfo or recognized credential query names (including token, access_token, api_key, key, secret and password) bypass caching because response metadata would otherwise retain that URL. Custom cache key generators are trusted application code and must not return secrets.

Known provider/request credentials and credential URL fields are redacted from SDK-maintained logs, including error messages. Rotation and cache keys never log raw header options. Regression tests send requests through local HTTP fixtures, scan actual persistent cache files and SDK logs, and exercise provider failure messages containing known credentials. This is not a general data-loss prevention scanner: unrecognized secret names, arbitrary content returned by a provider, and application-written logging still need application policy. Do not put credentials into arbitrary URL parameters; prefer supported authentication headers/configuration.

Response caches hold caller-requested content in plaintext, including private page content if the caller enables caching. A site can echo a credential into its content; BrowseFn cannot safely rewrite arbitrary page content without changing the result. Disable cache for sensitive pages or protect the backing store with deployment encryption/access controls. On upgrade clear pre-0.2 persistent caches, whose option keys could contain headers/cookies. New SDKs do not match those historical keys. There is no automatic migration of plaintext legacy records.

For credentials that must persist, use the existing SecFn service or a deployment secret manager. The repository's `secfn/server/README.md` configures `createSecFnServer({ encryption: { masterKey, keyId }, ... })`; its encrypted vault owns persistence and authorization. The existing read-only runtime API is documented in `secfn/runtime/README.md`:

```ts
import { createSecFnRuntime } from '@secfn/runtime';
import { browseFn } from 'browsefn';

const secrets = createSecFnRuntime({
  endpoint: process.env.SECFN_ENDPOINT!,
  apiKey: process.env.SECFN_RUNTIME_TOKEN!,
  tenantId: 'my-tenant',
  environment: 'production',
});
const browse = browseFn({
  web: { providers: { firecrawl: { apiKey: await secrets.get('FIRECRAWL_API_KEY') } } },
});
```

This is server-side application composition, not a new BrowseFn dependency or credential-store feature. Deploy/publish SecFn and its prerequisites separately; do not embed these tokens in browser bundles. Python deployments can inject values from their existing secret manager into ProviderConfig in memory.
