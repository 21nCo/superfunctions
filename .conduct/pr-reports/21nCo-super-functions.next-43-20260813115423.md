# PR Analysis Report: 21nCo/super-functions.next #43 - Comprehensive Review Issues

**Generated:** 2026-08-13T11:54:23Z
**PR Title:** SFN-20: build and harden the MDFN authoring platform
**PR URL:** https://github.com/21nCo/super-functions.next/pull/43
**Branch:** codex/mdfn-SFN-20 → next
**Files Changed:** 227 files (+14062 lines, -688 lines)

## Overview

This report covers all live GitHub review evidence fetched for PR #43: 44 inline review comments, 3 submitted reviews, and 5 conversation comments. The actionable findings are represented by Codex and Cubic. Three independently reported findings were deduplicated while retaining both evidence links.

Evidence limitations: Sourcery lacked private-repository access; CodeRabbit skipped the review because the PR exceeded its file limit and review capacity was unavailable; Qodo reviews were paused; Socket returned dependency rows with 85 cells marked Not analyzed or N/A and no actionable finding. The Vercel comment describes an account-plan deployment limitation, not a code finding. All three GitHub evidence surfaces loaded successfully.

## 🔴 Critical Issues (18 Total)

### MarkdownWidget.tsx - Editorial data integrity
**File:** `cmsfn/studio/src/editor/widgets/MarkdownWidget.tsx`

#### Issue 1: Preserve the content sidecar when creating the editor (Codex + Cubic)
- **Severity:** High
- **Description:** When an existing `MarkdownContent` contains comments, suggestions, assets, or other sidecar state, the controller is initialized with only its Markdown. The first document edit therefore calls `onChange` with `change.current.sidecar` undefined and silently deletes that persisted editorial metadata. Pass `content.sidecar` into `createMdfn` and reconcile external sidecar-only updates as well.
- **Location:** Line 37
- **Evidence:** [Codex 3774739355](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774739355), [Cubic 3774796844](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796844)
- **Fix:** sidecar` into `createMdfn` and reconcile external sidecar-only updates as well.

### types.ts - Extension semantics
**File:** `mdfn/core/src/types.ts`

#### Issue 2: A migration with `from >= to` can make `ResolvedExtensionRegistry.migrate` loop forever because the loop does not require the selected migration to advance the schema version (Cubic)
- **Severity:** High
- **Description:** A migration with `from >= to` can make `ResolvedExtensionRegistry.migrate` loop forever because the loop does not require the selected migration to advance the schema version. Enforce strictly increasing adjacent versions when registering migrations, and reject invalid declarations before they can be applied.
- **Location:** Line 11
- **Evidence:** [Cubic 3774796823](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796823)
- **Fix:** Enforce strictly increasing adjacent versions when registering migrations, and reject invalid declarations before they can be applied.

### index.ts - Editorial data integrity
**File:** `mdfn/collab/src/index.ts`

#### Issue 3: When `options.doc` contains comments, suggestions, or review state, this branch leaves the controller with its stale sidecar (Cubic)
- **Severity:** High
- **Description:** When `options.doc` contains comments, suggestions, or review state, this branch leaves the controller with its stale sidecar. A later local editorial edit serializes that stale state and can erase shared data; project the validated shared sidecar into the controller during initial synchronization.
- **Location:** Line 151
- **Evidence:** [Cubic 3774796832](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796832)
- **Fix:** A later local editorial edit serializes that stale state and can erase shared data; project the validated shared sidecar into the controller during initial synchronization.

### index.ts - Editorial data integrity
**File:** `mdfn/ai/src/index.ts`

#### Issue 4: When an AI payload supplies a non-string `replacement`, this check can pass it into a transaction or suggestion, producing incorrect source or invalid sidecar data (Cubic)
- **Severity:** High
- **Description:** When an AI payload supplies a non-string `replacement`, this check can pass it into a transaction or suggestion, producing incorrect source or invalid sidecar data. Reject non-string replacements before reading `.length`.
- **Location:** Line 18
- **Evidence:** [Cubic 3774796839](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796839)
- **Fix:** length`.

### index.ts - Lifecycle safety
**File:** `mdfn/dom/src/index.ts`

#### Issue 5: Calling `insertMarkdown` updates canonical Markdown but leaves the visual document and selection stale because the subscriber ignores its `visual:insert-markdown` change (Cubic)
- **Severity:** High
- **Description:** Calling `insertMarkdown` updates canonical Markdown but leaves the visual document and selection stale because the subscriber ignores its `visual:insert-markdown` change. Use a non-visual source (or update the ProseMirror view directly) so the insertion is rendered and subsequent edits cannot overwrite it.
- **Location:** Line 299
- **Evidence:** [Cubic 3774796851](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796851)
- **Fix:** Use a non-visual source (or update the ProseMirror view directly) so the insertion is rendered and subsequent edits cannot overwrite it.

### transaction.ts - Editorial data integrity
**File:** `mdfn/core/src/transaction.ts`

