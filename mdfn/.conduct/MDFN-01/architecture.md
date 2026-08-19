# MDFN-01 Architecture

Status: Approved architecture freeze for SFN-20.

## Layering

1. Core: immutable state, transactions, commands, history, snapshots, anchors, extension resolution.
2. Markdown and render: canonical syntax projection, preservation-aware serialization, secure HTML/render tree, deterministic extraction.
3. Browser: ProseMirror visual projection and CodeMirror source projection, both controlled by the same core state.
4. Adapters: shared adapter-kit plus isolated React, Svelte, and Solid lifecycles.
5. Components: framework-neutral toolbar model rendered only with matching UIFn framework packages.
6. Platform: Yjs collaboration, typed client, and adapter-neutral self-hosted server.
7. Bridges: assets, explicit content typing, search extraction, and validated AI edits.

`mdfn/package-graph.json` is executable architecture. Stable packages cannot depend on optional packages, framework packages cannot import another framework, and environment-neutral packages cannot import browser/framework/Node-only runtimes.

## Controller protocol

All changes are immutable transactions. Source replacements reparse canonical Markdown, map sidecar anchors, update hashes and diagnostics, and enter history. Structural visual changes serialize through the projector. Selection-only transactions do not enter document history. Adapters subscribe to versioned snapshots and expose real undo/redo capability.

## Visual projection

The DOM package maps mdfn nodes to a ProseMirror schema. Source span attributes survive on top-level projected blocks. Comparing the previous and current ProseMirror document marks only changed blocks dirty before canonical serialization. Tables, lists, history, keymaps, paste policy, gap/drop cursors, and core commands are actual ProseMirror plugins and commands.

## Source projection

The source package creates a CodeMirror 6 state/view with Markdown language support, history, search, lint diagnostics, and controller synchronization. Local source edits dispatch the smallest changed range; external controller edits replace CodeMirror content without feedback loops.

## Server

The server wraps the incoming `@superfunctions/db` adapter with its own schema. It validates canonical Markdown, stores source/schema hashes and sidecar data, uses expected versions for optimistic concurrency, writes immutable revisions, records idempotency receipts, persists collaboration updates, and authorizes every action. Its Web Standard router is consumable through existing HTTP adapters without re-exporting them.

## Risk decisions

- Kernel replacement is considered only if independent preservation, transaction, history, and adapter-parity probes cannot meet the contract.
- Source engine replacement is considered only if CodeMirror cannot preserve large-document editing, diagnostics, and synchronization performance.
- Collaboration replacement is considered only if Yjs state vectors, offline updates, awareness, and schema negotiation fail production probes.
