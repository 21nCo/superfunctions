# Test vectors

Every vector is normative. Implementations MAY split a vector into smaller test cases, but MUST preserve its setup, operation, expected semantic output/error, and evidence. A vector passes only against packed public artifacts and copied-source artifacts where the requirement applies.

## Common harness contract

Each automated result MUST record `vectorId`, requirement, primitive/framework/package/source mode, seed, source commit, dirty-state marker, exact artifact hashes, runtime/browser/OS versions, start/end time, outcome, stable error code on failure, and pointers to sanitized trace/artifacts. Required human vectors add tester/reviewer identity and signature. “Skipped,” “not run,” “blocked,” missing, stale, or schema-invalid results are failures.

The default positive corpus uses two independent clean consumer fixtures per framework, deterministic IDs/clocks/randomness/timezone, both packaged and copied-source installs, SSR plus hydration where applicable, and public entrypoints only. The default negative corpus injects one controlled defect and MUST prove that the intended gate—not an unrelated crash—detects it.

## Scope and governance vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-SCOPE-001-P` | Load the declared stable/private/experimental workspace graph, pack all stable packages, and resolve a clean React-, Svelte-, and Solid-only consumer. | Graph is acyclic; every edge is allowlisted; each consumer installs only its framework; verifier returns `pass` with graph hash. |
| `TV-SCOPE-001-N` | Add a fixture edge from neutral `@uifn/components` to `@uifn/react` and a cycle from adapter-kit to core. | Graph verifier fails with `UIFN_PACKAGE_GRAPH_FORBIDDEN_EDGE` and `UIFN_PACKAGE_GRAPH_CYCLE`, naming the exact paths. |
| `TV-CLEAN-001-P` | Scan workspaces, lockfile, exports, tarballs, registry options, docs support matrices, generated files, and release gates after removal. | No supported Vue/Angular surface remains; migration page and unsupported-framework errors exist. |
| `TV-CLEAN-001-N` | Seed a Vue peer dependency and an Angular registry choice in generated fixtures. | Cleanliness/generation gates fail with `UIFN_REMOVED_FRAMEWORK_REFERENCE`; registry selection fails without writing files. |
| `TV-EXP-001-P` | Temporarily exclude `patterns` and `sf` workspaces, then execute the stable package, source, QA, and release-candidate gates. | Stable gates are complete and independent; experimental report is separate and clearly non-GA. |
| `TV-EXP-001-N` | Seed a failing `patterns` test and an import from stable components into `sf`. | Stable graph rejects the import; experimental failure does not falsify a fully passing stable run and is never hidden. |
| `TV-OPS-001-P` | Validate ownership ledger against stable packages, primitives, services, vectors, and matrix rows; simulate a P1 intake and SLA calculation. | Coverage is 100%; routing, severity, response deadline, blocker status, and evidence expiry are deterministic. |
| `TV-OPS-001-N` | Remove the DOM-layer owner and add an expired untriaged accessibility P1. | Release gate fails with `UIFN_OWNER_MISSING` and `UIFN_DEFECT_UNTRIAGED_OR_EXPIRED`. |

