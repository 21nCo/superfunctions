# Python survey eligibility and acknowledged local caps

2026-10-23. Replaces the missing Python SurveyEngine with identified-user event/URL substring eligibility, existing segment evaluation and per-user local response counts. UTF-16 matching follows the TypeScript substring contract. Omitted Python optional caps default to one, integral values follow JavaScript safe-integer bounds, and zero/malformed caps deny. None represents omission in the Python dataclass; TypeScript explicit null remains invalid. Client candidate lookup honors messaging consent and DNT.

Acknowledged explicit HTTP submission records the original local identity, even after an identity switch while awaiting transport. Repeated receipts count once; unknown outcomes do not increment counts. Explicit submissions retain their existing user-initiated consent semantics. Counts survive set_surveys but remain process memory. Local candidates never authorize service access or reserve durable display capacity.

Validation on Python3.9.6: normal repository CI (build, mypy and217tests), fresh wheel/sdist build, and isolated noneditable wheel16 eligibility tests pass. Actual Node20 HTTP/native SQLite service fixture verifies lost receipt/replay counts once, second unique receipt exhausts local cap, another local identity remains eligible but server authorization still denies over-cap submission. Existing transactional race/rollback/reopen cases pass. Logs /tmp/user-survey-eligibility-{ci,tests,build,wheel-tests,native}.log.

Remaining: persistent submission/response journal, durable display admission, full survey scheduling/branching, Python rendering and automatic analytics. No deployment or release is implied.