#### Issue 6: When a source edit moves comment or suggestion anchors, `applyTransaction` updates the local `sidecar` but reports `sidecarChanged: false` (Cubic)
- **Severity:** High
- **Description:** When a source edit moves comment or suggestion anchors, `applyTransaction` updates the local `sidecar` but reports `sidecarChanged: false`. Collaboration therefore does not publish the mapped anchors, and peers can overwrite their mapped state with stale shared anchors. Mark the mapped-sidecar identity change as a sidecar change, as the `replace-document` path already does.
- **Location:** Line 84
- **Evidence:** [Cubic 3774796855](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796855)
- **Fix:** Mark the mapped-sidecar identity change as a sidecar change, as the `replace-document` path already does.

### verify-mdfn-consumers.mjs - Release verification
**File:** `scripts/verify-mdfn-consumers.mjs`

#### Issue 7: From a clean checkout, this flag prevents `prepack` from generating `dist`, so every packed consumer import resolves to missing entrypoints and the advertised verification gate fails (Cubic)
- **Severity:** High
- **Description:** From a clean checkout, this flag prevents `prepack` from generating `dist`, so every packed consumer import resolves to missing entrypoints and the advertised verification gate fails. Remove `--ignore-scripts` or build every packed workspace before packing.
- **Location:** Line 50
- **Evidence:** [Cubic 3774796860](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796860)
- **Fix:** Remove `--ignore-scripts` or build every packed workspace before packing.

### extensions.ts - Extension semantics
**File:** `mdfn/core/src/extensions.ts`

#### Issue 8: When a document contains legacy nodes from two extensions, `ResolvedExtensionRegistry.migrate` transforms only the first extension's nodes and still reports the target version (Cubic)
- **Severity:** High
- **Description:** When a document contains legacy nodes from two extensions, `ResolvedExtensionRegistry.migrate` transforms only the first extension's nodes and still reports the target version. Apply every migration belonging to the selected adjacent transition before advancing `version`.
- **Location:** Lines 183-191
- **Evidence:** [Cubic 3774796866](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796866)
- **Fix:** Apply every migration belonging to the selected adjacent transition before advancing `version`.

### markdown.ts - Markdown fidelity
**File:** `docsfn/core/src/markdown.ts`

#### Issue 9: Every heading and paragraph block now retains an unmatched closing tag in `html`, producing malformed output and breaking the existing inline-HTML contract (Cubic)
- **Severity:** High
- **Description:** Every heading and paragraph block now retains an unmatched closing tag in `html`, producing malformed output and breaking the existing inline-HTML contract. Remove the renderer’s trailing whitespace before stripping the outer element.
- **Location:** Line 724
- **Evidence:** [Cubic 3774796894](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796894)
- **Fix:** Remove the renderer’s trailing whitespace before stripping the outer element.

### index.ts - Markdown fidelity
**File:** `mdfn/contentfn/src/index.ts`

#### Issue 10: When a supported rich-text block contains an unsupported or cyclic child, this recursion drops the child or overflows before `richBlocksToMarkdown` reports loss (Cubic)
- **Severity:** High
- **Description:** When a supported rich-text block contains an unsupported or cyclic child, this recursion drops the child or overflows before `richBlocksToMarkdown` reports loss. Traverse descendants with cycle/depth tracking and retain unsupported descendants as opaque migration comments with a loss diagnostic.
- **Location:** Line 79
- **Evidence:** [Cubic 3774796899](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796899)
- **Fix:** Traverse descendants with cycle/depth tracking and retain unsupported descendants as opaque migration comments with a loss diagnostic.

### index.ts - Markdown fidelity
**File:** `mdfn/collab/src/index.ts`

#### Issue 11: When an existing shared document legitimately contains empty Markdown, `source.length === 0` inserts the joining controller’s Markdown and overwrites the canonical empty source (Cubic)
- **Severity:** High
- **Description:** When an existing shared document legitimately contains empty Markdown, `source.length === 0` inserts the joining controller’s Markdown and overwrites the canonical empty source. Distinguish an uninitialized Y.Doc from an initialized empty document before bootstrapping local content.
- **Location:** Line 146
- **Evidence:** [Cubic 3774796905](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796905)
- **Fix:** Doc from an initialized empty document before bootstrapping local content.

### index.ts - Search identity
**File:** `mdfn/searchfn/src/index.ts`

#### Issue 12: When one document ID matches another document's generated chunk ID, a global search index can overwrite or deduplicate one record (Cubic)
- **Severity:** High
- **Description:** When one document ID matches another document's generated chunk ID, a global search index can overwrite or deduplicate one record. Namespace both record kinds with an unambiguous encoding, or reserve and reject the chunk-ID pattern for document IDs.
- **Location:** Line 19
- **Evidence:** [Cubic 3774796909](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796909)
- **Fix:** Namespace both record kinds with an unambiguous encoding, or reserve and reject the chunk-ID pattern for document IDs.

### controller.ts - Extension semantics
**File:** `mdfn/core/src/controller.ts`

