# Schema-driven array items

SCHEMA-001 requires a widget for each declared ContentFn field type; REF-001 and MEDIA-001
also apply to those fields inside arrays. Previously every array item was rendered as a
text input, object edits replaced the object with a string, Add always appended an empty
string, and index keys could transfer control ownership after structural changes.

Array items now render their declared widgets, including references, assets, nested
objects and nested arrays. Add uses the selected union variant, Remove discards that
item, and Move changes ordering. Local item IDs remain stable through controlled edits
and reorder and are never persisted. An external replacement array or scope change
creates new ownership; stale media responses cannot assign to surviving/replacement
items. Media insertion resolves the selected item ID against current values and then
uses literal object-key segments, preserving siblings and unknown stored fields.
Reference control ownership includes stable item and literal field identity rather than
the changing display index.

For heterogeneous unions, only an unambiguous kind is inferred. Ambiguous existing values
remain unchanged until the user chooses a view and edits them; choosing a type alone
never rewrites data. New references/assets start unset and must be completed before the
producer accepts a save. maxLength is checked both when rendering Add and when adding;
existing values are never truncated. Required indicators and published read-only behavior
remain, and ContentFn performs authoritative validation/CAS when saving the whole array.

Complex object fields no longer wrap multiple controls in an HTML label. The reference
portal traps Tab/Shift-Tab at its keyboard boundaries and retains Escape/focus-return
behavior. No item IDs, union selectors or other editor metadata enter document content.

Validation on Node 20.20.0:

- Initial focused array/reference suite: 15 passed. The final suite includes seven array
  tests and ten reference-boundary tests, covering ordinary controlled echoes, sibling
  edits, reorder with open pickers, deletion/external replacement with late responses,
  ambiguous unions without coercion, maxLength, scalar types and nested/direct arrays.
- `npx turbo run typecheck test build --filter=@cmsfn/studio`: 29 successful tasks
  (26 cached); Studio 127 tests / 24 files, types and ESM/CJS declarations passed.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: normal npm 11
  installation of 32 packed packages, Chromium 143.0.7499.4 entire App and 247 HTTP
  interactions passed. Actual ContentFn saves verify object-array literal asset keys,
  canonical references, sibling preservation after reorder, picker removal with its
  item, direct reference and asset arrays, and no persisted editor IDs. Browser keyboard
  checks verify Tab/Shift-Tab containment, Escape and focus return. The existing full
  App acceptance matrix, strict installed TypeScript and ESM/CJS consumers also passed.
- Production-only installation audit: zero vulnerabilities. Browser tooling installation
  separately reported zero. Server/runtime source did not change; no new full server
  suite result is claimed for this slice.

Receipts: `/tmp/cms-array-{focused,types,validation,packed}.log` and
`/tmp/cms-array-production-audit.json`. The exact disposable installed consumer was removed
and read back absent after preserving receipts; all owned test/browser/HTTP processes
completed.
Native Safari, deployed host authentication/CORS and durable asset storage remain outside
this local installed Chromium/owned-server evidence. Array composition reuses existing
widgets; it does not claim to complete separate richtext authoring or other original
operational requirements.
