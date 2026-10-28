---
title: Getting started
description: Initialize a TypeScript client with a database and provider.
---

Install the TypeScript SDK and shared adapters:

```sh
npm install sendfn @superfunctions/db @superfunctions/http
```

Supply a `@superfunctions/db` adapter and at least the provider for the channel you send. The following uses the in-memory database adapter and the console SMS adapter for local development:

```ts
import { sendfn, consoleSmsAdapter } from "sendfn";
import { memoryAdapter } from "@superfunctions/db/adapters";

const database = memoryAdapter(); // Replace with a Drizzle, Prisma, or Kysely adapter for persistence.
const client = sendfn({ database, smsProvider: consoleSmsAdapter() });

await client.sms({ userId: "user-123", to: "+1234567890", message: "Hello" });
```

The memory adapter loses its records when the process exits. Console SMS logs instead of delivering. For email, use a configured provider such as `awsSesAdapter` and set `email.fromEmail`. See the [TypeScript source guide](/docs/reference/typescript) for complete configuration and examples.
