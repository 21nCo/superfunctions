# `@mailfn/sendfn`

Outbound composition adapter between MailFn and SendFn.

```ts
import { createSendFnAdapter } from '@mailfn/sendfn';

const adapter = createSendFnAdapter(sendfn);
```

The adapter prefers SendFn's modern `sendEmail` surface and supports the legacy `email` surface without embedding provider implementations in MailFn. It preserves a stable draft idempotency key, reply `In-Reply-To`/`References`, attachment IDs, MailFn inbox/draft/thread metadata, and the logical sender address. The modern `sendEmail` payload does not include the project ID; the legacy `email` surface receives it as `userId` unless the `userId` option overrides it. The underlying SendFn delivery implementation must honor the idempotency key. Public-platform outbound remains subject to MailFn production-security, domain, scope, and daily-quota gates.