## Core architecture vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-ARCH-001-P` | Static-analyze and instrument every interactive primitive while running one canonical interaction. | Every instance is created by the one private runtime; no runtime internal is exported or present as a public declaration path. |
| `TV-ARCH-001-N` | Seed a primitive-local store/transition loop and export the private service constructor. | Architecture gate fails with `UIFN_MULTIPLE_BEHAVIOR_RUNTIME` and `UIFN_PRIVATE_RUNTIME_EXPORTED`. |
| `TV-ARCH-002-P` | For every interactive controller, subscribe, update inputs, invoke actions, read parts, destroy twice, then inspect resources. | Uniform typed surface; exact notifications; new immutable snapshots; zero owned resources; second destroy is no-op. |
| `TV-ARCH-002-N` | Invoke an action/update after destroy and use a controller fixture missing `update`. | Runtime throws `UIFN_CONTROLLER_DESTROYED`; contract compiler/verifier rejects the incomplete surface. |
| `TV-ARCH-003-P` | Scan exports, declarations, source, imports, docs, and clean consumers for the banned legacy API inventory. | Zero legacy identifiers/paths; every migration mapping resolves to a public replacement or explicit removal. |
| `TV-ARCH-003-N` | Reintroduce `StateMachine` through a wildcard export and call legacy `createCombobox` in Svelte. | Gate fails with `UIFN_LEGACY_BEHAVIOR_PATH` at both export and consumer locations. |
| `TV-CORE-001-P` | Dispatch a same-state context change followed by a reentrant event and a no-op; attempt to mutate received snapshots. | Context change and queued event publish versions in FIFO order exactly once; no-op is silent; mutation cannot affect service. |
| `TV-CORE-001-N` | Substitute recursive dispatch or suppress same-state context publication. | Model/trace gate fails with `UIFN_EVENT_ORDER_DIVERGED` or `UIFN_SNAPSHOT_CHANGE_NOT_PUBLISHED`. |
| `TV-CORE-002-P` | Update controlled inputs and refs; compute derived state; create identical trees in concurrent SSR requests, iframe, and shadow root. | Atomic recomputation; refs absent from serialization; scoped deterministic IDs are stable within and unique across scopes. |
| `TV-CORE-002-N` | Place an element ref in a snapshot and share the ID counter across two SSR requests. | Serialization/scope gates fail with `UIFN_SNAPSHOT_NON_SERIALIZABLE` and `UIFN_SCOPE_ID_COLLISION`. |
| `TV-CORE-003-P` | Start effects, timer, observer, abortable async task, and child; replace inputs, transition, destroy, then release stale async completion. | Exact setup/cleanup trace; all work aborted/stopped; stale completion causes no state/callback change. |
| `TV-CORE-003-N` | Seed an effect without cleanup and let a stale promise update after destroy. | Leak/lifecycle gates fail with `UIFN_EFFECT_CLEANUP_MISSING` and `UIFN_STALE_EFFECT_MUTATION`. |
| `TV-CORE-004-P` | Exercise user action, controlled update, DOM event, invalid input, invalid event, and destroy while capturing redacted traces. | Typed metadata and documented error codes are complete; trace contains semantic causes without user secret/value content. |
| `TV-CORE-004-N` | Emit `meta: unknown`, throw a raw TypeError, and include typed password text in a trace. | Type, error-contract, and redaction gates fail with `UIFN_CHANGE_META_INVALID`, `UIFN_UNSTABLE_ERROR`, and `UIFN_TRACE_SECRET`. |
| `TV-PART-001-P` | Compose user/generated click, key, ref, class, style, ARIA, and data props; cancel one event with `preventDefault`. | User handler precedes generated handler; cancellation works; refs/styles/classes compose; declared invariants remain correct. |
| `TV-PART-001-N` | Run generated click before user cancellation and allow an option role/controlled ID to be overwritten. | Part contract fails with `UIFN_HANDLER_ORDER_INVALID` and `UIFN_PART_INVARIANT_OVERRIDDEN`. |
| `TV-ENV-001-P` | Import/run core in Node without DOM, then mount DOM behavior with injected document, iframe, shadow root, direction, locale, clock, and observer doubles. | No core global reads; each root uses its injected capabilities; deterministic results and cleanup. |
| `TV-ENV-001-N` | Seed `document` read in core and remove `ResizeObserver` without a declared fallback. | SSR/static gate fails `UIFN_CORE_BROWSER_GLOBAL`; capability path returns documented `UIFN_ENV_CAPABILITY_MISSING`, not an ambient crash. |

