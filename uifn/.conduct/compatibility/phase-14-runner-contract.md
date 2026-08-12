# Phase 14 exact compatibility runner contract

This contract provisions the external infrastructure required by `.github/workflows/uifn-phase-14-compat.yml`. The workflow is manually dispatched, freezes one clean commit, attests the six package tarballs plus the complete browser consumer kit, and signs one result document per matrix cell. A queued, skipped, stale, emulated, unsigned, or incomplete cell is a release failure.

## Exact-product desktop runners

Register self-hosted runners with every label in the applicable row. The executable variable must resolve to that runner's real installed product binary. The runner probes the binary's product/version output before execution; generic Chromium cannot satisfy Chrome or Edge.

| Cells | Required labels | Repository variable |
| --- | --- | --- |
| `chrome-latest` | `self-hosted`, `uifn-phase14`, `chrome-latest` | `UIFN_PHASE14_CHROME_LATEST_EXECUTABLE` |
| `chrome-previous` | `self-hosted`, `uifn-phase14`, `chrome-previous` | `UIFN_PHASE14_CHROME_PREVIOUS_EXECUTABLE` |
| `firefox-latest` | `self-hosted`, `uifn-phase14`, `firefox-latest` | `UIFN_PHASE14_FIREFOX_LATEST_EXECUTABLE` |
| `firefox-previous` | `self-hosted`, `uifn-phase14`, `firefox-previous` | `UIFN_PHASE14_FIREFOX_PREVIOUS_EXECUTABLE` |
| `edge-latest` | `self-hosted`, `uifn-phase14`, `edge-latest` | `UIFN_PHASE14_EDGE_LATEST_EXECUTABLE` |
| `edge-previous` | `self-hosted`, `uifn-phase14`, `edge-previous` | `UIFN_PHASE14_EDGE_PREVIOUS_EXECUTABLE` |

Latest and previous Chrome, Firefox, and Edge must be distinct consecutive major versions when the evidence is verified.

## Real Safari runners

Safari must use SafariDriver/WebDriver on the real Safari product. Playwright WebKit is rejected.

| Cell | Required labels | Repository secrets |
| --- | --- | --- |
| `safari-current` | `self-hosted`, `uifn-phase14`, `safari-current` | `UIFN_PHASE14_SAFARI_CURRENT_WEBDRIVER_URL`, `UIFN_PHASE14_SAFARI_CURRENT_CAPABILITIES` |
| `safari-previous` | `self-hosted`, `uifn-phase14`, `safari-previous` | `UIFN_PHASE14_SAFARI_PREVIOUS_WEBDRIVER_URL`, `UIFN_PHASE14_SAFARI_PREVIOUS_CAPABILITIES` |

The W3C session capabilities must report exact `browserName` and `browserVersion`. The workflow treats these endpoints as local to their macOS runners and records the runner's exact OS name, kernel version, and architecture.

## Physical device lab

The device jobs require physical Appium/WebDriver sessions. Simulator/emulator sessions cannot pass.

| Cell | Required labels | Capabilities secret | Reachable-host variable | Architecture variable |
| --- | --- | --- | --- | --- |
| `ios-safari-current` | `self-hosted`, `uifn-phase14`, `device-lab`, `ios-current` | `UIFN_PHASE14_IOS_CURRENT_CAPABILITIES` | `UIFN_PHASE14_IOS_CURRENT_PUBLIC_HOST` | `UIFN_PHASE14_IOS_CURRENT_ARCHITECTURE` |
| `ios-safari-previous` | `self-hosted`, `uifn-phase14`, `device-lab`, `ios-previous` | `UIFN_PHASE14_IOS_PREVIOUS_CAPABILITIES` | `UIFN_PHASE14_IOS_PREVIOUS_PUBLIC_HOST` | `UIFN_PHASE14_IOS_PREVIOUS_ARCHITECTURE` |
| `android-chrome-current` | `self-hosted`, `uifn-phase14`, `device-lab`, `android-current` | `UIFN_PHASE14_ANDROID_CURRENT_CAPABILITIES` | `UIFN_PHASE14_ANDROID_CURRENT_PUBLIC_HOST` | `UIFN_PHASE14_ANDROID_CURRENT_ARCHITECTURE` |

Shared device-lab configuration:

- Secret `UIFN_PHASE14_DEVICE_LAB_WEBDRIVER_URL` identifies the authenticated W3C WebDriver/Appium endpoint.
- Variable `UIFN_PHASE14_DEVICE_LAB_PROVIDER` names the provider.
- Variable `UIFN_PHASE14_DEVICE_LAB_SESSION_URL_TEMPLATE` is an immutable HTTPS session URL containing `{sessionId}`.
- Each public-host value must be reachable from the physical device through the lab tunnel or local network. The runner binds the exact frozen Vite consumer kit to a random port on that host.
- Returned capabilities must identify the real browser version, OS/platform version, device name/model, and architecture. iOS current and previous must be distinct ordered versions.

## Rendering runner

All nine rendering cells use the exact `chrome-latest` self-hosted runner and `UIFN_PHASE14_CHROME_LATEST_EXECUTABLE`. The harness applies and then measures each profile in React, Svelte, and Solid:

- `ltr` and `rtl`: computed document direction.
- `forced-colors` and `high-contrast`: active forced-colors media query; high contrast also requires the high-contrast theme marker.
- `reduced-motion`: active reduced-motion media query.
- `zoom-200` and `zoom-400`: Chrome page-scale factor with measured `visualViewport.scale` of 2 or 4.
- `theme-light` and `theme-dark`: matching color-scheme media query plus exact theme marker.

## Acceptance and evidence collection

Each of the 35 cells must upload exactly one `.compat.json`, its `.compat.sigstore.json`, and the raw `.result.json`. Compatibility schema version 3 records the exact raw-result filename and canonical SHA-256 in each cell. The attestation action must sign the compatibility document and raw result together in one bundle. Download all cell artifacts into one evidence directory and run `scripts/verify-uifn-phase-14-compat.mjs` against the attested freeze `trace-run.json`; the verifier checks both subjects with that bundle, recomputes the raw-result hash, and requires the raw result to reproduce the signed cell environment, command, observation, and device-lab fields. Missing, renamed, tampered, independently attested, or structurally divergent raw results fail closed. Do not copy local smoke results into the signed evidence directory: they are diagnostic only and cannot satisfy a matrix cell.
