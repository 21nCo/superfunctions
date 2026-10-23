# Explicit survey opening

The original SDK contract includes `openSurvey(id)`. The browser SDK now exposes
`openSurvey(surveyId): Promise<boolean>` and routes it through the same renderer,
receipt validation, identity/consent fences, response caps and optional durable
journal as automatic triggers. Explicit selection skips automatic trigger matching
and campaign dispatch, while retaining enabled state, audience and schedule checks.
Unknown/ineligible IDs or unavailable identity/renderer return false. Invalid IDs
throw. True means presented, not saved; local and service acknowledgement labels
remain distinct. Journal recovery retains its previously documented immutable
pending-response exception to local eligibility, with service policy authoritative.

Validation:268 SDK tests, strict types and build pass. A fresh two-tarball SDK
consumer passes ESM/CJS construction and strict declarations including the new
Promise<boolean> method. Actual installed SDK in isolated Chrome154.0.8037.58
opens the explicitly selected survey with no automatic triggers, does not show an
eligible unrelated campaign, submits through real HTTP to SQLite, and refuses to
reopen after its acknowledged cap. Seven responses persist across the complete
fixture; prior reload, cross-tab, consent, branching, feedback and keyboard cases
remain enabled and pass. Unit cases cover missing renderer/identity, disabled,
expired, missing audience, zero cap, revoked consent and malformed IDs.

The initial browser assertion expected the survey title in visible question text;
the renderer intentionally places the question title there and the survey title
in the accessible dialog name. The corrected assertion checks that actual name.
No renderer behavior or eligibility was loosened to satisfy the fixture.

Logs: /tmp/user-open-survey-{tests,types,build,package}.log. The package fixture
removes its temporary install; the browser fixture closes its isolated context,
HTTP listener and SQLite adapter and deletes the temporary directory. No user
browser profile, external provider or deployment is involved. Inline rendering,
survey authoring/analytics and the wider original product requirements remain open.
Python has no browser renderer and is unchanged by this browser API addition.
