---
title: "@devfn/testing"
description: Source package guide for @devfn/testing.
---

Deterministic fixture manifests, temporary projects, and fake listeners for allocator, lifecycle, crash-recovery, and CLI contract tests.

`@devfn/testing/networking` publishes the networking qualification matrix (`devfn.networking-qualification/v1`) and its harness: fail-closed prerequisite probes, an approval file that names only nonproduction resources and credential variable names, a disposable resource inventory with absence read-back, protected operator state, and receipts that count a scenario as passed only when a live run observed every planned assertion. Fixture tests listed for each scenario are local evidence, never a live pass. See the package README for the `plan`, `run` and `gate` commands.
