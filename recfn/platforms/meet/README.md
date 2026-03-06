# RecFn Google Meet Platform Adapter

Headless browser adapter for joining Google Meet meetings, capturing audio, tracking participants, and capturing/sending chat messages.

## Prerequisites

- **Chrome/Chromium**: Install via `npx playwright install chromium`
- **Google account** (optional): Some meetings allow "Ask to join" without authentication. Meetings that require auth need a pre-authenticated browser profile (`userDataDir`).

## Usage

```typescript
import { MeetAdapter } from 'recfn-meet';

const adapter = new MeetAdapter();
await adapter.join('https://meet.google.com/abc-defg-hij', botConfig);
const stream = adapter.getAudioStream();
// ...
await adapter.leave();
```

## Configuration

- `browser`: Inject Playwright Browser instance (e.g., for tests)
- `testPage`: Inject mock Page for unit tests
- `userDataDir`: Path to persistent profile for pre-authenticated Google account
- `joinTimeout`: Join timeout in ms (default 30000)

## Manual Integration Test

1. Create a Google Meet: https://meet.google.com/new
2. Run a bot with the Meet adapter against the meeting URL
3. Verify: bot joins, captures audio snippet, lists participants
