# Exact-HEAD UI evidence

This directory stores the sanitized, source-controlled output of the final
Super Console production smoke probe. It is evidence for a specific Git commit,
not a substitute for rerunning the probe.

From the repository root, after building the final source:

```bash
SUPERCONSOLE_PROBE_SOURCE_COMMIT=$(git rev-parse HEAD) \
  SUPERCONSOLE_PROBE_ARTIFACTS=superconsole/.conduct/SFN-21/evidence/final \
  npm run probe:smoke --workspace=superconsole
```

The probe uses the real CiFn administration adapter and an in-memory CiFn
control plane. It verifies selected-module discovery, overview, run and log
views, audited cancel/retry mutations, mobile navigation, Escape handling, and
focus restoration. The output contains screenshots, a result manifest, and
sanitized browser/server text. Machine paths and the local probe URL are not
part of the committed result manifest.

The final verification record must name the exact commit and commands used to
produce the evidence. Any source change after capture invalidates the evidence
until the probe is rerun.
