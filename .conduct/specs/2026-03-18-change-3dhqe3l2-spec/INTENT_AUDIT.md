# Intent Inventory

1. Conduct depends on Superfunctions shared packages instead of custom infrastructure.
2. PlugFn core is ready and must remain the integration runtime.
3. Linear provider has action and trigger gaps that block Conduct PM workflows.
4. GitHub provider has action and trigger gaps that block Conduct PR/review workflows.
5. Slack provider is sufficient for outbound notifications and should not be overbuilt without evidence.
6. ClickUp provider does not exist yet and must be added.
7. `clifn` is a new reusable CLI primitives runtime needed by Conduct and potentially other CLIs.
8. DataFn is evaluated but not required for Conduct v0.3.0.
9. `@superfunctions/db`, storage, webhooks, queue, http, auth, config, errors, envelope, and middleware are considered ready and need compatibility proof rather than speculative rewrites.
10. `@superfunctions/cli` has a schema-generation gap for CHECK constraints and composite indexes.
11. New package work must follow the repo's monorepo naming and workspace rules.
12. Shared-package docs and changelogs must describe the new public capabilities.
13. The dependency work must be verifiable locally through tests and examples.

# Coverage Map

| Intent item | SPEC.md coverage | Requirement IDs | Test vectors |
|---|---|---|---|
| 1 | Overview; Public API; Semantics | PLUG-001, READY-001 | TV-PLUG-001, TV-READY-001 |
| 2 | Overview; Semantics; Invariants | PLUG-001 | TV-PLUG-001 |
| 3 | Public API; Data formats / protocol | LIN-001 | TV-LIN-001 |
| 4 | Public API; Data formats / protocol | GH-001 | TV-GH-001 |
| 5 | Overview; Non-goals; Undefined | READY-001 | TV-READY-001 |
| 6 | Public API; Semantics | CLICKUP-001 | TV-CLICKUP-001 |
| 7 | Overview; Public API; Semantics | CLIFN-001 | TV-CLIFN-001 |
| 8 | Non-goals / Undefined | READY-001 | TV-READY-001 |
| 9 | Overview; Semantics; Observability | READY-001, TEST-001 | TV-READY-001, TV-TEST-001 |
| 10 | Semantics | SCHEMA-001 | TV-SCHEMA-001 |
| 11 | Overview; Semantics | WORKSPACE-001 | TV-WORKSPACE-001 |
| 12 | Observability; Compatibility / versioning strategy | DOCS-001 | TV-DOCS-001 |
| 13 | Observability | TEST-001 | TV-TEST-001 |

# Audit Result

No missing intent items.

Corrective edits made during authoring:

- Converted the flat `clifn/` idea into a repo-convention-compliant package placement assumption.
- Added explicit Linear comment-trigger coverage because Conduct's PM-trigger workflows need comment-driven entry points.
- Captured the `@superfunctions/cli` schema gap as a blocking requirement with a tested fallback path rather than leaving it as an informal note.