## DOM platform vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-DOM-001-P` | Enumerate tabbables across hidden/inert/disabled/details/radio/contenteditable/tabindex/iframe/open-shadow fixtures while switching input modality. | Tabbable order/native exclusions and focus-visible modality match the golden table; one root listener set; cleanup to zero. |
| `TV-DOM-001-N` | Make an inert descendant tabbable and install one global listener per component. | DOM contract/leak gates fail with `UIFN_TABBABLE_INVALID` and `UIFN_ROOT_LISTENER_DUPLICATE`. |
| `TV-DOM-002-P` | Stack dialog → popover → menu with portals/branches/shadow content; exercise pointer outside, focus outside, Escape, right-click, touch, cancellation. | Only top eligible layer dismisses; branch interactions stay inside; cancellation prevents close; trace records exact route. |
| `TV-DOM-002-N` | Replace composed path with `contains` and dispatch inside a portaled branch. | Gate observes wrongful dismissal and fails `UIFN_LAYER_OUTSIDE_CLASSIFICATION`. |
| `TV-DOM-003-P` | Open nested modal scopes, cycle forward/back, cancel autofocus, remove child trigger, close child/parent under delayed focus work. | Focus stays in active modal; restoration targets parent/fallback deterministically; no body-focus gap or orphan guard. |
| `TV-DOM-003-N` | Disable the last focus guard and remove the restore target without fallback. | Keyboard/focus gate fails `UIFN_FOCUS_SCOPE_ESCAPE` and `UIFN_FOCUS_RESTORE_FAILED`. |
| `TV-DOM-004-P` | Open nested modals in desktop and iOS fixtures, scroll/resize/show virtual keyboard, abruptly unmount, then close final modal. | Background isolated; locks reference-count; exact styles/attributes/scroll restored within tolerance; no stale inert node. |
| `TV-DOM-004-N` | Close the inner modal and restore body overflow early, or leave `aria-hidden` on a sibling. | Gate fails `UIFN_SCROLL_LOCK_NESTING` or `UIFN_MODAL_ISOLATION_STALE`. |
| `TV-DOM-005-P` | Run all placement/middleware cases at edges, clipping ancestors, transforms, fixed context, zoom, mobile viewport, RTL, virtual anchor, scrolling and resizing. | Content remains within specified boundary; placement/middleware CSS data match golden geometry; observers stop on destroy. |
| `TV-DOM-005-N` | Ignore a transformed clipping ancestor and keep auto-update alive after unmount. | Geometry/leak gates fail `UIFN_POSITION_OUT_OF_BOUNDARY` and `UIFN_POSITION_OBSERVER_LEAK`. |
| `TV-DOM-006-P` | SSR, hydrate, portal into document/shadow target, enter/exit, interrupt/reopen, cancel animation, enable reduced motion, and force-mount. | One logical/physical node; deterministic presence states; exit cleanup exactly once; reduced motion completes immediately as specified. |
| `TV-DOM-006-N` | Hydrate a duplicate portal node and fire no `animationend`. | Gate fails `UIFN_PORTAL_HYDRATION_DUPLICATE`; presence timeout/cancellation must resolve rather than leak indefinitely. |
| `TV-DOM-007-P` | Submit/reset/validate controller widgets inside labels, descriptions, errors, disabled fieldsets; enqueue localized polite/assertive announcements. | Correct `FormData`, validation, reset, disabled semantics, accessible relationships, ordered deduplicated speech, and cleanup. |
| `TV-DOM-007-N` | Seed duplicate hidden inputs/live regions and announce a stale option after controller destroy. | Form/live-region gates fail `UIFN_FORM_BRIDGE_DUPLICATE` and `UIFN_LIVE_REGION_STALE_MESSAGE`. |

