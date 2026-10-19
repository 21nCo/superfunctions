---
title: Integration helpers
description: Reuse Discord, Slack, GitHub, Linear, and schema helpers.
---

`@superfunctions/botfn-discord-core` exports the Discord request verifier, interaction constants, option helper, and response update helper. `verifyDiscordRequest(request, publicKey)` consumes the raw request body, checks Ed25519 signature headers, parses JSON, and validates a basic interaction shape. Pass the returned parsed, Zod-validated `body` to downstream handlers. It is not the original raw body: unknown fields outside the schema are stripped.

`@superfunctions/botfn-slack-core` exports `verifySlackRequest(request, signingSecret)` and the `SlackEvent` and `SlackSlashCommand` types. The verifier accepts only canonical decimal Unix-second timestamps that are safe integers, rejects requests more than 300 seconds from the current time in either direction, and compares an HMAC-SHA256 signature over `v0:timestamp:raw-body` in constant time. It reads a clone of the request, so the caller can still consume the original body. The package ships ESM and CommonJS builds and is independent of the Discord packages.

`@superfunctions/botfn-github-integration` exports `GitHubClient`, `githubRequest`, and GitHub App token helpers. The client caches an installation token for 55 minutes; `githubRequest` is a one-off helper that fetches a token for each call. Supply App ID, installation ID, and private key. Callers own repository permission checks and must handle external API failures.

`@superfunctions/botfn-linear-integration` exports `LinearClient`, `linearRequest`, `getTeams`, `searchIssues`, `getIssue`, `createIssue`, and `createComment`. These call Linear's GraphQL endpoint using the supplied API key and throw on HTTP or GraphQL errors. Scope the key to the intended workspace and operations.

`@superfunctions/botfn-shared-types` provides Zod schemas and TypeScript types for Discord interactions, GitHub, and Linear structures. These schemas validate shapes; they do not authenticate requests. The [package map](/docs/reference/packages) links each source entry point.