#### Issue 13: When an extension command dispatches its transaction, `controller.can()` throws `MDFN_COMMAND_CAN_DISPATCH_FORBIDDEN` instead of returning availability (Cubic)
- **Severity:** High
- **Description:** When an extension command dispatches its transaction, `controller.can()` throws `MDFN_COMMAND_CAN_DISPATCH_FORBIDDEN` instead of returning availability. Make dispatch optional for capability checks or add a separate non-dispatching availability hook.
- **Location:** Line 101
- **Evidence:** [Cubic 3774796914](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796914)
- **Fix:** Make dispatch optional for capability checks or add a separate non-dispatching availability hook.

### index.ts - Extension semantics
**File:** `mdfn/markdown/src/index.ts`

#### Issue 14: When a fenced code block contains directive-like text, the scanner claims that text before the Markdown parser can establish fence context, so the document contains overlapping or duplicated projections (Cubic)
- **Severity:** High
- **Description:** When a fenced code block contains directive-like text, the scanner claims that text before the Markdown parser can establish fence context, so the document contains overlapping or duplicated projections. Track Markdown block context or restrict extension claims to positions that are not inside fenced or indented code.
- **Location:** Line 242
- **Evidence:** [Cubic 3774796916](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796916)
- **Fix:** Track Markdown block context or restrict extension claims to positions that are not inside fenced or indented code.

### sidecar.ts - Editorial data integrity
**File:** `mdfn/core/src/sidecar.ts`

#### Issue 15: The default `maxEntries` does not bound total sidecar entries, so a 10,000-by-10,000 comments/messages structure passes and can exhaust validation or storage resources (Cubic)
- **Severity:** High
- **Description:** The default `maxEntries` does not bound total sidecar entries, so a 10,000-by-10,000 comments/messages structure passes and can exhaust validation or storage resources. Count nested entries globally or enforce an explicit per-thread message limit before iterating.
- **Location:** Line 54
- **Evidence:** [Cubic 3774796919](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796919)
- **Fix:** Count nested entries globally or enforce an explicit per-thread message limit before iterating.

### schema.ts - Schema enforcement
**File:** `mdfn/dom/src/schema.ts`

#### Issue 16: When a user edits an aligned GFM table, this conversion discards `attrs.align`, causing the serializer and renderer to treat every column as unaligned (Cubic)
- **Severity:** High
- **Description:** When a user edits an aligned GFM table, this conversion discards `attrs.align`, causing the serializer and renderer to treat every column as unaligned. Add an alignment attribute to the ProseMirror table representation and carry it through both projection directions.
- **Location:** Line 161
- **Evidence:** [Cubic 3774796920](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796920)
- **Fix:** Add an alignment attribute to the ProseMirror table representation and carry it through both projection directions.

### schema.ts - Schema enforcement
**File:** `mdfn/dom/src/schema.ts`

#### Issue 17: After the first visual edit, the dirty node keeps its old `raw` span, so the next visual edit cannot use touched-region patching and may normalize unrelated source (Cubic)
- **Severity:** High
- **Description:** After the first visual edit, the dirty node keeps its old `raw` span, so the next visual edit cannot use touched-region patching and may normalize unrelated source. Omit `raw` for dirty spans, or refresh the span against the serialized source before storing the projected document.
- **Location:** Line 120
- **Evidence:** [Cubic 3774796926](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796926)
- **Fix:** Omit `raw` for dirty spans, or refresh the span against the serialized source before storing the projected document.

### store.ts - Lifecycle safety
**File:** `mdfn/svelte/src/store.ts`

#### Issue 18: After the last subscriber leaves, bridge.destroy() marks the bridge destroyed, so any later re-subscription throws (Cubic)
- **Severity:** High
- **Description:** After the last subscriber leaves, bridge.destroy() marks the bridge destroyed, so any later re-subscription throws. Svelte's readable() start runs on each 0->1 subscriber transition and the returned stop (which calls bridge.destroy()) on each 1->0 transition, so an SPA navigating away from the editor view and back, or a Svelte 5 `$store` access in a conditional block, resubscribes and hits bridge.subscribe()'s MDFN_ADAPTER_BRIDGE_DESTROYED assertion. Create the bridge inside the start function so each subscribe cycle gets a fresh, undisposed bridge.
- **Location:** Line 6
- **Evidence:** [Cubic 3774796928](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796928)
- **Fix:** Create the bridge inside the start function so each subscribe cycle gets a fresh, undisposed bridge.

## 🟡 Medium Severity Issues (23 Total)

### docs.ts - Extension semantics
**File:** `contentfn/server/src/storage/docs.ts`

#### Issue 19: Accept the canonical directive extension names (Codex)
- **Severity:** Medium
- **Description:** When a Markdown field uses the actual registered extension name `directive/callout` or `directive/diagram`, the Studio resolves it successfully, but this server map produces `undefined` and rejects every create or patch as an unknown extension. Add the canonical names here (or normalize aliases consistently) so content authored with the supported Studio configuration can be persisted.
- **Location:** Lines 169-170
- **Evidence:** [Codex 3774739360](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774739360)
- **Fix:** Add the canonical names here (or normalize aliases consistently) so content authored with the supported Studio configuration can be persisted.