## Catalog and primitive vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-CAT-001-P` | Validate the canonical catalog and regenerate exports, anatomy, inventories, registry, story/docs/test manifests twice. | Exactly 61 unique GA primitives; complete required fields; byte-identical generation; clean repository diff. |
| `TV-CAT-001-N` | Delete Tooltip accessibility rules and add an undocumented exported primitive. | Generator fails `UIFN_CATALOG_FIELD_MISSING` and `UIFN_CATALOG_EXPORT_DRIFT`. |
| `TV-CAT-002-P` | Property-test collection/navigation/typeahead/range algorithms over seeded insert/remove/reorder/disable/Unicode/RTL/virtualized sequences. | All declared invariants and reference models match; applicable primitives resolve to canonical implementations. |
| `TV-CAT-002-N` | Duplicate typeahead logic in Select and mishandle a disabled item after reorder. | Duplicate/model gates fail `UIFN_SHARED_ALGORITHM_FORK` and `UIFN_COLLECTION_INVARIANT`. |
| `TV-PRIM-001-P` | Execute every canonical vector for Accordion, Avatar, Button, Collapsible, Field, Fieldset, Form, ImageCropper, Input, Marquee, QRCode, ScrollArea, Separator, Toolbar in three frameworks/modes. | Golden behavior/a11y/SSR/form traces match; static items allocate no unnecessary runtime/effect. |
| `TV-PRIM-001-N` | Render a clickable div Button and allocate a subscription for Separator. | Native-semantic and zero-runtime gates fail `UIFN_NATIVE_SEMANTIC_LOST` and `UIFN_STATIC_RUNTIME_COST`. |
| `TV-PRIM-002-P` | Run open/autofocus/nesting/dismiss/restore/portal/presence/geometry matrices for AlertDialog, Dialog, Drawer, FloatingPanel, HoverCard, Popover, Tooltip, Tour. | Primitive-specific rules and cross-type nesting pass in every supported browser/framework. |
| `TV-PRIM-002-N` | Permit AlertDialog outside-dismiss and omit its title. | Contract/a11y gates fail `UIFN_ALERT_DIALOG_DISMISSAL` and `UIFN_ACCESSIBLE_NAME_MISSING`. |
| `TV-PRIM-003-P` | Run APG/native key tables, typeahead, orientation/RTL, submenu grace, disabled/dynamic collection and restoration for ContextMenu, Menu, Menubar, NavigationMenu, Pagination, Tabs, TreeView. | Active/selected/open/focus outputs match each golden table across adapters. |
| `TV-PRIM-003-N` | Seed Menubar Down-key behavior for RTL submenu incorrectly and remove active menu item. | Semantic trace gate fails `UIFN_KEYBOARD_MODEL_DIVERGED` and proves deterministic focus repair was absent. |
| `TV-PRIM-004-P` | Run controlled/uncontrolled, single/multiple, nullable/required, object identity, disable/reorder/reset/form/IME/touch vectors for all selection primitives. | Canonical selection, callbacks, serialization, ARIA, and form traces match on all frameworks. |
| `TV-PRIM-004-N` | Mutate a controlled Select internally and serialize object value as `[object Object]`. | Gate fails `UIFN_CONTROLLED_STATE_DIVERGED` and `UIFN_FORM_VALUE_SERIALIZATION`. |
| `TV-PRIM-005-P` | Exercise composition, caret, paste, autofill, locale number step, clipboard denial, file rejection, async controlled updates, masking and reset. | No premature commit/caret loss; capability errors are stable; secret/file data absent from traces; native forms match. |
| `TV-PRIM-005-N` | Filter Autocomplete during active Japanese composition and log PasswordInput content. | Gates fail `UIFN_IME_COMMIT_EARLY` and `UIFN_TRACE_SECRET`. |
| `TV-PRIM-006-P` | Drive keyboard/pointer/touch/multi-pointer/cancel/lost-capture/RTL/orientation/bounds/precision/reduced-motion for range/gesture primitives. | Values, focus, capture, announcements and visuals match golden outcomes; no stuck drag. |
| `TV-PRIM-006-N` | Lose pointer capture during Slider drag and keep updating, or reverse the wrong axis in RTL. | Gate fails `UIFN_GESTURE_AFTER_CANCEL` or `UIFN_RANGE_DIRECTION_INVALID`. |
| `TV-PRIM-007-P` | Run DST gaps/folds, timezone changes, locale calendars/week starts, segment editing, unavailable dates, color round-trips, fake-clock timer pause/resume. | Structured values stay stable; displayed values/local navigation match locale; tolerance/drift budgets pass. |
| `TV-PRIM-007-N` | Parse a date with host `Date.parse` and run Timer from accumulating `setInterval` ticks. | Determinism/performance gates fail `UIFN_AMBIENT_DATE_PARSE` and `UIFN_TIMER_DRIFT_BUDGET`. |
| `TV-PRIM-008-P` | Validate meter/progress/steps states and toast queue/limit/timer/pause/swipe/duplicate/announcement/destroy behavior with fake and real clocks. | Correct native/ARIA values, callback order, announcement policy, queue state, and zero leftover resources. |
| `TV-PRIM-008-N` | Announce every progress tick and allow a destroyed Toast timer to fire. | Gates fail `UIFN_ANNOUNCEMENT_FLOOD` and `UIFN_TIMER_AFTER_DESTROY`. |
| `TV-I18N-001-P` | Run designated Arabic RTL, Hindi, Japanese IME, and European-locale scenarios with localized messages/timezone in every framework. | Logical keys/placement/value text/messages match declared locale/direction behavior and equivalent traces. |
| `TV-I18N-001-N` | Hardcode English validation text and use LTR ArrowRight semantics for an RTL horizontal primitive. | Gate fails `UIFN_UNLOCALIZED_DEFAULT` and `UIFN_RTL_KEYBOARD_DIVERGED`. |

