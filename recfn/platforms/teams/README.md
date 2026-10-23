# RecFn Microsoft Teams Platform Adapter

Headless browser adapter for joining Microsoft Teams meetings, capturing audio, tracking participants, and capturing/sending chat messages.

## Approach

**Headless browser** (chosen over Microsoft Graph Communications API):

- **Graph API** requires Azure Bot registration, app registration, and OAuth. Complex setup.
- **Headless browser** works with standard Teams meeting links; simpler to get started.

## Prerequisites

- **Chrome/Chromium**: `npx playwright install chromium`
- **Microsoft account** for bot (Teams typically requires sign-in to join meetings)

## Usage

```typescript
import { TeamsAdapter } from '@recfn/teams';

const adapter = new TeamsAdapter();
await adapter.join('https://teams.microsoft.com/l/meetup-join/...', botConfig);
const stream = adapter.getAudioStream();
// ...
await adapter.leave();
```

## Configuration

- `browser`: Inject Playwright Browser instance (e.g., for tests)
- `testPage`: Inject mock Page for unit tests
- `userDataDir`: Path to persistent profile for pre-authenticated Microsoft account
- `joinTimeout`: Join timeout in ms (default 30000)

## Manual Integration Test

1. Create a Teams meeting and copy the join link
2. Run a bot with the Teams adapter against the meeting URL
3. Verify: bot joins, captures audio snippet, lists participants
