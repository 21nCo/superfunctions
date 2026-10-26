# Hosted checks — October 26, 2026

Read once after publication through GitHub CLI using thyaravind. No check reruns, billing changes, deployment or account changes. These hosted results are separate from local validation.

| Draft | Exact head | Failure count | Skipped count |
| --- | --- | ---: | ---: |
| 55 | e3c4ad24cfbcf1ac6da17a5f92a9e0e261d8b66c | 6 | 5 |
| 58 | 46758eaef626b5f332fed064fa8a32eb290f7f34 | 6 | 6 |
| 60 | 2bdccf4ac9badbf29ef124ab71f9055fba717d27 | 3 | 2 |
| 65 | d9ea303680c247c1718d4287d20fd65f63807994 | 3 | 2 |

Shared55 and Watch58 Plan jobs failed with no steps executed. Fresh annotations on both exact heads explicitly state that jobs were not started because recent account payments failed or the spending limit needs to be increased. JavaScript and Python dependent jobs were skipped. This is unavailable hosted execution, not a package-test failure.

- Watch: https://github.com/21nCo/super-functions.next/actions/runs/40259978443/job/121370033752
- Shared: https://github.com/21nCo/super-functions.next/actions/runs/40259582461/job/121368831843

All four snapshots contain failed Vercel docs statuses. Their current detailed causes were not independently inspected in this pass. Flow60 and Ci65 snapshots contain no JavaScript/Python Actions verdict; absence is not success. No whole-goal hosted CI readiness claim follows from locally passing tests.

Raw metadata: /tmp/readiness-pr{55,58,60,65}-checks-20261026.json. Exact Plan annotations: /tmp/readiness-check-121370033752-annotations.json and /tmp/readiness-check-121368831843-annotations.json. The account billing/spending condition needs owner resolution before hosted Actions can execute; safe local implementation remains possible.