## Adapter and compatibility vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-ADAPT-001-P` | Bind a controller into each framework, execute identical events, normalize complete semantic traces, and scan adapter-kit. | Trace schema is lossless and equivalent; adapter-kit contains translation/conformance code only. |
| `TV-ADAPT-001-N` | Put a Select key map in adapter-kit and normalize away a callback-order difference. | Static/mutation gates fail `UIFN_ADAPTER_BEHAVIOR_FORK` and `UIFN_TRACE_NORMALIZATION_LOSSY`. |
| `TV-REACT-001-P` | Mount every public React compound in 18.3/19 under StrictMode, controlled updates, transitions/Suspense, streaming SSR/hydration, portals, forms, and abrupt unmount. | Complete anatomy/types/composition; single behavior service; equivalent golden traces; zero warnings/leaks/hydration diffs. |
| `TV-REACT-001-N` | Seed local selection state in React Select and a non-forwarded trigger ref. | Static/behavior/focus tests fail `UIFN_FRAMEWORK_BEHAVIOR_FORK` and `UIFN_PART_REF_LOST`. |
| `TV-SVELTE-001-P` | Mount every public Svelte 5 compound with rune input updates, snippets/bindings, SSR/hydration, actions, portals, forms, and teardown from packed JS. | Complete typed API, no service recreation/duplicate effects, equivalent traces, valid compiled exports. |
| `TV-SVELTE-001-N` | Export raw repository TS and recreate a controller when a prop changes. | Pack/lifecycle gates fail `UIFN_PACKAGE_RAW_SOURCE_EXPORT` and `UIFN_SERVICE_RECREATED_ON_UPDATE`. |
| `TV-SOLID-001-P` | Mount every public Solid compound with accessors/store updates, owner disposal, SSR/hydration, portals, forms, and abrupt unmount. | Catalog/anatomy parity, fine-grained correct updates, equivalent traces, and zero owner/resource leaks. |
| `TV-SOLID-001-N` | Replace a compound with the generic factory or destructure a reactive prop into stale state. | Inventory/behavior gates fail `UIFN_SOLID_COMPOUND_MISSING` or `UIFN_SOLID_REACTIVITY_STALE`. |
| `TV-PARITY-001-P` | For every canonical vector, mount actual exported React/Svelte/Solid trees and compare to a golden semantic trace. | Event/snapshot/callback/parts/ARIA/focus/error/cleanup outcomes match or an approved explicit exception applies. |
| `TV-PARITY-001-N` | Mutate one Solid `aria-activedescendant`, Svelte callback order, and React focus return in separate runs. | Each mutation is caught by parity with the specific field/path; no synthetic sidecar can satisfy it. |
| `TV-COMPAT-001-P` | Execute signed CI/device jobs for every declared framework, Node, desktop browser, Safari/iOS and Android Chrome cell using exact RC tarballs. | All cells current, complete, versioned, artifact-hash-identical, and passing; report contains no implicit skip. |
| `TV-COMPAT-001-N` | Remove previous iOS Safari evidence and test React only on 19 while peer range includes 18.3. | Gate fails `UIFN_COMPAT_MATRIX_MISSING` and `UIFN_PEER_RANGE_UNVERIFIED`. |

