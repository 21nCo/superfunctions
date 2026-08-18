# MDFN-01 Extension Contract

Extensions declare a unique name/version, preservation behavior, dependencies/conflicts, optional schema nodes and marks, Markdown parse/serialize hooks, secure render hooks, commands, keymaps, input/paste rules, diagnostics, migrations, and security capabilities.

Resolution is deterministic by dependency order, priority, and name. Duplicate names, missing dependencies, cycles, declared conflicts, duplicate commands, duplicate keymaps, and executable-content claims are hard errors. The resolved registry produces a stable schema hash.

## Lifecycle

1. Parse hooks claim source only from a current UTF-16 offset and report consumed length.
2. Claimed source is masked for the baseline parser while line endings and offsets remain stable.
3. The node receives exact raw source and the extension's preservation declaration.
4. Serialize hooks own only their node type. Returning `null` delegates to built-in or opaque handling.
5. Render hooks must return inert HTML and pass through the renderer's output/URL limits.
6. Diagnostic hooks inspect the final document.
7. Migrations are explicit adjacent schema-version transitions.

## Certification

`@mdfn/testing` certifies no-edit preservation, edited serialization, render output, diagnostics, and migrations. A registry recipe is publishable only when dependency/security resolution and certification pass. The callout/diagram implementations are reference extensions and their tests cover the full lifecycle.

## Security

Extensions cannot execute embedded content. Raw HTML capability is separately declared and still requires a host sanitizer. URL schemes are allowlisted. Extension names and conflicts are host-controlled, not source-controlled.
