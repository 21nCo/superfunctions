# @contentfn/client

Typed fetch client for ContentFn, including an async iterable SSE feed. Supports browsers and Node18.18+, ESM and CommonJS.

```ts
import { createContentfnClient } from '@contentfn/client';
const client = createContentfnClient({ baseUrl: 'https://cms.example.com' });
const result = await client.datasets.list();
if (result.ok) console.log(result.result.datasets);
```

Use headers/credentials for application authentication. Expected server failures return error envelopes. Cancel live subscriptions with an AbortSignal or end iteration.

See the [complete ContentFn documentation](https://github.com/21nCo/super-functions/tree/dev/contentfn) for contracts, migration details and deployment configuration.
