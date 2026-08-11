# Hosted Bot POC

This runs the RecFn bot API and worker on a server, so the macOS app does not
open Chrome locally.

## Recommended POC Infra

Use a DigitalOcean Droplet first. A Droplet is easier than managed containers
for Playwright/Chrome because we need process control, a persistent Google Meet
profile, and optional `xvfb` for headful Chrome on a virtual display.

## Runtime

```bash
npm --workspace recfn-server run build

RECFN_API_KEY=sk-local-dev \
RECFN_NAMESPACE=poc \
RECFN_PORT=8787 \
RECFN_MEET_PROFILE_DIR=/opt/recfn/profiles/google-meet-bot \
RECFN_BOT_HEADLESS=false \
npm --workspace recfn-server run poc:hosted-bot
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Create a bot:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/bots \
  -H "Authorization: Bearer sk-local-dev" \
  -H "Content-Type: application/json" \
  -d '{"meetingUrl":"https://meet.google.com/xxx-xxxx-xxx","config":{"displayName":"Recording Bot"}}'
```

## DigitalOcean Notes

Install Node, Chrome/Chromium, and Playwright dependencies on the Droplet. For
Google Meet, keep `RECFN_BOT_HEADLESS=false` and run the service under `xvfb`
if Chrome needs a display.

The server owns the signed-in bot profile at `RECFN_MEET_PROFILE_DIR`. The Mac
app only sends meeting URLs to this backend.