### index.tsx - Lifecycle safety
**File:** `mdfn/react/src/index.tsx`

#### Issue 20: Register async editor cleanup before awaiting another import (Codex + Cubic)
- **Severity:** Medium
- **Description:** In split mode, if the effect is disposed after `createDomEditor` runs but before the source-editor import finishes—or if that later import rejects—`cleanup` is still the initial no-op because it is assigned only after all awaits. The already-mounted visual editor then retains its controller subscription and DOM listeners after the component rerenders or unmounts. Install each destroyer immediately, or have the effect cleanup always drain the current destroyer list.
- **Location:** Lines 75-76
- **Evidence:** [Codex 3774739365](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774739365), [Cubic 3774797033](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797033)
- **Fix:** Install each destroyer immediately, or have the effect cleanup always drain the current destroyer list.

### index.ts - Resource limits
**File:** `mdfn/render/src/index.ts`

#### Issue 21: Enforce the node limit for manually counted list items (Codex + Cubic)
- **Severity:** Medium
- **Description:** When `renderHtml` receives a programmatically constructed document containing many empty list items, this path increments `nodeCount` without checking `maxNodes`, and no child `renderNode` call occurs to perform the check. Such a document can therefore exceed the advertised render limit while still being fully traversed and emitted; apply the limit check whenever manually counting list items.
- **Location:** Lines 190-191
- **Evidence:** [Codex 3774739368](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774739368), [Cubic 3774796943](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796943)
- **Fix:** Such a document can therefore exceed the advertised render limit while still being fully traversed and emitted; apply the limit check whenever manually counting list items.

### index.ts - Extension semantics
**File:** `mdfn/registry/src/index.ts`

#### Issue 22: When `input.extensions` lists a dependent before its dependency, `createRegistry` rejects a valid extension set (Cubic)
- **Severity:** Medium
- **Description:** When `input.extensions` lists a dependent before its dependency, `createRegistry` rejects a valid extension set. Resolve the complete input first and register extensions in the resolver’s dependency order.
- **Location:** Line 33
- **Evidence:** [Cubic 3774796935](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796935)
- **Fix:** Resolve the complete input first and register extensions in the resolver’s dependency order.

### MarkdownWidget.tsx - Editorial data integrity
**File:** `cmsfn/studio/src/editor/widgets/MarkdownWidget.tsx`

#### Issue 23: When users add or edit comments, suggestions, or review state without changing Markdown, this condition suppresses `onChange` because only `documentChanged` is checked (Cubic)
- **Severity:** Medium
- **Description:** When users add or edit comments, suggestions, or review state without changing Markdown, this condition suppresses `onChange` because only `documentChanged` is checked. Notify the form for either document or sidecar changes.
- **Location:** Line 45
- **Evidence:** [Cubic 3774796938](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796938)
- **Fix:** Notify the form for either document or sidecar changes.

### index.ts - Extension semantics
**File:** `mdfn/markdown/src/index.ts`

#### Issue 24: When Markdown uses lone `\r` line endings, extension blocks are parsed as extending to EOF and content after the closing fence disappears from the projected document (Cubic)
- **Severity:** Medium
- **Description:** When Markdown uses lone `\r` line endings, extension blocks are parsed as extending to EOF and content after the closing fence disappears from the projected document. Split lines on `\r\n`, `\r`, or `\n` so extension parsers receive the correct line and close fence.
- **Location:** Line 237
- **Evidence:** [Cubic 3774796946](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796946)
- **Fix:** Split lines on `\r\n`, `\r`, or `\n` so extension parsers receive the correct line and close fence.

### index.ts - Extension semantics
**File:** `mdfn/testing/src/index.ts`

