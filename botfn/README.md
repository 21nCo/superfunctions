# BotFn

BotFn is the Superfunctions workspace for Discord and Slack bots. Packages live at `botfn/<pkg>` in this repository — not a standalone Turborepo, and not a `bots/` + `packages/` tree.

Bots deploy to **Cloudflare Workers** only.

## Packages

| Path | Package | Purpose |
| --- | --- | --- |
| `botfn/bot-discord` | `@superfunctions/botfn-discord-bot` | Discord slash commands (GitHub/Linear) on Cloudflare Workers |
| `botfn/bot-slack` | `@superfunctions/botfn-bot-slack` | Slack events endpoint on Cloudflare Workers |
| `botfn/discord-core` | `@superfunctions/botfn-discord-core` | Discord signature verification and interaction helpers |
| `botfn/slack-core` | `@superfunctions/botfn-slack-core` | Slack request verification |
| `botfn/github-integration` | `@superfunctions/botfn-github-integration` | GitHub App auth and API helpers |
| `botfn/linear-integration` | `@superfunctions/botfn-linear-integration` | Linear API helpers |
| `botfn/shared-types` | `@superfunctions/botfn-shared-types` | Shared Zod schemas and types |
| `botfn/persistence` | `@superfunctions/botfn-persistence-service` | tRPC issue/thread persistence on Postgres |
| `botfn/admin` | `@superfunctions/botfn-admin` | Optional Super Console operator surface |

See [AGENTS.md](./AGENTS.md) for layout and Cloudflare entrypoints.

## Development

Install from the repository root (`npm install`). BotFn is a `botfn/*` workspace of Superfunctions.

```bash
# Discord bot local Worker
npm run dev --workspace @superfunctions/botfn-discord-bot

# Slack bot local Worker
npm run dev --workspace @superfunctions/botfn-bot-slack

# Package tests
npx turbo run test --filter='./botfn/*'

# Package builds
npx turbo run build --filter='./botfn/*'
```

Discord setup and slash-command registration: [bot-discord/README.md](./bot-discord/README.md). Persistence (Postgres `DATABASE_URL`): [persistence/README.md](./persistence/README.md).

## npm package boundaries

The shared-types, discord-core, github-integration and linear-integration
packages ship compiled ESM with TypeScript declarations. Their builds and tests
use package-local compiler settings and declared test dependencies; they do not
resolve sibling workspace source.

The Discord bot's minimum npm prerequisite set is:

- `@superfunctions/botfn-shared-types`
- `@superfunctions/botfn-discord-core`
- `@superfunctions/botfn-github-integration`
- `@superfunctions/botfn-linear-integration`
- `@superfunctions/botfn-persistence-service`

These five foundations have no dependencies on each other and may be released in
any order before installing or releasing `@superfunctions/botfn-discord-bot`. Slack core is
independent of the Discord closure and exports both ESM and CommonJS.

Slack request verification accepts canonical decimal Unix-second timestamps only,
checks that the value is a safe integer, and rejects requests more than 300 seconds
from the current time in either direction. It verifies the HMAC against the original
request body without consuming it; the private Slack app can then dispatch signed events.

Run `npm install --workspaces=false`, `npm run build`, `npm test` and
`npm pack --dry-run` from an isolated copy of each package to check its release
boundary. Build before packing: npm exports point at `dist`, not TypeScript source.
Use `@superfunctions/botfn-persistence-service/client` for the public persistence client;
deep imports into the package's source tree are not supported.

BotFn's npm libraries live in the controlled `@superfunctions` organization.
The npm user scope `@botfn` belongs to an unrelated account; old namespace
references and release slugs are removed, not retained as aliases.
