# Conditional survey forms and CES/custom scales

2026-10-23. Original survey requirements include CES/custom scales and basic
previous-answer branching. Question.when now describes forward-only primitive
exact equality against an earlier question. Shared SDK helpers validate references
and drive both browser visibility and service answer admission. Hidden required
questions do not block submission; injected hidden answers do. Missing prerequisite
answers hide dependents. Unknown/forward/self references, duplicate IDs and invalid
condition values reject. No expression execution or cycles are supported.

CES defaults1–7, generic scale1–5; explicit integer bounds override defaults. Service
scale policy now enforces the renderer's existing maximum span100, so larger
previously accepted service-only scales require migration. Python dataclasses carry
the same question/condition metadata; Python does not gain a browser renderer.

Validation:238 SDK tests, strict SDK types/dual builds and service build pass.
Native Chrome154 runs the actual built SDK and HTTP service against native SQLite.
It traverses both boolean branches, skips the other required question, persists
only visible answers, uses CES7 and custom-2, rejects injected hidden answers,
missing active required answers and out-of-range scales, and retains prior
lost-ack/retry/identity/keyboard/feedback checks. Four survey responses persist.
Logs /tmp/user-survey-branches-{tests,types,build,service-build,native}.log.

Python3.9 normal CI passes217 tests, mypy and build; normal service plus native
survey regression passes11 tests. Owned browser/server/SQLite fixtures clean up. This is
basic branching acceptance, not full survey platform readiness. Durable journals,
display admission, analytics, authoring/publication and broader engines remain open.
