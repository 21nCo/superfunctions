---
title: Trust and secret handling
description: Review manifests, isolate secrets, and confirm public exposure.
---

Every manifest can declare lifecycle commands. DevFn requires explicit trust for its exact digest before first load and after edits, including JSON manifests. Executable manifests run from a private verified copy and cannot import other files, closing a dependency escape around the digest check.

Runtime children inherit a small base environment plus named `envAllowlist` entries. Sensitive-looking names must also appear in `secretEnv` so effective values are redacted before native logs persist. Credentials are also rejected in resolved literals and command argv, including URL userinfo, `Authorization` headers, credential-named flags, form fields, and JSON keys. These checks are not full secret detection; inspect all manifest literals. Compose services with `secretEnv` use Docker's `none` logging driver. Runtime directories and files default to owner-only modes.

Ports and proxy targets bind to loopback unless the manifest explicitly selects public exposure; `--allow-public` is an additional confirmation on every start. DevFn does not infer a public tunnel. Development domains other than `.localhost` require machine registration that a repository manifest cannot perform, and every selected hostname must resolve only to loopback. DevFn never installs Caddy's internal CA in a trust store. `down` stops only owned instance resources and does not delete persistent volumes. Read the [full security contract](/docs/reference/security) before using DevFn with sensitive data.
