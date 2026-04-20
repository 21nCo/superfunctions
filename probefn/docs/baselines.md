# Baselines

Probefn stores visual baselines locally and compares new checkpoints against those local references.

## Record A Baseline

First create a checkpoint:

```bash
pnpm probefn checkpoint create --session sess_healthy --name landing --include-trace --include-styles --json
```

Then record a baseline:

```bash
pnpm probefn baseline record \
  --session sess_healthy \
  --checkpoint chk_landing \
  --key home.desktop.chromium.light.1440x900.utc \
  --json
```

## Compare Against A Baseline

```bash
pnpm probefn baseline compare \
  --session sess_healthy \
  --checkpoint chk_landing \
  --key home.desktop.chromium.light.1440x900.utc \
  --json
```

Comparison results include:

- pixel diff summary
- semantic/layout regressions
- diff image path
- missing-baseline errors when the key does not resolve
- mismatch errors when the baseline exists but the comparison cannot be satisfied cleanly

## Baseline Storage

Baseline data lives under `.artifacts/baselines/`.

- `registry.json` records baseline entries
- copied checkpoint artifacts are stored under `.artifacts/baselines/entries/...`

Auth-profile artifact paths are filtered from exported baseline metadata, so local login material does not leak into the registry.

## Recommended Workflow

1. Capture a deterministic checkpoint on the known-good page.
2. Record the baseline with a stable key.
3. Re-run after the change.
4. Compare the new checkpoint against the same key.
5. Review semantic and pixel regressions together before deciding whether to update the baseline.
