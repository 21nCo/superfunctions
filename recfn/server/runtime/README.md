# Google Meet Bot Runner

This runtime is the service-backed bot joiner used by the macOS POC in `/Volumes/T7/21n/poc/ios/MeetingRecordingPOC`.

It exists so `Bot Joiner` can behave more like ClickUp:

- the bot joins as a second participant,
- your local Mac app only calls an API,
- your local machine does not need to open another visible Chrome window.

## Run

From `/Volumes/T7/21n/super-functions.next/recfn/server`:

```bash
npm install
npm run poc:meet-login
npm run poc:meet-runner
```

`npm run poc:meet-login` is a one-time setup step for the default persistent bot Chrome profile. It opens a visible browser window using the same profile that the headless bot runner will reuse later.

Sign into the dedicated bot Google account in that window, then close it. After that, `npm run poc:meet-runner` will keep reusing that signed-in profile so Meet can create a real admission request instead of treating the bot like a fresh anonymous guest every run.

Defaults:

- Port: `4040`
- API key: `recfn-local-dev-key`
- Headless mode: `true`
- Bot profile name: `default`

## Environment

- `RECFN_BOT_RUNNER_PORT`
- `RECFN_BOT_RUNNER_API_KEY`
- `RECFN_BOT_RUNNER_HEADLESS`
- `RECFN_BOT_RUNNER_OUTPUT_DIR`
- `RECFN_BOT_PROFILE_NAME`
- `RECFN_BOT_PROFILE_DIR`
- `RECFN_BOT_LOGIN_URL`
- `CHROME_EXECUTABLE_PATH`

## API

- `GET /health`
- `POST /api/v1/poc/bots`
- `GET /api/v1/poc/bots/:botId`
- `POST /api/v1/poc/bots/:botId/stop`

All routes except `/health` require:

```http
Authorization: Bearer <api-key>
```
