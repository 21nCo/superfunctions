# Database aggregate deletion

BOT-007 requires deleting associated bot data. Previously `createDbStore` issued
independent dependent-row deletes followed by the bot delete. A real SQLite
trigger rejecting the final delete reproduced the defect: the bot survived but
all six dependent table populations were gone.

The database store now performs the lookup and all seven model deletions through
one shared-adapter transaction. Unsupported transaction capability fails before
any deletion. The native acceptance injects the same final-delete failure,
compares every table with its pre-operation snapshot, closes/reopens the database
and compares again. It also verifies unsupported-adapter refusal, successful
deletion, missing/cross-namespace returns and another namespace's preservation.

Validation: all 214 server tests across 39 files and the server TypeScript build
pass. The new rollback assertions fail on the previous implementation and pass
on the changed code. No schema or shared-package changes were needed.

This proves transactional database rollback on the actual SQLite adapter, not
other providers' isolation, crash-during-commit recovery or distributed writer
fencing. External recording objects and search-index cleanup are not part of the
database transaction and remain unresolved BOT-007 requirements. Background
producers must be quiesced; this change does not establish a deletion tombstone
or prevent a separate producer from inserting rows after commit. RecFn remains
incomplete against its original specification.
