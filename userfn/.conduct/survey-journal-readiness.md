# Opt-in browser survey journal checkpoint

The renderer previously retained uncertain answers and idempotency keys only in
one client instance. An opt-in `surveyJournal: { storageKey }` now persists an
immutable pending response before sending, restores it after reload, and records
accepted response counts only after a verified service receipt. Unknown outcomes
retry the original key/payload. A failed initial write prevents sending; a failed
receipt write preserves the persisted pending key. Invalid/corrupt journal data,
including present-but-falsy pending entries, fails closed rather than allocating
a replacement key.

A SHA-256 digest of normalized endpoint and credential separates credential
scopes; local user/survey tuples identify entries within that scope. Scope
mismatch rejects reuse. Web Locks serialize cooperating same-origin tabs sharing
the key across the complete request and receipt write. A second stale form sees
the changed count and does not send another response. Consent and identity fences
are checked again after waiting for the lock. Existing active requests may still
commit; late receipts remain associated with the original owner and cannot
acknowledge another identity's UI.

Recovery only resends a previously persisted immutable attempt. It may surface
after local schedule expiry, but server admission/replay and quota rules remain
authoritative. The current survey definition must still be supplied. There is no
background retry or automatic offline delivery. Default behavior remains in-memory;
direct caller-keyed submission and Python clients do not use this browser journal.

## Privacy, retention and limits

Pending answers and local identity/survey IDs are plaintext origin storage. The
scope hash is not encryption, authorization or protection from other origin
scripts; low-entropy credentials can be guessed. Hosts must explicitly choose
whether retaining answers is appropriate and own reconciliation, rotation and
deletion. Neither logout/consent withdrawal nor credential change automatically
erases an uncertain response. Deleting storage or browser eviction loses keys and
counts; later fresh keys are possible, so service quotas remain authoritative.

No eviction/expiration is automatic. Maximum100 owner entries includes completed
counts; the journal has a262144-byte UTF-8 serialized cap and pending answer bodies
have a65536-byte/100-answer cap. These are payload bounds, not physical disk quotas.
Custom storage must provide durable atomic synchronous writes shared by the same
cooperating tabs. Missing Web Locks/Web Crypto or storage failures reject. Lock
wait has no timeout; another holder or suspended browser can delay it. Per-request
timeouts depend on active browser timers and do not bound suspension or lock waits.
Different origins/partitions/profiles/devices/storage keys are not coordinated.
Durable cross-device recovery, automatic offline delivery, host retention policy,
Python journal parity and full survey analytics remain open.

## Validation

- SDK Vitest:266 passed across22 files. Typecheck and build passed.
- Actual isolated Chrome154.0.8037.58 context → local HTTP service → owned SQLite:
  lost receipt retained identical key/body; reload recovered after local schedule
  expiry; saved count survived reload; credential change rejected; two tabs in
  one explicit context produced exactly one request while the first receipt was
  held; six service responses persisted across the complete fixture.
- Existing identity/consent fences, typed choices, conditional branches, keyboard
  dialogs, feedback retry, local-mode acknowledgement and absence of
  `crypto.randomUUID` remain covered by the same native fixture.
- Fresh `userfn` and `@watchfn/browser` tarballs installed in an isolated consumer.
  ESM/CJS constructor imports and strict NodeNext declarations passed. The native
  fixture then bundled that installed SDK and passed the complete browser test.
- Unit regressions include initial/receipt storage failures, malformed state,
  capability absence, immutable replay, credential isolation,100-entry retention,
  and consent withdrawal while queued behind another owner's lock.

Reproduce after building the normal service/SDK closure:

```sh
USERFN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node userfn/typescript/scripts/verify-survey-renderer.mjs
USERFN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node userfn/typescript/scripts/verify-survey-journal-package.mjs
```

The package fixture accepts `USERFN_NPM_CLI`; the native fixture accepts
`USERFN_CHROME_PATH` and optional `USERFN_SDK_ENTRY`. No user browser profile is
opened. Owned browser contexts, HTTP listener, SQLite database and package consumer
directories were closed/deleted by fixture cleanup. Logs are
`/tmp/userfn-journal-{native,package,tests,types,build}.log`. No external provider,
public deployment, release or push was performed.