#### Issue 25: When `fixture.options.extensions` is a resolved registry, `certifyExtension` discards its existing extensions before appending the candidate, so certification loses dependencies such as `commonmark` (Cubic)
- **Severity:** Medium
- **Description:** When `fixture.options.extensions` is a resolved registry, `certifyExtension` discards its existing extensions before appending the candidate, so certification loses dependencies such as `commonmark`. Preserve `registry.extensions` when constructing the certification options.
- **Location:** Line 47
- **Evidence:** [Cubic 3774796951](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796951)
- **Fix:** extensions` when constructing the certification options.

### index.ts - Lifecycle safety
**File:** `mdfn/testing/src/index.ts`

#### Issue 26: When traces carry different cleanup states, `compareSemanticTraces` still returns `ok` because `comparable` excludes `cleanup` (Cubic)
- **Severity:** Medium
- **Description:** When traces carry different cleanup states, `compareSemanticTraces` still returns `ok` because `comparable` excludes `cleanup`. Include `cleanup` in the normalized value before comparing.
- **Location:** Line 201
- **Evidence:** [Cubic 3774796958](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796958)
- **Fix:** Include `cleanup` in the normalized value before comparing.

### index.ts - Editorial data integrity
**File:** `mdfn/contentfn/src/index.ts`

#### Issue 27: When a persisted envelope has a non-string `schemaHash` or malformed `sidecar`, this guard still accepts it and ContentFn persists the invalid value (Cubic)
- **Severity:** Medium
- **Description:** When a persisted envelope has a non-string `schemaHash` or malformed `sidecar`, this guard still accepts it and ContentFn persists the invalid value. Validate optional fields, including `sidecar` with `validateMdfnSidecar`, before returning true.
- **Location:** Line 49
- **Evidence:** [Cubic 3774796966](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796966)
- **Fix:** Validate optional fields, including `sidecar` with `validateMdfnSidecar`, before returning true.

### index.ts - Adapter parity
**File:** `mdfn/source/src/index.ts`

#### Issue 28: When the controller already has a text selection, mounting the source editor resets CodeMirror to offset 0 (Cubic)
- **Severity:** Medium
- **Description:** When the controller already has a text selection, mounting the source editor resets CodeMirror to offset 0. The first source edit then publishes that incorrect selection back to the controller; initialize CodeMirror’s selection from the controller state when creating the view.
- **Location:** Line 110
- **Evidence:** [Cubic 3774796972](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796972)
- **Fix:** The first source edit then publishes that incorrect selection back to the controller; initialize CodeMirror’s selection from the controller state when creating the view.

### index.ts - Asset handling
**File:** `mdfn/filefn/src/index.ts`

#### Issue 29: When FileFn returns a pending-local placeholder, this condition marks it as embeddable even though its source has no URL, causing `resolvedAssetRenderNode` to throw `MDFN_ASSET_DELIVERY_URL_MISSING` (Cubic)
- **Severity:** Medium
- **Description:** When FileFn returns a pending-local placeholder, this condition marks it as embeddable even though its source has no URL, causing `resolvedAssetRenderNode` to throw `MDFN_ASSET_DELIVERY_URL_MISSING`. Treat placeholder sources as `embed: "placeholder"` and render them through the placeholder branch.
- **Location:** Line 82
- **Evidence:** [Cubic 3774796978](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796978)
- **Fix:** Treat placeholder sources as `embed: "placeholder"` and render them through the placeholder branch.

### index.ts - Asset handling
**File:** `mdfn/filefn/src/index.ts`

#### Issue 30: When a FileFn offline upload resolves to a local preview, this check rejects its `blob:` object URL as `MDFN_ASSET_URL_FORBIDDEN`, so pending-local media cannot render (Cubic)
- **Severity:** Medium
- **Description:** When a FileFn offline upload resolves to a local preview, this check rejects its `blob:` object URL as `MDFN_ASSET_URL_FORBIDDEN`, so pending-local media cannot render. Permit `blob` only for `pending-local` object URLs, while retaining the strict network allowlist for durable delivery URLs.
- **Location:** Line 62
- **Evidence:** [Cubic 3774796995](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774796995)
- **Fix:** Permit `blob` only for `pending-local` object URLs, while retaining the strict network allowlist for durable delivery URLs.

### index.ts - Editorial data integrity
**File:** `mdfn/collab/src/index.ts`

#### Issue 31: Remote source and sidecar changes enter the local controller history, so undo can reverse a collaborator’s update and send that inverse as a local Yjs update (Cubic)
- **Severity:** Medium
- **Description:** Remote source and sidecar changes enter the local controller history, so undo can reverse a collaborator’s update and send that inverse as a local Yjs update. Apply remote state through a history-excluded controller path.
- **Location:** Line 182
- **Evidence:** [Cubic 3774797002](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797002)
- **Fix:** Apply remote state through a history-excluded controller path.

### index.ts - Editorial data integrity
**File:** `mdfn/collab/src/index.ts`

#### Issue 32: When a supplied Y.Doc already contains malformed `sidecar.value`, this branch checks only `.has`, so session creation trusts invalid sidecar data and can emit it in the initial snapshot (Cubic)
- **Severity:** Medium
- **Description:** When a supplied Y.Doc already contains malformed `sidecar.value`, this branch checks only `.has`, so session creation trusts invalid sidecar data and can emit it in the initial snapshot. Validate the supplied document before synchronizing or sending it.
- **Location:** Line 151
- **Evidence:** [Cubic 3774797007](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797007)
- **Fix:** Validate the supplied document before synchronizing or sending it.

### main.tsx - Lifecycle safety
**File:** `mdfn/examples/react/src/main.tsx`

#### Issue 33: When the page enters the back-forward cache, this listener destroys the controller even though the React tree is retained (Cubic)
- **Severity:** Medium
- **Description:** When the page enters the back-forward cache, this listener destroys the controller even though the React tree is retained. Returning via Back then restores an editor whose edits and subscriptions fail; destroy only on a non-persisted `pagehide` or reinitialize on `pageshow`.
- **Location:** Line 10
- **Evidence:** [Cubic 3774797012](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797012)
- **Fix:** Returning via Back then restores an editor whose edits and subscriptions fail; destroy only on a non-persisted `pagehide` or reinitialize on `pageshow`.

### types.ts - Extension semantics
**File:** `contentfn/core/src/schema/types.ts`

#### Issue 34: When a schema names any Markdown extension other than `callout` or `diagram`, schema upsert succeeds but every document write using that field fails with `unknown markdown extension` (Cubic)
- **Severity:** Medium
- **Description:** When a schema names any Markdown extension other than `callout` or `diagram`, schema upsert succeeds but every document write using that field fails with `unknown markdown extension`. Add a server extension registry/configuration path, or reject unsupported names during schema validation instead of exposing an unrestricted `string[]` contract.
- **Location:** Line 33
- **Evidence:** [Cubic 3774797015](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797015)
- **Fix:** Add a server extension registry/configuration path, or reject unsupported names during schema validation instead of exposing an unrestricted `string[]` contract.

### index.tsx - Lifecycle safety
**File:** `mdfn/solid/src/index.tsx`

#### Issue 35: When a mount is cancelled or a later surface fails after an earlier surface was created, this catch reports a stale error and leaves the earlier editor subscribed to a removed node (Cubic)
- **Severity:** Medium
- **Description:** When a mount is cancelled or a later surface fails after an earlier surface was created, this catch reports a stale error and leaves the earlier editor subscribed to a removed node. Ignore cancelled failures and destroy `visual` and `source` before entering the fallback.
- **Location:** Line 95
- **Evidence:** [Cubic 3774797019](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797019)
- **Fix:** Ignore cancelled failures and destroy `visual` and `source` before entering the fallback.

### index.tsx - Functional correctness
**File:** `mdfn/solid/src/index.tsx`

#### Issue 36: After any load or preview error, changing the controller, mode, or document cannot restore the editor because `loadError` is never cleared and the fallback removes all editor targets (Cubic)
- **Severity:** Medium
- **Description:** After any load or preview error, changing the controller, mode, or document cannot restore the editor because `loadError` is never cleared and the fallback removes all editor targets. Reset the error and retry when scheduling a new mount, or provide an explicit retry path.
- **Location:** Line 126
- **Evidence:** [Cubic 3774797022](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797022)
- **Fix:** Reset the error and retry when scheduling a new mount, or provide an explicit retry path.

### index.tsx - Functional correctness
**File:** `mdfn/react/src/index.tsx`

#### Issue 37: When an old editor or preview load rejects after its effect has been superseded, this catch still commits `loadError` and calls the stale `onLoadError`, so a newer mode or controller can be replaced by the fallback (Cubic)
- **Severity:** Medium
- **Description:** When an old editor or preview load rejects after its effect has been superseded, this catch still commits `loadError` and calls the stale `onLoadError`, so a newer mode or controller can be replaced by the fallback. Ignore cancelled requests in both catch blocks before updating state or invoking the callback.
- **Location:** Line 93
- **Evidence:** [Cubic 3774797029](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797029)
- **Fix:** Ignore cancelled requests in both catch blocks before updating state or invoking the callback.

### index.ts - Adapter parity
**File:** `mdfn/testing/src/index.ts`

#### Issue 38: When adapters differ in selection or diagnostics at an intermediate state, `traceState` drops those fields and the comparison reports equality if final values converge (Cubic)
- **Severity:** Medium
- **Description:** When adapters differ in selection or diagnostics at an intermediate state, `traceState` drops those fields and the comparison reports equality if final values converge. Include selection and diagnostic codes in every step.
- **Location:** Line 190
- **Evidence:** [Cubic 3774797040](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797040)
- **Fix:** Include selection and diagnostic codes in every step.

### docs.ts - Schema enforcement
**File:** `contentfn/server/src/storage/docs.ts`

#### Issue 39: When a Markdown field has a schema profile such as `allowRawHtml: false`, a caller can supply a structurally valid envelope with a different profile and bypass that field policy (Cubic)
- **Severity:** Medium
- **Description:** When a Markdown field has a schema profile such as `allowRawHtml: false`, a caller can supply a structurally valid envelope with a different profile and bypass that field policy. Compare the envelope profile with `markdownProfile(field.type)` or rewrap/reject mismatches before `validateFieldType`.
- **Location:** Line 89
- **Evidence:** [Cubic 3774797053](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797053)
- **Fix:** type)` or rewrap/reject mismatches before `validateFieldType`.

