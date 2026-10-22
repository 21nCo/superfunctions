# LogFn pipeline throughput checkpoint — 2026-10-22

Reproduction: build `@logfn/core`, then run `node logfn/.conduct/pipeline-throughput.mjs > /dev/null 2> receipt.json`. Run three separate processes for the table below. Default event count is 2,000 per case (bounded configurable range 100–20,000); each process has a 60-second deadline.

The benchmark uses the actual JSON console sink writing to `/dev/null` and the actual HTTP sink delivering batches to an owned ephemeral localhost receiver. Each producer flushes after 100 events to bound backlog. HTTP completion includes request parsing, redaction assertions, unique sequence checks and acknowledgement. Each case uses 0, 2 or 4 real context-enrichment stages; default terminal redaction always remains enabled. Nested payload string sizes are 128 and 4,096 bytes, before envelope overhead. Console privacy is checked with the real formatter before timing.

These are informational single-host measurements, not performance thresholds or interactive-terminal/network/provider acceptance. Fixed case order, JIT warmup, concurrent host load and transport validation overhead affect results; deeper pipelines are not claimed to be faster. Console destination is `/dev/null`, not a terminal. Three independent processes were used; no artificial sink replaces console output during timing.

| Sink | Payload bytes | Stages | Median events/s | Observed range events/s |
| --- | ---: | ---: | ---: | ---: |
| console | 128 | 0 | 54116 | 29158–54981 |
| console | 128 | 2 | 52179 | 26850–54572 |
| console | 128 | 4 | 44920 | 26046–47804 |
| console | 4096 | 0 | 19319 | 8217–19599 |
| console | 4096 | 2 | 18951 | 7934–19474 |
| console | 4096 | 4 | 17918 | 6224–17949 |
| http | 128 | 0 | 33367 | 11672–34524 |
| http | 128 | 2 | 50461 | 16107–54292 |
| http | 128 | 4 | 46110 | 23255–47044 |
| http | 4096 | 0 | 17212 | 6883–18045 |
| http | 4096 | 2 | 16775 | 9115–16912 |
| http | 4096 | 4 | 15876 | 5341–15945 |

All HTTP cases received all 2,000 unique events in 20 requests, with zero logger/receiver errors and no sentinel secret in received bodies. Each owned HTTP server closed. Three runs delivered 36,000 HTTP events in total. No external destination was contacted.

Shared c0ce24b30 was merged normally before these measurements. On the merged branch, 241 core tests, core typecheck/build, actual Turbo graph resolution, and normal npm11 root ci dry-run passed. Lock dry-run is not a fresh installation or full monorepo build. Native provider, browser, broader specification and hosted CI gates remain open. No release or deployment. `.conduct` evidence is included; ignore rules and runtime source are unchanged.
