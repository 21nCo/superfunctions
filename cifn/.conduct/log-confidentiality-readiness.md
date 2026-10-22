# Log confidentiality prerequisite — 2026-10-22

RUNNER-005 durable remote logs remain unfinished. Before adding persistence, this
change fixes three demonstrated defects in the existing runner log path:

- A multiline configured secret was compared only as a whole against individual
  output lines, leaving its components visible. Whole values and each nonempty
  CR/LF-delimited component are now masked. This deliberately also masks a component
  when it appears alone; hosts should expect conservative redaction.
- Shorter secrets could replace a prefix before a longer secret was considered,
  leaking the longer value's suffix. Matching now prefers longest literal values
  and operates once on original text. Replacement markers are never reprocessed.
- Owned subprocess output decoded each chunk independently, corrupting UTF-8
  characters split across chunks and preventing reliable literal matching. Separate
  incremental stdout/stderr decoders now preserve those bytes across boundaries.

Two redaction regressions failed before the fix; a real owned shell emitting a
UTF-8 character in delayed byte fragments also failed before the decoder change.
All88 runner tests now pass, along with package types, strict remote types and
CJS/ESM/declaration builds. Existing output bounds and process ownership/cancellation
behavior are retained. Fixtures are cleaned by their existing ownership paths.

This is exact literal masking, not a general data-loss prevention guarantee:
encoded/transformed secrets, arbitrary partial values, truncated output prefixes
and future streaming chunks need separate policies. Current runner logging receives
complete line batches; a future streaming transport must retain sufficient secret
boundary context before publishing. Durable authenticated log batches, encrypted
storage/spool, retention, replay and separate transfer status remain open. No remote
log-persistence or production-readiness claim is made by this checkpoint.

## Authenticated read boundary

The control-plane log API contained a second copy of the old redactor. An
HTTP-handler regression reproduced multiline component leakage there even when
the runner implementation was corrected. Both sides now use the same exported
control-plane helper; the runner's existing public export remains compatible.
Authenticated reads mask returned text without mutating the adapter's entries.
All187 control-plane cases, source and strict durable types, and dual builds pass.
The runner suite also exercises the shared helper through the built dependency.
