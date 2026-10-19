---
title: Slack receiver
description: Verify Slack requests and understand the current event handler.
---

`@superfunctions/botfn-bot-slack` is a private Cloudflare Worker package with one route: `POST /slack/events`. It requires `SLACK_SIGNING_SECRET` and verifies Slack's `v0` HMAC signature with `verifySlackRequest` from `@superfunctions/botfn-slack-core`. The verifier accepts only canonical decimal Unix-second timestamps that are safe integers, rejects missing headers and timestamps more than 300 seconds from the current time in either direction, and reads a clone of the request so the original body stays available to the route.

The route returns a URL verification challenge when requested. For an event body, it logs the event type and responds `OK`. There are no Slack commands, message replies, or persistence writes in this entry point yet. `SLACK_BOT_TOKEN` is declared in the binding type but is not used by this route.

The package has no `wrangler.toml`. Its scripts pass the entry point directly: `dev` runs `wrangler dev src/index.ts` and `deploy:cloudflare` runs `wrangler deploy src/index.ts`. Because no configuration file names the Worker, supply the Worker name and compatibility date as Wrangler flags (for example `npm --workspace @superfunctions/botfn-bot-slack run deploy:cloudflare -- --name <worker> --compatibility-date <date>`) and set `SLACK_SIGNING_SECRET` with `wrangler secret put SLACK_SIGNING_SECRET --name <worker>`. Point the Slack app's event subscription at the deployed `/slack/events` URL. A local typecheck/build is `npm --workspace @superfunctions/botfn-bot-slack run build`.

If you add event handling, keep signature verification before JSON parsing, handle retries and idempotency for side effects, and use the host's own authorization model. The [Worker entry](https://github.com/21nCo/super-functions/blob/dev/botfn/bot-slack/src/index.ts), which holds the Worker and its Slack route, and the [verifier](https://github.com/21nCo/super-functions/blob/dev/botfn/slack-core/src/verify.ts) are the current contract.