## Styling and distribution vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-COMP-001-P` | Pack/install each styled framework package alone, render every compound, scan content/deps, and compare headless/styled traces. | Only chosen framework installed; no product/demo records; open anatomy; semantic/a11y equivalence. |
| `TV-COMP-001-N` | Add React peer to neutral components and hardcode an invoice list/command handler in a styled component. | Gates fail `UIFN_STYLED_FRAMEWORK_COUPLING` and `UIFN_COMPONENT_PRODUCT_CONTENT`. |
| `TV-STYLE-001-P` | Validate tokens/recipes, tree-shake one recipe, and run light/dark/system/forced-colors/reduced-motion/contrast/density/RTL/zoom themes with overrides. | Valid references/contrast/motion fallbacks; correct preference behavior; no semantic trace change; budgets pass. |
| `TV-STYLE-001-N` | Hardcode low-contrast text and animate a required motion under reduced-motion. | Token/visual/a11y gates fail `UIFN_CONTRAST_BUDGET` and `UIFN_REDUCED_MOTION_VIOLATION`. |
| `TV-HOOK-001-P` | Run every declared hook in supported frameworks through SSR, mount/update, strict/reactive lifecycle, multiple roots, and destroy in package/source modes. | Inventory matches docs; deterministic values; injected environment; zero duplicated primitive/DOM logic/resources. |
| `TV-HOOK-001-N` | Add local outside-click logic to a hook and read `window` during SSR. | Static/SSR gates fail `UIFN_HOOK_BEHAVIOR_FORK` and `UIFN_SSR_BROWSER_GLOBAL`. |
| `TV-GEN-001-P` | Generate twice, pack/copy into clean consumers, then run identical type/build/SSR/browser/a11y/trace vectors. | Byte-stable clean generation; both delivery modes produce equivalent outcomes and provenance records. |
| `TV-GEN-001-N` | Hand-edit a copied template without changing canonical definition. | Drift gate fails `UIFN_GENERATED_SOURCE_DRIFT` and names definition/output hashes. |
| `TV-REG-001-P` | Dry-run then install/reinstall a dependency-rich primitive into clean and existing consumers; verify files/checksums/provenance. | Exact plan, no dry-run writes, atomic successful install, idempotent reinstall, valid manifest. |
| `TV-REG-001-N` | Feed traversal/symlink escape, bad checksum, unsupported framework, cycle, conflict, and forced mid-write interruption fixtures. | Stable errors; no path escape; byte-identical rollback; no half-written manifest or dependency. |

## Quality, accessibility, and release vectors

