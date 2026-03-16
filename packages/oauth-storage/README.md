# @superfunctions/oauth-storage

`@superfunctions/oauth-storage` provides OAuth state and token persistence contracts, plus ready-to-use adapters.

## DB Adapter Bridge (`@superfunctions/db`)

Use `createOAuthDbStorage(...)` to build `OAuthStateStore` + `TokenVault` backed by a `@superfunctions/db` `Adapter`.

Default model names:

- `oauth_states`
- `oauth_token_vault`

You can override model mappings:

```ts
import { createOAuthDbStorage } from "@superfunctions/oauth-storage";

const { stateStore, tokenVault } = createOAuthDbStorage({
  adapter,
  models: {
    oauthStates: "oauth_states",
    oauthTokenVault: "oauth_token_vault"
  }
});
```

If a required mapping is missing, initialization fails with `SCHEMA_MISSING`.
