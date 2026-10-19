---
title: Prompts and JSON stdio
description: Interactive input, terminal feedback, and machine-readable pipes.
---

`@clifn/core/prompt` exports the named, preconfigured `prompt` object and `createPrompt()` for an injected ask function. It supports `select`, `multiSelect`, `text`, and `confirm`. Use the runner's `nonInteractive` flag to decide whether your command should prompt or require flags; the prompt API itself does not infer that policy. Invalid answers throw `PromptInputError` (code `CLIFN_PROMPT_INPUT_ERROR`): `confirm` accepts only y, yes, n, or no; `select` and `multiSelect` accept a listed choice or its 1-based number and also throw for an empty choice list.

```ts
import { prompt } from "@clifn/core/prompt";
import { ui } from "@clifn/core/ui";

// Inside a runAction handler; `targetFlag` comes from your parsed options.
const targets = ["local", "staging"];
const target = ctx.nonInteractive
  ? targets.find((choice) => choice === targetFlag)
  : await prompt.select("Target environment", targets);
if (!target) throw new Error("--target must be one of local, staging in non-interactive mode");
if (ctx.nonInteractive || (await prompt.confirm(`Continue with ${target}?`))) {
  ui.success(`selected ${target}`);
}
```

`@clifn/core/ui` retains the established `success`, `error`, `warn`, `info`, `spinner`, and `table` terminal helpers. For new CLI output policies, prefer the configurable `createOutput()` service described in [output and diagnostics](/docs/output-and-diagnostics).

`@clifn/core/stdio` exports `readJsonStdin<T>()` and `writeJsonStdout(value)`. The reader parses one JSON document from stdin and raises `InvalidJsonStdinError` on malformed input. The writer emits one serialized JSON document followed by a newline. Both accept injected streams for testing. Keep progress and human messages off stdout when a command promises machine-readable output.