### index.tsx - Markdown fidelity
**File:** `mdfn/components-react/src/index.tsx`

#### Issue 40: When the shell is in `source` or `preview` mode, selecting a file discards the returned Markdown because `insertMarkdown` only targets the visual surface (Cubic)
- **Severity:** Medium
- **Description:** When the shell is in `source` or `preview` mode, selecting a file discards the returned Markdown because `insertMarkdown` only targets the visual surface. Insert through the controller/source surface or disable this control when no visual surface is mounted.
- **Location:** Line 165
- **Evidence:** [Cubic 3774797056](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797056)
- **Fix:** Insert through the controller/source surface or disable this control when no visual surface is mounted.

### schema.ts - Schema enforcement
**File:** `mdfn/dom/src/schema.ts`

#### Issue 41: Editing a loose Markdown list through the visual adapter loses its list-level `spread` metadata and changes the rendered paragraph semantics (Cubic)
- **Severity:** Medium
- **Description:** Editing a loose Markdown list through the visual adapter loses its list-level `spread` metadata and changes the rendered paragraph semantics. Preserve `spread` on the ProseMirror list node and restore it when converting back.
- **Location:** Line 159
- **Evidence:** [Cubic 3774797062](https://github.com/21nCo/super-functions.next/pull/43#discussion_r3774797062)
- **Fix:** Preserve `spread` on the ProseMirror list node and restore it when converting back.

## 🟢 Low Severity Issues (0 Total)

None.

## Issues by Tool

| Tool | Critical | Medium | Low | Total |
|---|---:|---:|---:|---:|
| Codex | 0 | 1 | 0 | 1 |
| Codex + Cubic | 1 | 2 | 0 | 3 |
| Cubic | 17 | 20 | 0 | 37 |
| **Total** | **18** | **23** | **0** | **41** |

The combined-tool row contains findings independently reported by both tools and counts each underlying issue once.

## Priority Action Items

### Immediate Fixes Required (Critical)

1. Issue 1: Preserve the content sidecar when creating the editor — `cmsfn/studio/src/editor/widgets/MarkdownWidget.tsx`
2. Issue 2: A migration with `from >= to` can make `ResolvedExtensionRegistry.migrate` loop forever because the loop does not require the selected migration to advance the schema version — `mdfn/core/src/types.ts`
3. Issue 3: When `options.doc` contains comments, suggestions, or review state, this branch leaves the controller with its stale sidecar — `mdfn/collab/src/index.ts`
4. Issue 4: When an AI payload supplies a non-string `replacement`, this check can pass it into a transaction or suggestion, producing incorrect source or invalid sidecar data — `mdfn/ai/src/index.ts`
5. Issue 5: Calling `insertMarkdown` updates canonical Markdown but leaves the visual document and selection stale because the subscriber ignores its `visual:insert-markdown` change — `mdfn/dom/src/index.ts`
6. Issue 6: When a source edit moves comment or suggestion anchors, `applyTransaction` updates the local `sidecar` but reports `sidecarChanged: false` — `mdfn/core/src/transaction.ts`
7. Issue 7: From a clean checkout, this flag prevents `prepack` from generating `dist`, so every packed consumer import resolves to missing entrypoints and the advertised verification gate fails — `scripts/verify-mdfn-consumers.mjs`
8. Issue 8: When a document contains legacy nodes from two extensions, `ResolvedExtensionRegistry.migrate` transforms only the first extension's nodes and still reports the target version — `mdfn/core/src/extensions.ts`
9. Issue 9: Every heading and paragraph block now retains an unmatched closing tag in `html`, producing malformed output and breaking the existing inline-HTML contract — `docsfn/core/src/markdown.ts`
10. Issue 10: When a supported rich-text block contains an unsupported or cyclic child, this recursion drops the child or overflows before `richBlocksToMarkdown` reports loss — `mdfn/contentfn/src/index.ts`
11. Issue 11: When an existing shared document legitimately contains empty Markdown, `source.length === 0` inserts the joining controller’s Markdown and overwrites the canonical empty source — `mdfn/collab/src/index.ts`
12. Issue 12: When one document ID matches another document's generated chunk ID, a global search index can overwrite or deduplicate one record — `mdfn/searchfn/src/index.ts`
13. Issue 13: When an extension command dispatches its transaction, `controller.can()` throws `MDFN_COMMAND_CAN_DISPATCH_FORBIDDEN` instead of returning availability — `mdfn/core/src/controller.ts`
14. Issue 14: When a fenced code block contains directive-like text, the scanner claims that text before the Markdown parser can establish fence context, so the document contains overlapping or duplicated projections — `mdfn/markdown/src/index.ts`
15. Issue 15: The default `maxEntries` does not bound total sidecar entries, so a 10,000-by-10,000 comments/messages structure passes and can exhaust validation or storage resources — `mdfn/core/src/sidecar.ts`
16. Issue 16: When a user edits an aligned GFM table, this conversion discards `attrs.align`, causing the serializer and renderer to treat every column as unaligned — `mdfn/dom/src/schema.ts`
17. Issue 17: After the first visual edit, the dirty node keeps its old `raw` span, so the next visual edit cannot use touched-region patching and may normalize unrelated source — `mdfn/dom/src/schema.ts`
18. Issue 18: After the last subscriber leaves, bridge.destroy() marks the bridge destroyed, so any later re-subscription throws — `mdfn/svelte/src/store.ts`

### Important Improvements (Medium Priority)

19. Issue 19: Accept the canonical directive extension names — `contentfn/server/src/storage/docs.ts`
20. Issue 20: Register async editor cleanup before awaiting another import — `mdfn/react/src/index.tsx`
21. Issue 21: Enforce the node limit for manually counted list items — `mdfn/render/src/index.ts`
22. Issue 22: When `input.extensions` lists a dependent before its dependency, `createRegistry` rejects a valid extension set — `mdfn/registry/src/index.ts`
23. Issue 23: When users add or edit comments, suggestions, or review state without changing Markdown, this condition suppresses `onChange` because only `documentChanged` is checked — `cmsfn/studio/src/editor/widgets/MarkdownWidget.tsx`
24. Issue 24: When Markdown uses lone `\r` line endings, extension blocks are parsed as extending to EOF and content after the closing fence disappears from the projected document — `mdfn/markdown/src/index.ts`
25. Issue 25: When `fixture.options.extensions` is a resolved registry, `certifyExtension` discards its existing extensions before appending the candidate, so certification loses dependencies such as `commonmark` — `mdfn/testing/src/index.ts`
26. Issue 26: When traces carry different cleanup states, `compareSemanticTraces` still returns `ok` because `comparable` excludes `cleanup` — `mdfn/testing/src/index.ts`
27. Issue 27: When a persisted envelope has a non-string `schemaHash` or malformed `sidecar`, this guard still accepts it and ContentFn persists the invalid value — `mdfn/contentfn/src/index.ts`
28. Issue 28: When the controller already has a text selection, mounting the source editor resets CodeMirror to offset 0 — `mdfn/source/src/index.ts`
29. Issue 29: When FileFn returns a pending-local placeholder, this condition marks it as embeddable even though its source has no URL, causing `resolvedAssetRenderNode` to throw `MDFN_ASSET_DELIVERY_URL_MISSING` — `mdfn/filefn/src/index.ts`
30. Issue 30: When a FileFn offline upload resolves to a local preview, this check rejects its `blob:` object URL as `MDFN_ASSET_URL_FORBIDDEN`, so pending-local media cannot render — `mdfn/filefn/src/index.ts`
31. Issue 31: Remote source and sidecar changes enter the local controller history, so undo can reverse a collaborator’s update and send that inverse as a local Yjs update — `mdfn/collab/src/index.ts`
32. Issue 32: When a supplied Y.Doc already contains malformed `sidecar.value`, this branch checks only `.has`, so session creation trusts invalid sidecar data and can emit it in the initial snapshot — `mdfn/collab/src/index.ts`
33. Issue 33: When the page enters the back-forward cache, this listener destroys the controller even though the React tree is retained — `mdfn/examples/react/src/main.tsx`
34. Issue 34: When a schema names any Markdown extension other than `callout` or `diagram`, schema upsert succeeds but every document write using that field fails with `unknown markdown extension` — `contentfn/core/src/schema/types.ts`
35. Issue 35: When a mount is cancelled or a later surface fails after an earlier surface was created, this catch reports a stale error and leaves the earlier editor subscribed to a removed node — `mdfn/solid/src/index.tsx`
36. Issue 36: After any load or preview error, changing the controller, mode, or document cannot restore the editor because `loadError` is never cleared and the fallback removes all editor targets — `mdfn/solid/src/index.tsx`
37. Issue 37: When an old editor or preview load rejects after its effect has been superseded, this catch still commits `loadError` and calls the stale `onLoadError`, so a newer mode or controller can be replaced by the fallback — `mdfn/react/src/index.tsx`
38. Issue 38: When adapters differ in selection or diagnostics at an intermediate state, `traceState` drops those fields and the comparison reports equality if final values converge — `mdfn/testing/src/index.ts`
39. Issue 39: When a Markdown field has a schema profile such as `allowRawHtml: false`, a caller can supply a structurally valid envelope with a different profile and bypass that field policy — `contentfn/server/src/storage/docs.ts`
40. Issue 40: When the shell is in `source` or `preview` mode, selecting a file discards the returned Markdown because `insertMarkdown` only targets the visual surface — `mdfn/components-react/src/index.tsx`
41. Issue 41: Editing a loose Markdown list through the visual adapter loses its list-level `spread` metadata and changes the rendered paragraph semantics — `mdfn/dom/src/schema.ts`

### Code Quality (Low Priority)

None

## Testing Recommendations

Add a focused regression for every finding at the referenced package level. Re-run the affected package tests and type checks, then the full MDFN verifier. The cross-framework surfaces additionally require the existing React, Svelte, and Solid consumer/SSR checks and browser workflow. ContentFn and CmsFn changes require their package suites. Clean-checkout packaging must be validated without relying on pre-existing build output.

## Summary

The evidence contains 41 unique actionable findings after deduplication: 18 critical/high, 23 medium, and 0 low. The main concerns are editorial-state preservation, collaboration convergence, Markdown/source fidelity, lifecycle cleanup, resource limits, and schema/package boundary enforcement. Remediation should proceed from this exact report, with every issue assigned exactly one final status.
