# Campaign content and navigation safety

2026-10-20. The existing toast renderer interpreted campaign title/body strings as
HTML, whereas the modal renderer already treated those fields as text. The public
campaign action callback also assigned arbitrary CTA URLs to `window.location`.

## Reproduction and corrected behavior

Actual Chrome 154.0.8037.58 reproduced both title and body `<img onerror>` execution
through `UserFnClient.setCampaigns` → `trigger` → inbox-item toast, and execution
of a `javascript:` modal CTA. The pre-change built SDK was exercised with
`verify-renderer-browser.mjs --expect-vulnerable`; both witnesses executed.

Toast title/body now use DOM text nodes, matching existing modal string behavior.
The hostile markup is displayed literally and creates no image/SVG nodes or event
handlers. No HTML/Markdown sanitizer or parser is being claimed. Existing users
who put HTML markup in toast strings now see literal markup; this intentional
security correction does not remove a supported typed rich-content format.
The original specification's explicit safe rich-text/Markdown subset remains
unimplemented and must be designed/tested before enabling formatted content.

CTA navigation resolves against the current page URL and permits HTTP, HTTPS,
mailto and tel. Relative paths, query/fragment links and protocol-relative HTTP(S)
links remain supported. Script/data/file/blob/unknown schemes and malformed URLs
are rejected. Checks run at interaction time and again at the public navigation
boundary, so mutation of a previously valid campaign URL cannot bypass the guard.
Invalid destinations do not invoke the renderer action callback or navigate.
This is a scheme allowlist, not a destination-domain trust policy or redirect
sandbox; applications still control where valid external URLs point.

## Validation

- Full TypeScript SDK unit suite, typecheck and ESM/CJS build pass. Focused URL
  vectors cover mixed-case/control-character script schemes, malformed URLs,
  intended HTTP(S)/relative/query/fragment/mailto/tel targets and unknown schemes.
- Actual Chrome regression uses the built SDK, not a source-only renderer import.
  Title/body payloads remain literal; script/data/file/blob/vbscript CTA targets
  cannot navigate; a valid URL changed to script after render is blocked; modal
  relative navigation and toast fragment navigation still work.
- The script uses local HTTP and an isolated headless browser, then closes servers,
  browser and temporary bundle files. No external protocol application is launched;
  mailto/tel resolution is covered by focused unit vectors.

Reproduction after building the SDK:

```sh
USERFN_PLAYWRIGHT_MODULE=/Volumes/Dev/n/superfunctions/node_modules/playwright/index.mjs \
node userfn/service/scripts/verify-renderer-browser.mjs
```

The `--expect-vulnerable` option is only for an intentionally supplied pre-fix
build and must fail on the corrected build. This checkpoint addresses the unsafe
content/navigation paths identified in `original-requirements-status.md`; it does
not complete rich content, full accessibility/focus management, banner/tooltip,
durable messaging/caps, Watch message analytics or the other original milestones.
Python has no browser renderer or navigation path, so no Python source changed.