| Vector | Input and operation | Expected output or error |
| --- | --- | --- |
| `TV-STORY-001-P` | Build Storybook from public packages, reconcile story index to catalog, then operate every required story with console/network/a11y collection. | Exact coverage across primitive/anatomy/state/framework/theme/direction/preferences; all live stories pass. |
| `TV-STORY-001-N` | Remove one Solid story export and replace a Dialog story with static test-double markup. | Coverage/interaction gates fail `UIFN_STORY_MISSING` and `UIFN_STORY_NOT_PUBLIC_COMPONENT`. |
| `TV-DOCS-001-P` | Validate docs coverage schema and build/typecheck/run every package/source example in each framework; crawl links/API names/versions. | 100% catalog coverage; all samples use public current APIs and work in clean consumers; no broken/stale claims. |
| `TV-DOCS-001-N` | Leave removed Vue support claim and a code sample using legacy `StateMachine`. | Docs gates fail `UIFN_DOCS_UNSUPPORTED_CLAIM` and `UIFN_DOCS_REMOVED_API`. |
| `TV-A11Y-001-P` | Validate every catalog primitive/mode against WCAG/APG/native ledger entries, approvals, vectors, and current evidence links. | Complete applicable/non-applicable rationale and owner approval; all links resolve to matching revision evidence. |
| `TV-A11Y-001-N` | Mark keyboard criterion non-applicable for Menu without rationale and omit Tooltip name rules. | Ledger gate fails `UIFN_A11Y_NA_UNJUSTIFIED` and `UIFN_A11Y_RULE_MISSING`. |
| `TV-A11Y-002-P` | Run primitive-specific axe/keyboard/focus/name/role/form/live/pointer/touch/RTL/preferences/zoom vectors on public package/source trees in applicable browsers. | Zero serious/critical axe violations; every required observed behavior passes with complete failure-capable evidence. |
| `TV-A11Y-002-N` | Remove Dialog focus trap and configure an irrelevant zero-duration assertion as pass. | Gate fails `UIFN_A11Y_FOCUS_ESCAPE` and `UIFN_ASSERTION_NOT_OBSERVED`; no false green. |
| `TV-A11Y-003-P` | Human testers execute signed scripts across VoiceOver macOS/iOS, NVDA Windows, and TalkBack Android representative/high-risk matrix using exact RC artifacts. | Every row has complete versions, observations, outcomes, defects/retests, signature, and current artifact hashes. |
| `TV-A11Y-003-N` | Submit automation-generated “manual” evidence with no tester/signature and omit TalkBack dynamic-error coverage. | Gate fails `UIFN_MANUAL_EVIDENCE_UNSIGNED` and `UIFN_MANUAL_MATRIX_MISSING`. |
| `TV-A11Y-004-P` | Independent qualified reviewer inspects ledger/code/automation/manual evidence/open defects, requests/retests fixes, and signs final assessment. | Independence/scope/method/findings/retests are complete; unqualified 10/10; JAWS deferment disclosed. |
| `TV-A11Y-004-N` | Use an implementation author as sole reviewer or sign with an open required-row P1. | Gate fails `UIFN_REVIEW_NOT_INDEPENDENT` or `UIFN_A11Y_BLOCKING_DEFECT`. |
| `TV-TEST-001-P` | Produce requirement/vector/primitive/family coverage and run seeded mutations for ordering, ARIA, focus, cleanup, drift, and framework divergence. | 100% required vector coverage; each mutation killed by its intended gate; P0/P1 regressions linked permanently. |
| `TV-TEST-001-N` | Report only line coverage and let an ARIA/focus mutation survive. | Gate fails `UIFN_SEMANTIC_COVERAGE_MISSING` and `UIFN_REQUIRED_MUTATION_SURVIVED`. |
| `TV-PERF-001-P` | Bundle exact public imports with esbuild and Rollup/Vite, gzip, inspect module graph and tarballs, repeat for all budget cells. | Every cell at/below `SPEC.md` limits; no unrelated primitive/framework/test/story/demo content; reproducible raw data. |
| `TV-PERF-001-N` | Add one byte beyond a limit and an unused React adapter to a Svelte consumer. | Gate fails `UIFN_BUNDLE_BUDGET_EXCEEDED` and `UIFN_TREE_SHAKE_FRAMEWORK_LEAK`. |
| `TV-PERF-002-P` | On declared reference devices, warm and sample dispatch/DOM/open/virtualization; repeat mount/interact/destroy stress and take resource/heap snapshots. | All p95/p99/long-task budgets pass; zero owned resource/detached-node leak; heap delta within exact threshold. |
| `TV-PERF-002-N` | Seed an observer leak and a benchmark above overlay p95 budget. | Gate fails `UIFN_RESOURCE_LEAK` and `UIFN_RUNTIME_BUDGET_EXCEEDED`; noisy run cannot be accepted. |
| `TV-SEC-001-P` | Threat-model, scan source/tarballs/deps/licenses/secrets/unsafe DOM, generate SBOM, reproduce build, sign artifacts, and verify commit→attestation→tarball hashes. | No unapproved finding; complete SPDX/CycloneDX data; verified signatures and provenance; tested/published bytes identical. |
| `TV-SEC-001-N` | Seed an unknown transitive license, path traversal registry item, and mismatched tarball hash. | Gates fail `UIFN_LICENSE_UNKNOWN`, `UIFN_REGISTRY_PATH_ESCAPE`, and `UIFN_PROVENANCE_HASH_MISMATCH`. |
| `TV-REL-001-P` | Validate final release evidence manifest against all requirements/vectors/matrix/budgets/defects and immutable artifact/signature references. | Complete current evidence; zero blocker; release result `pass`; summary links every requirement to exact evidence. |
| `TV-REL-001-N` | Replace a manual row with blocked status, expire Safari evidence, and run only dry-run release. | Fail closed with `UIFN_EVIDENCE_BLOCKED`, `UIFN_EVIDENCE_STALE`, and `UIFN_RELEASE_DRY_RUN_ONLY`. |
| `TV-REL-002-P` | Build exact RC tarballs, install clean registry fixtures, run full gate, verify semver/peers/changelogs/migrations/signatures/dist-tags, then rehearse rollback. | Coherent 1.0 set resolves and passes; publication is atomic/signed; rollback restores documented prior state. |
| `TV-REL-002-N` | Publish mismatched internal versions or omit removal migration, then make one dist-tag point to untested bytes. | Gate fails `UIFN_RELEASE_VERSION_SKEW`, `UIFN_MIGRATION_INCOMPLETE`, or `UIFN_PUBLISHED_ARTIFACT_UNTESTED`. |

## Vector maintenance rules

1. A new stable requirement or catalog behavior MUST add positive and negative vectors before implementation merges.
2. A P0/P1 defect MUST add a minimal reproducer vector and link it to the canonical family vector.
3. Golden traces MUST be reviewed data, not blindly updated snapshots. Update tooling MUST require a reason and show semantic diffs.
4. Random/property failures MUST persist their seed and minimized case.
5. Browser and AT evidence MUST never contain secrets, typed passwords, clipboard content, file contents, personal records, or unredacted product data.
