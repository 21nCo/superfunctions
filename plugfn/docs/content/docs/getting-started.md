---
title: Getting started
description: Configure a TypeScript runtime and mount owned routes.
---

Install the runtime, provider package, and shared adapters:

```sh
npm install plugfn @plugfn/providers @plugfn/client @superfunctions/db@0.3.2 @superfunctions/http@0.2.0 @superfunctions/http-express@0.2.0 express
```

Supply a durable database adapter and provision its schema before serving requests.

## Application-owned setup and mounting

Keep construction in a server-only module. The following factory accepts the host's durable database and verified session resolver explicitly:

```ts
import { createHash } from "node:crypto";
import express from "express";
import type { Adapter } from "@superfunctions/db";
import { toExpress } from "@superfunctions/http-express";
import { plugFn, createPlugFnRouter, type PlugFnPrincipal, type WebhookWorkflowAuthority } from "plugfn";
import { githubProvider } from "@plugfn/providers";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export async function createIntegrationApp(
  database: Adapter,
  authenticate: (request: Request) => Promise<PlugFnPrincipal | null>,
  resolveGitHubInstallation: WebhookWorkflowAuthority["resolve"],
) {
  const githubWebhookSecret = required("GITHUB_WEBHOOK_SECRET");
  const plug = plugFn({
    database,
    auth: { authenticate },
    baseUrl: required("APP_URL"),
    encryptionKey: required("PLUGFN_ENCRYPTION_KEY"),
    webhooks: {
      workflowBindings: {
        github: [{
          id: "github-app",
          credentialFingerprints: [createHash("sha256").update(githubWebhookSecret).digest("hex")],
          resolve: resolveGitHubInstallation,
        }],
      },
    },
    workflows: {
      runtime: { actions: { recordPush: async (context) => ({ event: context.trigger.event }) } },
    },
    integrations: {
      github: {
        clientId: required("GITHUB_CLIENT_ID"),
        clientSecret: required("GITHUB_CLIENT_SECRET"),
      },
    },
  });
  plug.providers.register(githubProvider);
  await plug.ready;
  const app = express();
  // Keep original bytes for webhook signature verification.
  const router = createPlugFnRouter(plug, { webhookSecret: { github: githubWebhookSecret } });
  app.use("/api/plugfn", express.raw({ type: "*/*", limit: "2mb" }), toExpress(router));
  return { app, plug };
}
```

Call this factory from your host bootstrap, then `app.listen(...)` or mount the returned app in your existing Express server. Provision PlugFn's `getSchema()` tables with the host migration system first. `plug.ready` rejects if persisted workflow triggers cannot be restored; do not report the service ready before it resolves.

Set `GITHUB_WEBHOOK_SECRET` to the GitHub App's configured webhook secret and point the App's webhook URL at `/api/plugfn/webhooks/github`. Enable the webhook, grant the App read access to repository contents, and subscribe to the Push event. The installation resolver reads the server-owned registry for that App. Return one active match with its `tenantId`, `connectionId`, and a registry-owned `revoked` signal, or an empty array for an unknown installation. Reuse that signal while the binding stays active and abort it when the binding changes or is revoked. Use the same registry when authorizing workflow creation.

If a custom provider emits class instances in its webhook event, set `webhookConfig.cloneWorkflowEvent` to copy the event for each workflow. Return independent copies of all mutable values and preserve the event's types. PlugFn's default copy handles structured data and buffers.

`PLUGFN_ENCRYPTION_KEY` is a 32-byte key encoded as 64 hexadecimal characters. Generate and store it once in the deployment's secret manager; changing it without migrating encrypted connection state makes stored credentials unreadable. Set `APP_URL` to the application's public URL. Register the exact callback URI, such as `https://app.example.com/api/plugfn/callback/github`, with the provider and supply that URI when starting the connection.

The host resolver returns an authenticated `userId` and, where applicable, `tenantId`. Returning null denies protected routes. Browser-supplied owner fields do not replace that identity. Continue with [Connections and OAuth](/docs/connections-and-oauth) and [Actions, workflows, and sync](/docs/workflows-and-sync).
