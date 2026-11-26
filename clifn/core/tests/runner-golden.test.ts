import { runAction, type RunnerActionResult, type RunnerContext, type RunnerOptions } from "../src/runner.js";

// Golden bytes recorded from the reference commit (before `jsonStyle` existed). Text mode and the default
// `'lines'` JSON mode must keep printing exactly these bytes (D2), whatever the document mode does.

type SampleAction = (options: { name: string }, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult;

const samples: Record<string, SampleAction> = {
  // Every log level, a table, a spinner and returned data.
  report: async ({ name }, ctx) => {
    ctx.output.debug("debug line", { step: 1 });
    ctx.output.info(`hello ${name}`);
    ctx.output.success("done");
    ctx.output.warn("careful", { retry: true });
    ctx.output.error("recoverable");
    ctx.output.table({ columns: ["id", "state"], rows: [{ id: 1, state: "ok" }] });
    const spinner = ctx.output.spinner("working");
    spinner.succeed("worked");
    return { data: { name, count: 2n }, exitCode: 0 };
  },
  // A thrown error that carries a code, an exit code and details: the reference runner ignores all three.
  failure: async (_options, ctx) => {
    ctx.output.info("about to fail");
    ctx.diagnostics.add({ code: "SAMPLE", severity: "warning", message: "sample", details: { token: "test-token" } });
    throw Object.assign(new Error("boom"), { code: "SAMPLE_FAILED", exitCode: 3, details: { token: "test-token" } });
  },
  // An explicit json() call plus returned data and diagnostics, with a non-zero exit code.
  emit: async (_options, ctx) => {
    ctx.output.json({ first: true });
    return {
      exitCode: 2,
      data: ["a", "b"],
      diagnostics: [{ code: "EMIT", severity: "info", message: "emitted" }],
    };
  },
};

async function capture(action: SampleAction, runnerOptions: RunnerOptions) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runAction(action, { name: "Ada" }, {
    ...runnerOptions,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

const golden = {
  report: {
    text: {
      exitCode: 0,
      stdout:
        "[d] debug line {\"step\":1}\n[i] hello Ada\n[ok] done\n[!] careful {\"retry\":true}\n" +
        "id | state\n-- | -----\n1  | ok   \n",
      stderr: "[x] recoverable\n\r        \r[ok] worked\n",
    },
    textColor: {
      exitCode: 0,
      stdout:
        "[d] debug line {\"step\":1}\n\u001b[34m[i] hello Ada\u001b[0m\n\u001b[32m[ok] done\u001b[0m\n" +
        "\u001b[33m[!] careful\u001b[0m {\"retry\":true}\nid | state\n-- | -----\n1  | ok   \n",
      stderr: "\u001b[31m[x] recoverable\u001b[0m\n\r        \r\u001b[32m[ok] worked\u001b[0m\n",
    },
    lines: {
      exitCode: 0,
      stdout:
        '{"level":"debug","message":"debug line","details":{"step":1}}\n' +
        '{"level":"info","message":"hello Ada"}\n' +
        '{"level":"success","message":"done"}\n' +
        '{"level":"warn","message":"careful","details":{"retry":true}}\n' +
        '{"columns":["id","state"],"rows":[{"id":1,"state":"ok"}]}\n' +
        '{"name":"Ada","count":"2"}\n',
      stderr: '{"level":"error","message":"recoverable"}\n',
    },
    linesQuiet: {
      exitCode: 0,
      stdout: '{"name":"Ada","count":"2"}\n',
      stderr: '{"level":"error","message":"recoverable"}\n',
    },
  },
  failure: {
    text: {
      exitCode: 1,
      stdout: "[i] about to fail\n",
      stderr: "[x] boom\n",
    },
    lines: {
      exitCode: 1,
      stdout: '{"level":"info","message":"about to fail"}\n{"ok":false,"error":{"code":"CLIFN_RUNNER_FAILED","message":"boom"}}\n',
      stderr: "",
    },
  },
  emit: {
    text: {
      exitCode: 2,
      stdout: '{"first":true}\n',
      stderr: "",
    },
    lines: {
      exitCode: 2,
      stdout: '{"first":true}\n["a","b"]\n',
      stderr: "",
    },
  },
} as const;

describe("reference-commit output bytes (text and 'lines' JSON)", () => {
  it.each([
    ["report", "text", { color: false, verbose: true }],
    ["report", "textColor", { verbose: true }],
    ["report", "lines", { mode: "json", verbose: true }],
    ["report", "linesQuiet", { mode: "json", quiet: true }],
    ["failure", "text", { color: false }],
    ["failure", "lines", { mode: "json" }],
    ["emit", "text", { color: false }],
    ["emit", "lines", { mode: "json" }],
  ] as const)("%s in %s mode", async (sample, variant, runnerOptions) => {
    const expected = (golden[sample] as Record<string, unknown>)[variant];
    await expect(capture(samples[sample], runnerOptions as RunnerOptions)).resolves.toEqual(expected);
  });

  it("keeps the same bytes when jsonStyle is 'lines' explicitly, or 'document' outside JSON mode", async () => {
    for (const sample of ["report", "failure", "emit"] as const) {
      const options = { ...({ jsonStyle: "lines" } as RunnerOptions), mode: "json" as const, verbose: true };
      await expect(capture(samples[sample], options)).resolves.toEqual(
        await capture(samples[sample], { mode: "json", verbose: true })
      );
    }
    await expect(
      capture(samples.failure, { ...({ jsonStyle: "document" } as RunnerOptions), color: false })
    ).resolves.toEqual(golden.failure.text);
  });
});
