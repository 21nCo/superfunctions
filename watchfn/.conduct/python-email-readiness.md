# Python durable SES email delivery

## Scope and prerequisite

The built-in sender uses the real SendFn AwsSesProvider and SendEmailRequest.
[Origin/dev PR256](https://github.com/21nCo/superfunctions/pull/256) owns the reusable
provider change; its scoped sf-next port is described in sendfn-email-prerequisite.md.
No custom sender callback replaces required SES delivery. No external email was sent.

Trusted host alerts.email configuration validates through SendFn EmailConfig and
AwsSesConfig, requires the operation-ownership capability, and is copied and excluded
from configuration dumps/repr. Current SendFn package version alone does not establish
the unreleased prerequisite. Local wheel acceptance installs the actual scoped port.
Recipient addresses remain sensitive stored routing until receipt/reconciliation;
public APIs expose only metadata. HTML escapes alert content; headers and recipients
are validated before provider use, recipients before durable claim.

## Delivery and lifecycle

Existing transactional namespace/CAS/lease outbox controls own email jobs. Missing
sender configuration leaves attempts and pending counts unchanged. Each job makes
one actual provider attempt, without SendFn service retries. SES success means API
acceptance, not inbox receipt. All other SES outcomes are conservatively unknown:
no automatic replay, pending count retained, explicit operator reconciliation required.

A timeout during send or close retains the owner operation until SDK work and client
close settle. Watch stop drains that operation before closing its storage event loop.
This is intentionally not a hard shutdown deadline: socket timeouts cannot bound DNS
or a trickling peer. Cleanup failure surfaces a sanitized incomplete-cleanup exception
and leaves the claim unsettled. A lease expired during drain cannot acknowledge even
a later successful response; the next scan parks it unknown. Hard termination requires
host process supervision, with the existing unknown-outcome reconciliation obligation.

Email lifecycle messages are independent; they do not claim PagerDuty's ordered
incident semantics. Hosts must stop older Python dispatch writers during rollout;
the python-v1 marker fences runtime protocols, not code versions.

## Acceptance

Owned loopback SES Query/XML server with actual boto3 and shared SQLite adapter:
- persisted enqueue before provider I/O, close/reopen, two independent workers;
- request fields and escaped HTML, metadata-only results and secret-free dumps;
- dropped response remains unknown across restart, no replay, explicit reconciliation;
- timeout during send and during client close retains operation and blocks stop;
- late completion after lease expiry cannot acknowledge delivery;
- missing sender and malformed recipients consume no claim/attempt;
- client cleanup failure is sanitized, explicit, and cannot decrement pending count.

The independent-worker fixture forces both fresh workers to observe no namespace
marker before they race its unique insertion. Only a typed DuplicateKeyError from
that insertion permits convergence: after rollback, a fresh transaction must read
an existing identical immutable protocol marker before executing the operation.
No generic adapter error is swallowed; missing/different/unreadable ownership fails
closed before claim. Separate failure fixtures cover absent-marker collision and
unexpected adapter failure; existing foreign-protocol fixtures remain required.

Validation:36 focused email/provider/service tests passed; normal Python CI built
WatchFn and passed all173 tests; the fresh six-wheel installed consumer passed all173
tests outside the checkout, asserting both WatchFn and SendFn site-packages imports.
Normal CI resolves the local SendFn development dependency; the email extra requires
SendFn's Python3.10+ runtime. No tests were skipped. Existing deprecation warnings
remain. The initial first-owner collision was reproduced, fixed and retained as a
forced concurrent-start regression, rather than removed from acceptance.

Owned loopback servers, SDK workers, clients and wheel environments were cleaned;
source venv removed after acceptance. No active runners remain. git diff --check
passed; no root metadata, lockfile or ignore-rule changes. Terminal receipt retention,
TS built-in email parity, hard process shutdown and remaining readiness stay open.
