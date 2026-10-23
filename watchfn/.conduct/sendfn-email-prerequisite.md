# SendFn SES prerequisite provenance

Scoped port of [origin/dev PR256](https://github.com/21nCo/superfunctions/pull/256),
commit15a181c787d4506115a40d87b12d2d3f2563b627. The reusable change remains
separately proposed to origin/dev; this branch needs its SES operation ownership
for durable Watch email dispatch. Includes the existing origin attachment decoder
required by that provider and correct superfunctions-core/cryptography dependencies.
Unrelated origin APNS, suppression, database and service changes are not imported.

The provider owns shielded SDK work, retries settled client initialization, drains
before client close, and preserves close errors. Socket bounds and one SDK attempt
do not provide a hard total deadline. No external provider requests are permitted
in acceptance. The port passed17 actual local SES lifecycle tests plus6 existing
email service tests in the combined36-test Watch email acceptance, and was built
and installed as one of six fresh wheels for173 passing Watch tests. The full newer
origin SendFn service suite is not claimed for this intentionally scoped older port.
