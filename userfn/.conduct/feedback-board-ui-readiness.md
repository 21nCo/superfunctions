# Embeddable feedback board checkpoint

Original UserFn milestone3 requires an embeddable feedback board and browser
voting flow. The existing typed listing/voting service had no rendered board.
`client.mountFeedbackBoard(container, options)` now appends an owned accessible
section with status/tag/product-area filters, cursor pagination and explicit
upvote/downvote/removal. Rendering uses text nodes only. Updates require a matching
vote receipt; uncertain outcomes block further voting until refresh reconciles
server state. Filter generations discard stale completions. Client identity
changes/disposal remove the owned section and fence late requests without clearing
unrelated host content. The handle exposes refresh/dispose.

The display is bounded to1,000 records, validates pages/receipts and rejects
repeated cursors instead of looping. Existing HTTP retries/deadlines and service
AuthFn/shared-adapter contracts are reused; no new transport or storage abstraction
is introduced. Browser UI is not a Python API requirement; Python's existing
board endpoints are unchanged.

Validation:
-268 SDK tests pass; strict TypeScript checking and ESM/CJS/declaration build pass.
-Actual isolated Chrome154.0.8037.58 → UserFn HTTP → native SQLite passes pagination,
 filters, hostile HTML displayed as text, upvote/downvote/removal, receipt-driven
 pressed state and focus, committed vote followed by503 then refresh reconciliation,
 stale filter completion, denied read-only voting, foreign-tenant empty listing,
 identity disposal while a read is held, and preservation of host children.
-15 actual API requests in the final board fixture; no votes remain after removal.
-Fresh two-tarball SDK consumer passes strict board handle declarations and the same
 native browser flow with the installed SDK bundle. Existing full survey/journal
 browser acceptance also passes with7 stored responses. Installed ESM/CJS imports
 and construction remain valid.

Logs: /tmp/user-board-{tests,types,build,native,package}.log. Scripts are
`typescript/scripts/verify-feedback-board.mjs` and the combined installed consumer
`typescript/scripts/verify-survey-journal-package.mjs`. Owned browser, HTTP server,
SQLite and temporary consumer/profile resources are closed/removed in finally.
No external provider or user browser profile is touched.

Live cursor pagination is not snapshot-consistent or ranked. Cross-browser/screen
reader acceptance, theme APIs, external sources, merges, moderation, roadmap and
changelog remain open original requirements. Disposing fences presentation but
does not revoke an already accepted server mutation. No full-readiness claim.
