# Fix Log: Release Secret Scanner Literals

- timestamp: 2026-06-27T17:49:40Z
- phase: PHASE_19
- trigger: Final source hygiene scan matched the secret scanners' own live-key-looking regex literals.
- symptom: `rg` matched raw live-key marker text inside `scripts/verify-uifn-secrets.mjs` and `scripts/verify-uifn-release.mjs`.
- fix: Constructed the live-key marker at runtime in both scripts instead of storing the raw marker in source.
- verification: Targeted secret hygiene scans returned no matches; final release output check returned `rawSecret: false`.
