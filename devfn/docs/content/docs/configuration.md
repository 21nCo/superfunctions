---
title: Configuration
description: Declare project identity, ports, processes, Compose services, and profiles.
---

DevFn discovers `devfn.config.ts`, `.js`, `.mjs`, `.cjs`, or `.json` while walking upward. Each manifest has `version: 1`, a stable `project.id`, and named profiles. It may define ports, native processes, Compose services, hostname routes, prerequisites, environment outputs, and a repository-relative organization policy.

JavaScript-family manifests are executable but must be self-contained; imports and `require()` are rejected. JSON is parsed as data. Both forms require digest-bound trust before loading. Repository-relative paths reject absolute paths, `..` traversal, and symlink escape. References and dependency cycles are validated before lifecycle mutation.

A port can select exact, preferred, range, ephemeral, loopback/public, or contiguous-block allocation. Processes declare an adapter, command or script, dependencies, readiness, environment allowlist, and optional secret names. Compose services select a declared service, port mappings, health, and persistence. Profiles select these resources transitively and may enable the shared proxy. Hostname routes default to `.localhost`; a route can instead select a machine-registered development `domain`, a shared `host` label, and a `path` with prefix or exact matching.

Before startup, DevFn generates `DEVFN_PORT_<NAME>` for each selected port (plus its configured `env` alias) and `DEVFN_URL_<NAME>` for HTTP health ports and routed targets. Profile values, node values, process `command` arguments, package scripts, and command-health arguments can refer to these and other declared keys with `{{env.NAME}}`. Missing references and cycles fail before any lease, file, process, or service mutation. Arguments are passed as literal argv without a shell. Credentials must stay out of literals and argv: URL userinfo, credential headers, credential-named flags, form fields, and JSON keys are rejected, so pass secrets through `envAllowlist` and `secretEnv`.

Resources declare backends and data stores (`service`, `database`, `broker`, `cache`, `object-store`, `browser`) with local or credential-free remote targets. A profile selects each target independently of which code runs locally. DevFn validates the topology before mutation, emits `DEVFN_RESOURCE_*` endpoint and namespace values through the same templates, isolates namespaces per runtime unless sharing is explicit, and records a redacted plan with value provenance. See [resource targets and namespaces](/docs/reference/configuration#resource-targets-and-namespaces).

Read the [complete configuration reference](/docs/reference/configuration) for field shapes, adapter values, health check examples, [endpoint templates](/docs/reference/configuration#startup-endpoint-and-template-resolution), hostname and domain routing, and policy rules. Treat examples as a starting point and verify every process command before trusting a manifest.
