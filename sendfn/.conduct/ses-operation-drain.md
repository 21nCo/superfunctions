# Python SES operation ownership

Based on origin/dev9205cbd3a. SendFn exists on both repositories, but origin/dev
already has corrected Python package dependencies, attachment handling and
nonblocking sends absent from the older sf-next copy. This reusable prerequisite
belongs in 21nCo/superfunctions targeting dev, separately from Watch's next-only
integration. GitHub account verified as thyaravind. No publication is performed
by this checkpoint.

## Behavior

AwsSesProvider snapshots validated configuration and email input, creates one
tracked SDK client and owns all initialization/send/health worker tasks. A caller
cancellation cannot cancel those tasks or discard their ownership. `close()` stops
new admission, drains admitted work and closes the real SDK client. Cancelling a
close await leaves a retained close task; awaiting close again observes completion.
A fully settled client-construction failure permits a later initialization retry;
concurrent callers still share one attempt. Caller cancellation retains the original
construction task. Closing prevents all new attempts. Detached close errors are
consumed without logging and remain observable by every later close await.
Instances remain on their owning event loop and cannot reopen after close.

Botocore receives explicit connect/read socket bounds (default5/10seconds,
configurable greater than zero through120seconds) and total_max_attempts=1. Higher
SendFn retry/backoff behavior and provider error classification remain unchanged;
there is no extra hidden SDK retry multiplication. A validated trusted endpointUrl
supports regional gateways and local protocol acceptance without disabling TLS
verification. No external credentials or provider service was used in validation.

Cancellation is an unknown external outcome, not evidence that an email was not
sent. Consumers such as Watch must not replay automatically after timeout and must
retain the owner loop/client until provider work settles. Socket timeouts are not
a hard total deadline: DNS or a peer trickling bytes can extend work/drain. If close
does not settle or fails, cleanup remains incomplete and must be reported. This
checkpoint does not claim complete Watch shutdown readiness or process isolation.

## Evidence

Owned loopback SES Query HTTP with the actual boto3 client verifies request shape,
response parsing, explicit one-attempt socket settings, real health requests,
read timeout/lost-response without SDK replay, cancelled caller ownership, cancelled
close still draining, refusal of new sends during close, and cancelled client
initialization eventually closing its SDK client. Malformed endpoints/timeouts
reject before client creation.

- Focused native lifecycle suite:17passed, including failed-once concurrent
  initialization recovery, close during failed initialization, and a cancelled
  close caller whose retained close failure remains observable.
- Normal Python CI:87passed; source archive/wheel, Ruff and mypy passed.
- Fresh five-wheel installed consumer:87passed, imports verified from site-packages.
  The fixture installs SendFn's actual email/push/framework extras and all shared
  wheels, then runs the complete copied Python suite outside the checkout.
- Normal CI lint/mypy:pass,34sourcefiles.
- Owned servers, SDK clients, worker tasks and temporary installed environments
  closed/removed. Source venv removed after validation; no active runners remain.
- git diff --check passed. Evidence tracked under .conduct; no ignore/dependency/
  package-version changes.

Reproduce from repository root with the normal Python CI entrypoint and
`python sendfn/python/scripts/verify-ses-wheel.py`. The fixture cleans its temporary
wheel consumer in a finally-managed temporary directory.

Remaining work: separately port the scoped provider prerequisite and already-fixed
package dependency contract into sf-next, then wire durable Watch email delivery.
No callback placeholder, live email, deployment or release is included here.

Contract references: [Botocore socket/retry configuration](https://docs.aws.amazon.com/botocore/latest/reference/config.html)
and [asyncio task shielding](https://docs.python.org/3/library/asyncio-task.html#asyncio.shield).
