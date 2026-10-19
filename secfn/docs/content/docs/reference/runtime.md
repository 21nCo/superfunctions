---
title: Runtime package
description: Read-only runtime client and environment materialization.
---

Read-only runtime client and env materialization helpers for SecFn.

Use this package from trusted server, CI, build, and local development workflows. Do not bundle private secrets into browser code.

```ts
import { createSecFnRuntime } from "@secfn/runtime";

const secfn = createSecFnRuntime({
  endpoint: "https://nucleus.example.com/secfn",
  apiKey: process.env.SECFN_RUNTIME_TOKEN!,
  tenantId: "acme",
  environment: "production",
  cache: { ttlMs: 60_000 },
});

const value = await secfn.get("OPENAI_API_KEY");
const env = await secfn.toEnv("nucleus-production");
const dotenv = await secfn.toDotEnv("nucleus-production");
```

`toDotEnv` returns text only. It does not write plaintext to disk.

The default cache TTL is zero. A positive `ttlMs` can keep serving a rotated secret until the entry expires; pass `bypassCache: true` per call or call `clearCache()` to force a fresh read.

The client also provides `getSet`, `preload`, and `injectEnv` (which skips variables that are already set unless `override: true` is passed). `get`, `getSet`, `toEnv`, `toDotEnv`, and `injectEnv` accept `RuntimeGetOptions` (`environment`, `bypassCache`).

Release gates (`npm run typecheck`, `npm run build`, and `npm test`) consume
installed `@secfn/core` exports, not sibling source aliases. Install the declared
registry prerequisites before running them in a standalone checkout.
