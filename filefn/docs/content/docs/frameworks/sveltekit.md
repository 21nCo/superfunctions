---
title: SvelteKit
description: Production-grade SvelteKit integration — server-side filefn, client-side @filefn/client, hooks-based session forwarding, and RPC-style file APIs.
---

# SvelteKit

```ts
// src/lib/server/filefn.ts
import { createFileFn, createNucleusPolicies } from "@filefn/server";
import { authFn } from "$lib/server/auth";
import { db, storage } from "$lib/server/infrastructure";

export const fileFn = createFileFn({
  db, storage,
  policies: createNucleusPolicies(),
  auth: {
    resolveSession: async (request) => {
      const session = await authFn.getSession(request);
      return session ? { principalId: session.userId, tenantId: session.tenantId } : null;
    },
    required: false,
  },
});
```

With `required: false`, requests without a session are served as the shared `anonymous` principal: they can upload, but nobody owns an anonymous upload, so they cannot read back a private one, share it or delete it. Set `required: true` if every upload should belong to a signed-in user.

```ts
// src/routes/filefn/[...path]/+server.ts
import type { RequestHandler } from "./$types";
import { fileFn } from "$lib/server/filefn";

const handler: RequestHandler = async ({ request }) => {
  return (await fileFn.router.handle(request)) ?? new Response("Not Found", { status: 404 });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
```

## Client wiring

```ts
// src/lib/client/filefn.ts
import { createFileFnClient } from "@filefn/client";
import { browser } from "$app/environment";

// Offline work is scoped to the signed-in user: on sign-out or a user change,
// call filefnClient.dispose() and create a new client. `readStoredAccessToken`
// returns a token your server issued for that user at sign-in (or null).
export const filefnClient = browser
  ? createFileFnClient({
      baseUrl: "/filefn",
      offline: {
        enabled: true,
        partition: { serviceId: "app", principal: { kind: "user", principalId: getSignedInUserId() } },
        currentPrincipal: () => ({ kind: "user", principalId: getSignedInUserId() }),
        // Queued replays send no cookies: a token issued for exactly this
        // user (null when this device holds none for them).
        getAuthHeaders: (principal) => {
          const token = principal.kind === "user" ? readStoredAccessToken(principal.principalId) : null;
          return token ? { Authorization: `Bearer ${token}` } : null;
        },
      },
    })
  : null;
```

## Upload component

```svelte
<!-- src/lib/components/FileUpload.svelte -->
<script lang="ts">
  import { filefnClient } from "$lib/client/filefn";

  let progress = $state(0);
  let result = $state<{ fileId: string; versionId: string } | null>(null);

  async function handleSelect(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !filefnClient) return;

    const handle = filefnClient.uploadFile({ policy: "public-image", file });
    handle.onProgress(({ bytesUploaded, bytesTotal }) => {
      progress = (bytesUploaded / bytesTotal) * 100;
    });
    result = await handle.done();
  }
</script>

<input type="file" accept="image/*" on:change={handleSelect} />
{#if progress > 0 && progress < 100}<progress value={progress} max="100" />{/if}
{#if result}Uploaded: {result.fileId}{/if}
```

## Renderable previews

```svelte
<script lang="ts">
  import { filefnClient } from "$lib/client/filefn";
  import type { RenderDescriptor } from "@filefn/client";

  let { fileId } = $props<{ fileId: string }>();
  let descriptor = $state<RenderDescriptor | null>(null);

  $effect(async () => {
    if (!filefnClient) return;
    descriptor = await filefnClient.resolveRenderable({ fileId, intent: "preview", preferLocal: true });
  });
</script>

{#if descriptor?.state === "ready" && descriptor.source.mode === "url"}
  <img src={descriptor.source.url} alt="" />
{:else if descriptor?.state === "processing"}
  <p>Processing...</p>
{:else if descriptor?.state === "pending-local" && descriptor.source.mode === "url"}
  <img src={descriptor.source.url} alt="" />
{:else if descriptor?.state === "unsupported"}
  <p>Preview not available</p>
{/if}
```

## hooks.server.ts

If you want SvelteKit's `event.locals.user` populated for filefn's auth resolution to read from:

```ts
// src/hooks.server.ts
import { authFn } from "$lib/server/auth";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const session = await authFn.getSession(event.request);
  if (session) {
    event.locals.user = { id: session.userId, tenantId: session.tenantId };
  }
  return resolve(event);
};
```

## See also

- [Quickstart › SvelteKit](../quickstart/sveltekit) — minimal version.
