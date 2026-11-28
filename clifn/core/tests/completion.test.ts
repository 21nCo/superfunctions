import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

import * as core from "../src/index.js";
import {
  CompletionError,
  completionInstructions,
  renderCompletion,
  type CompletionCommand,
  type CompletionOption,
  type CompletionShell,
  type CompletionSkip,
  type CompletionSkipReason,
  type CompletionSpec,
} from "../src/completion.js";

const SHELLS: readonly CompletionShell[] = ["bash"];
const goldenPath = (shell: CompletionShell): string =>
  fileURLToPath(new URL(`./fixtures/completion/demo.${shell}.golden`, import.meta.url));

/** The golden spec: two levels of subcommands, aliases, choice flags and a flag whose value may be left out. */
const GOLDEN_SPEC: CompletionSpec = {
  name: "demo",
  options: [
    { long: "--verbose", short: "-v", description: "Show debug output", takesValue: false },
    { long: "--format", short: "-f", description: "Output format: text or json", takesValue: true, choices: ["text", "json"] },
    { long: "--config", description: "Read settings from [path]\nSecond line is dropped", takesValue: true },
  ],
  commands: [
    {
      name: "serve",
      description: "Start the server, don't wait",
      aliases: ["s"],
      options: [{ long: "--port", short: "-p", description: "Port to listen on", takesValue: true }],
      commands: [
        {
          name: "start",
          description: "Start it",
          options: [
            { long: "--mode", description: "Run mode", takesValue: true, choices: ["dev", "prod"] },
            {
              long: "--open",
              short: "-o",
              description: "Open a browser",
              takesValue: true,
              choices: ["chrome", "firefox"],
              valueOptional: true,
            },
          ],
        },
        {
          name: "stop",
          description: "Stop it",
          aliases: ["halt"],
          options: [{ long: "--force", description: "Stop without waiting", takesValue: false }],
        },
      ],
    },
    { name: "cache:clear", description: "Clear the cache", options: [] },
  ],
};

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CompletionError);
  expect((thrown as CompletionError).code).toBe(code);
}

describe("completion goldens", () => {
  it.each(SHELLS)("renders the %s script for the golden spec byte for byte", (shell) => {
    const { script, skipped } = renderCompletion(GOLDEN_SPEC, shell);

    if (process.env.UPDATE_COMPLETION_GOLDENS === "1") {
      writeFileSync(goldenPath(shell), script);
    }
    expect(script).toBe(readFileSync(goldenPath(shell), "utf8"));
    expect(skipped).toEqual([]);
  });

  it("keeps the bash script to bash 3.2 constructs", () => {
    const forbidden = [
      "mapfile",
      "readarray",
      "declare -A",
      "local -A",
      "typeset -A",
      "declare -n",
      "local -n",
      "compopt",
      "coproc",
      ";;&",
      "|&",
      "&>",
      "${!",
      ",,}",
      "^^}",
      "@Q}",
      "[[ -v",
      "EPOCHSECONDS",
      "wait -n",
    ];
    const scripts = [
      renderCompletion(GOLDEN_SPEC, "bash").script,
      renderCompletion(
        {
          name: "tool",
          options: [{ long: "--format", short: "-f", takesValue: true, choices: ["text", "json"], inherited: false }],
          commands: [{ name: "cache::purge", options: [{ long: "--region", takesValue: true, choices: ["us::east"] }] }],
        },
        "bash",
      ).script,
    ];
    for (const script of scripts) {
      expect(forbidden.filter((token) => script.includes(token))).toEqual([]);
    }
  });
});

describe("bash completion behaviour", () => {
  const DEFAULT_BREAKS = `"'><=;|&(:`;
  let dir: string;
  let goldenScript: string;

  beforeAll(() => {
    const version = spawnSync("bash", ["--version"], { encoding: "utf8" });
    console.log(`bash --version: ${version.stdout.split("\n")[0]}`);
    dir = mkdtempSync(join(tmpdir(), "clifn-completion-"));
    goldenScript = renderCompletion(GOLDEN_SPEC, "bash").script;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

  interface BashCase {
    words: string[];
    /** COMP_LINE; the words joined by spaces unless given, and unset when `null`. */
    line?: string | null;
    breaks?: string;
  }

  /**
   * Sources the script in `bash --norc` and returns COMPREPLY for each case, with the cursor on the last word, as
   * bash sets COMP_WORDS, COMP_CWORD, COMP_LINE and COMP_POINT for a line ending at the cursor.
   */
  function completeWith(script: string, program: string, cases: readonly BashCase[]): string[][] {
    const scriptPath = join(dir, `${program}.bash`);
    writeFileSync(scriptPath, script);
    const driver = [
      `source ${quote(scriptPath)}`,
      `complete -p ${program}`,
      `run() {`,
      `  COMP_WORDBREAKS="$1"`,
      `  if [ "$2" = unset ]; then unset COMP_LINE COMP_POINT; else COMP_LINE="$3"; COMP_POINT=\${#COMP_LINE}; fi`,
      `  shift 3`,
      `  COMP_WORDS=("$@")`,
      `  COMP_CWORD=$(($# - 1))`,
      `  COMPREPLY=(stale)`,
      `  $(complete -p ${program} | sed 's/.* -F \\([^ ]*\\) .*/\\1/')`,
      `  for reply in "\${COMPREPLY[@]}"; do printf '%s\\t' "$reply"; done`,
      `  printf '\\n'`,
      `}`,
      ...cases.map(({ words, line, breaks }) =>
        [
          "run",
          quote(breaks ?? DEFAULT_BREAKS),
          line === null ? "unset" : "set",
          quote(line ?? words.join(" ")),
          ...words.map(quote),
        ].join(" "),
      ),
    ].join("\n");
    const driverPath = join(dir, "driver.bash");
    writeFileSync(driverPath, driver);
    const result = spawnSync("bash", ["--norc", "--noprofile", driverPath], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [registration, ...lines] = result.stdout.split("\n");
    expect(registration).toMatch(new RegExp(`^complete -o default -F _clifn_\\w+ ${program}$`));
    return lines.slice(0, cases.length).map((line) => line.split("\t").slice(0, -1));
  }

  const complete = (cases: readonly BashCase[]): string[][] => completeWith(goldenScript, "demo", cases);

  it.each([
    ["an empty line offers the visible subcommands and aliases", ["demo", ""], ["serve", "s", "cache:clear"]],
    ["a partial subcommand", ["demo", "se"], ["serve"]],
    ["a nested subcommand", ["demo", "serve", ""], ["start", "stop", "halt"]],
    ["a partial nested subcommand", ["demo", "serve", "st"], ["start", "stop"]],
    ["an alias leads to the same subcommands", ["demo", "s", ""], ["start", "stop", "halt"]],
    ["a nested alias keeps its own and inherited flags", ["demo", "serve", "halt", "--"], ["--force", "--port", "--verbose", "--format", "--config"]],
    ["a -- prefix offers long flags", ["demo", "--"], ["--verbose", "--format", "--config"]],
    ["a - prefix offers short flags too", ["demo", "-"], ["--verbose", "-v", "--format", "-f", "--config"]],
    ["choice values after a flag", ["demo", "--format", ""], ["text", "json"]],
    ["choice values after a short flag, filtered", ["demo", "-f", "j"], ["json"]],
    ["a nested flag's choices", ["demo", "s", "start", "--mode", ""], ["dev", "prod"]],
    ["a flag value is skipped on the way to a subcommand", ["demo", "--format", "json", "serve", ""], ["start", "stop", "halt"]],
    ["a flag without choices leaves the value to the default completion", ["demo", "--config", ""], []],
    ["nothing after --", ["demo", "--", ""], []],
    ["a leaf subcommand with no subcommands", ["demo", "serve", "start", ""], []],
    ["the choices of a flag whose value may be left out", ["demo", "serve", "start", "--open", ""], ["chrome", "firefox"]],
    ["a flag after a flag whose value may be left out", ["demo", "serve", "start", "-o", "--m"], ["--mode"]],
    ["a flag whose value was left out does not swallow the next flag", ["demo", "serve", "start", "--open", "--mode", ""], ["dev", "prod"]],
  ] as const)("%s", (_label, words, expected) => {
    expect(complete([{ words: [...words] }])).toEqual([expected]);
  });

  it("joins words bash split at '=' and ':' and replies with the text after the split", () => {
    expect(
      complete([
        // demo --format=j, as bash splits it with '=' in COMP_WORDBREAKS.
        { words: ["demo", "--format", "=", "j"], line: "demo --format=j" },
        // demo --format=, with the cursor right after '='.
        { words: ["demo", "--format", "="], line: "demo --format=" },
        // demo --format=j without '=' in COMP_WORDBREAKS: one word, so the reply keeps the flag.
        { words: ["demo", "--format=j"], breaks: `"'><;|&(:` },
        // demo cache:c, split at ':'.
        { words: ["demo", "cache", ":", "c"], line: "demo cache:c" },
        // demo cache:clear --c: the joined word selects the subcommand.
        { words: ["demo", "cache", ":", "clear", "--c"], line: "demo cache:clear --c" },
        // A value given as --format=json does not consume the next word.
        { words: ["demo", "--format", "=", "json", "se"], line: "demo --format=json se" },
        // Without COMP_LINE, parts next to ':' or '=' are joined.
        { words: ["demo", "cache", ":", "c"], line: null },
      ]),
    ).toEqual([["json"], ["text", "json"], ["--format=json"], ["clear"], ["--config"], ["serve"], ["clear"]]);
  });

  it("keeps words that a blank separates apart after a name ending in ':'", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [],
      commands: [
        {
          name: "cache:",
          options: [{ long: "--force", takesValue: false }],
          commands: [{ name: "purge", options: [] }],
        },
      ],
    };
    expect(
      completeWith(renderCompletion(spec, "bash").script, "tool", [
        { words: ["tool", "cache", ":", "--fo"], line: "tool cache: --fo" },
        { words: ["tool", "cache", ":", "pu"], line: "tool cache: pu" },
        { words: ["tool", "cache", ":", ""], line: "tool cache: " },
        // The cursor right after "cache:": the whole word matches, so the reply completes it.
        { words: ["tool", "cache", ":"], line: "tool cache:" },
      ]),
    ).toEqual([["--force"], ["purge"], ["purge"], [""]]);
  });

  it("joins a run of separators bash keeps as one part, but never across a blank", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [],
      commands: [
        {
          name: "cache::purge",
          options: [
            { long: "--force", takesValue: false },
            { long: "--region", takesValue: true, choices: ["us::east", "eu::west"] },
          ],
        },
        { name: "cache:clear", options: [] },
      ],
    };
    expect(
      completeWith(renderCompletion(spec, "bash").script, "tool", [
        // tool cache::pu, which bash splits into cache, :: and pu.
        { words: ["tool", "cache", "::", "pu"], line: "tool cache::pu" },
        // The cursor right after "cache::": readline replaces the text after the last ':'.
        { words: ["tool", "cache", "::"], line: "tool cache::" },
        // tool cache::purge --: the joined word selects the subcommand.
        { words: ["tool", "cache", "::", "purge", "--"], line: "tool cache::purge --" },
        // A choice value holding '::', as the next word and after '='.
        { words: ["tool", "cache", "::", "purge", "--region", "us", "::", "ea"], line: "tool cache::purge --region us::ea" },
        { words: ["tool", "cache", "::", "purge", "--region", "=", "us", "::", "ea"], line: "tool cache::purge --region=us::ea" },
        // Blanks keep the parts apart: none of them is a subcommand.
        { words: ["tool", "cache", "::", "pu"], line: "tool cache :: pu" },
        { words: ["tool", "cache", "::", "purge", "--"], line: "tool cache :: purge --" },
        { words: ["tool", "cache", "::", "pu"], line: "tool cache:: pu" },
        // A single ':' still joins.
        { words: ["tool", "cache", ":", "cl"], line: "tool cache:cl" },
      ]),
    ).toEqual([["purge"], ["purge"], ["--force", "--region"], ["east"], ["east"], [], [], [], ["clear"]]);
  });

  it("reaches a command whose own name is outside the grammar through its aliases", () => {
    const { script } = renderCompletion(
      {
        name: "tool",
        options: [],
        commands: [
          { name: "bad!", aliases: ["good", "gd"], options: [{ long: "--force", takesValue: false }] },
          { name: "über", aliases: ["uber"], options: [], commands: [{ name: "inner", options: [{ long: "--deep", takesValue: false }] }] },
        ],
      },
      "bash",
    );
    expect(script).not.toMatch(/bad!|über/);
    expect(
      completeWith(script, "tool", [
        { words: ["tool", ""] },
        { words: ["tool", "g"] },
        { words: ["tool", "good", "--"] },
        { words: ["tool", "gd", "--"] },
        { words: ["tool", "u"] },
        { words: ["tool", "uber", ""] },
        { words: ["tool", "uber", "inner", "--"] },
      ]),
    ).toEqual([["good", "gd", "uber"], ["good", "gd"], ["--force"], ["--force"], ["uber"], ["inner"], ["--deep"]]);
  });

  it("offers the nearest definition of a flag a subcommand redefines", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [{ long: "--format", short: "-f", takesValue: true, choices: ["text", "json"] }],
      commands: [
        { name: "serve", options: [{ long: "--format", takesValue: true, choices: ["a", "b"] }] },
        { name: "build", options: [{ short: "-f", takesValue: false }] },
        { name: "lint", options: [] },
      ],
    };
    expect(
      completeWith(renderCompletion(spec, "bash").script, "tool", [
        { words: ["tool", "serve", "--format", ""] },
        { words: ["tool", "serve", "-f", ""] },
        { words: ["tool", "lint", "--format", ""] },
        { words: ["tool", "build", "--format", ""] },
        { words: ["tool", "build", "-f", ""] },
        { words: ["tool", "build", "-"] },
      ]),
    ).toEqual([["a", "b"], ["text", "json"], ["text", "json"], ["text", "json"], [], ["-f", "--format"]]);
  });

  describe("one definition per flag name and level", () => {
    // The program's --format/-f pair; serve pairs -f with another long name, build pairs --format with another short
    // name, and lint redefines the pair for itself only, so its subcommand fix keeps the program's.
    const spec: CompletionSpec = {
      name: "tool",
      options: [{ long: "--format", short: "-f", takesValue: true, choices: ["text", "json"] }],
      commands: [
        {
          name: "serve",
          options: [{ long: "--force", short: "-f", takesValue: false }],
          commands: [{ name: "start", options: [] }],
        },
        { name: "build", options: [{ long: "--format", short: "-s", takesValue: true, choices: ["a", "b"] }] },
        {
          name: "lint",
          options: [{ long: "--format", short: "-f", takesValue: true, choices: ["c", "d"], inherited: false }],
          commands: [{ name: "fix", options: [] }],
        },
      ],
    };
    // Per level: the words before the cursor, then the flags and what follows --format and -f (a flag's choices, or
    // the subcommands when the flag is a switch).
    const levels = [
      { words: [], flags: ["--format", "-f"], format: ["text", "json"], f: ["text", "json"] },
      { words: ["serve"], flags: ["--force", "-f", "--format"], format: ["text", "json"], f: ["start"] },
      { words: ["serve", "start"], flags: ["--force", "-f", "--format"], format: ["text", "json"], f: [] },
      { words: ["build"], flags: ["--format", "-s", "-f"], format: ["a", "b"], f: ["text", "json"] },
      { words: ["lint"], flags: ["--format", "-f"], format: ["c", "d"], f: ["c", "d"] },
      { words: ["lint", "fix"], flags: ["--format", "-f"], format: ["text", "json"], f: ["text", "json"] },
    ] as const;

    it("bash replies with the definition in effect at each level", () => {
      const replies = completeWith(
        renderCompletion(spec, "bash").script,
        "tool",
        levels.flatMap(({ words }) => [
          { words: ["tool", ...words, "-"] },
          { words: ["tool", ...words, "--format", ""] },
          { words: ["tool", ...words, "-f", ""] },
        ]),
      );
      // bash offers a level's own flags first; the order within a level is not part of this check.
      const sorted = replies.map((reply, index) => (index % 3 === 0 ? [...reply].sort() : reply));
      expect(sorted).toEqual(levels.flatMap(({ flags, format, f }) => [[...flags].sort(), [...format], [...f]]));
    });

  });

  it("compares quoted and escaped words by their value and never evaluates them", () => {
    const marker = join(dir, "evaluated");
    const spec: CompletionSpec = {
      name: "tool",
      options: [{ long: "--format", short: "-f", takesValue: true, choices: ["text", "json"] }],
      commands: [
        { name: "serve", options: [{ long: "--mode", takesValue: true, choices: ["dev", "prod"] }] },
        { name: "cache:clear", options: [], commands: [{ name: "purge", options: [] }] },
      ],
    };
    expect(
      completeWith(renderCompletion(spec, "bash").script, "tool", [
        { words: ["tool", '"serve"', "--mo"] },
        { words: ["tool", "'serve'", "--mode", ""] },
        { words: ["tool", '"cache:clear"', "pu"] },
        { words: ["tool", "cache\\:clear", "pu"] },
        { words: ["tool", '"--format"', ""] },
        // A quoted flag's value is skipped on the way to the subcommand.
        { words: ["tool", "'-f'", "json", "se"] },
        { words: ["tool", `$(touch ${marker})`, "se"] },
        { words: ["tool", `\`touch ${marker}\``, "--format", ""] },
      ]),
    ).toEqual([["--mode"], ["dev", "prod"], ["purge"], ["purge"], ["text", "json"], ["serve"], ["serve"], ["text", "json"]]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("completion names and descriptions", () => {
  it("leaves names outside the grammar, duplicates and commands below the third level out and reports them", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [
        { long: "--ok", takesValue: true, choices: ["a", "b c", "-x", "a"] },
        { long: "--bad flag", short: "-x", takesValue: false },
        { long: "ok2", takesValue: false },
        { takesValue: false },
        { long: "--ok", takesValue: false },
      ],
      commands: [
        {
          name: "good",
          aliases: ["g", "g", "bad alias", "good"],
          options: [],
          commands: [{ name: "l2", options: [], commands: [{ name: "l3", options: [], commands: [{ name: "l4", options: [] }] }] }],
        },
        { name: "bad name", options: [] },
        { name: "-dash", options: [] },
        { name: "good", options: [] },
        { name: "g", options: [] },
        { name: "über", options: [] },
      ],
    };

    for (const shell of SHELLS) {
      const { script, skipped } = renderCompletion(spec, shell);
      expect(skipped).toEqual([
        { kind: "choice", name: "b c", path: [], reason: "invalid-name" },
        { kind: "choice", name: "-x", path: [], reason: "invalid-name" },
        { kind: "option", name: "--bad flag", path: [], reason: "invalid-name" },
        { kind: "option", name: "ok2", path: [], reason: "invalid-name" },
        { kind: "option", name: "", path: [], reason: "invalid-name" },
        { kind: "option", name: "--ok", path: [], reason: "duplicate" },
        { kind: "alias", name: "g", path: ["good"], reason: "duplicate" },
        { kind: "alias", name: "bad alias", path: ["good"], reason: "invalid-name" },
        { kind: "alias", name: "good", path: ["good"], reason: "duplicate" },
        { kind: "command", name: "l4", path: ["good", "l2", "l3"], reason: "too-deep" },
        { kind: "command", name: "bad name", path: [], reason: "invalid-name" },
        { kind: "command", name: "-dash", path: [], reason: "invalid-name" },
        { kind: "command", name: "good", path: [], reason: "duplicate" },
        { kind: "command", name: "g", path: [], reason: "duplicate" },
        { kind: "command", name: "über", path: [], reason: "invalid-name" },
      ]);
      expect(script).toContain("l3");
      expect(script).not.toMatch(/l4|bad name|bad alias|bad flag|b c|ok2|über|-dash/);
    }
  });

  it("completes a command whose own name is outside the grammar under its first usable alias", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [],
      commands: [
        { name: "keep", options: [] },
        { name: "bad!", aliases: ["no way", "keep", "good", "good", "gd"], options: [{ long: "--force", takesValue: false }] },
        { name: "über", aliases: ["uber"], options: [], commands: [{ name: "inner", options: [{ long: "--deep", takesValue: false }] }] },
        { name: "nö", aliases: ["nein!"], options: [], commands: [{ name: "lost", options: [] }] },
      ],
    };
    const { script, skipped } = renderCompletion(spec, "bash");
    expect(skipped).toEqual([
      { kind: "command", name: "bad!", path: [], reason: "invalid-name" },
      { kind: "alias", name: "no way", path: ["good"], reason: "invalid-name" },
      { kind: "alias", name: "keep", path: ["good"], reason: "duplicate" },
      { kind: "alias", name: "good", path: ["good"], reason: "duplicate" },
      { kind: "command", name: "über", path: [], reason: "invalid-name" },
      { kind: "command", name: "nö", path: [], reason: "invalid-name" },
      { kind: "alias", name: "nein!", path: ["nö"], reason: "invalid-name" },
      { kind: "command", name: "lost", path: ["nö"], reason: "invalid-name" },
    ]);
    expect(script).toContain("'') words='keep good gd uber' ;;");
    expect(script).toContain("'|good'|'|gd') path='good' ;;");
    expect(script).toContain("'|uber') path='uber' ;;");
    expect(script).toContain("'uber|inner') path='uber/inner' ;;");
    expect(script).not.toMatch(/bad!|über|nö|nein|no way|lost/);
  });

  it("reports each alias of a command left out as a duplicate or below the third level", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [],
      commands: [
        { name: "build", options: [] },
        { name: "build", aliases: ["b", "b!"], options: [{ long: "--fast", takesValue: false }] },
        {
          name: "l1",
          options: [],
          commands: [{ name: "l2", options: [], commands: [{ name: "l3", options: [], commands: [{ name: "l4", aliases: ["four", "4!"], options: [] }, { name: "ü4", aliases: ["u4"], options: [] }] }] }],
        },
      ],
    };
    const { script, skipped } = renderCompletion(spec, "bash");
    expect(skipped).toEqual([
      { kind: "command", name: "build", path: [], reason: "duplicate" },
      { kind: "alias", name: "b", path: ["build"], reason: "duplicate" },
      { kind: "alias", name: "b!", path: ["build"], reason: "invalid-name" },
      { kind: "option", name: "--fast", path: ["build"], reason: "duplicate" },
      { kind: "command", name: "l4", path: ["l1", "l2", "l3"], reason: "too-deep" },
      { kind: "alias", name: "four", path: ["l1", "l2", "l3", "l4"], reason: "too-deep" },
      { kind: "alias", name: "4!", path: ["l1", "l2", "l3", "l4"], reason: "invalid-name" },
      { kind: "command", name: "ü4", path: ["l1", "l2", "l3"], reason: "invalid-name" },
      { kind: "alias", name: "u4", path: ["l1", "l2", "l3", "ü4"], reason: "too-deep" },
    ]);
    expect(script).not.toMatch(/'b'|--fast|l4|four|u4/);
  });

  it("reports every grammar-valid name inside a command left out, without emitting any of them", () => {
    const subtree = (): CompletionCommand[] => [
      {
        name: "child",
        aliases: ["c", "c?"],
        options: [{ long: "--deep", short: "-d", takesValue: true, choices: ["x"] }],
        commands: [{ name: "grand", aliases: ["g"], options: [{ long: "--bad flag", takesValue: false }] }],
      },
    ];
    const flags = (): CompletionOption[] => [{ long: "--force", short: "-f", takesValue: false }, { long: "--force", takesValue: false }];
    const inside = (path: string[], reason: CompletionSkipReason): CompletionSkip[] => [
      { kind: "option", name: "--force", path, reason: "duplicate" },
      { kind: "option", name: "--force", path, reason },
      { kind: "option", name: "-f", path, reason },
      { kind: "command", name: "child", path, reason },
      { kind: "alias", name: "c", path: [...path, "child"], reason },
      { kind: "alias", name: "c?", path: [...path, "child"], reason: "invalid-name" },
      { kind: "option", name: "--deep", path: [...path, "child"], reason },
      { kind: "option", name: "-d", path: [...path, "child"], reason },
      { kind: "command", name: "grand", path: [...path, "child"], reason },
      { kind: "alias", name: "g", path: [...path, "child", "grand"], reason },
      { kind: "option", name: "--bad flag", path: [...path, "child", "grand"], reason: "invalid-name" },
    ];
    const cases: { commands: CompletionCommand[]; expected: CompletionSkip[] }[] = [
      {
        // No usable alias: the command's own name is outside the grammar and so is its only alias.
        commands: [{ name: "bad!", aliases: ["bad?"], options: flags(), commands: subtree() }],
        expected: [
          { kind: "command", name: "bad!", path: [], reason: "invalid-name" },
          { kind: "alias", name: "bad?", path: ["bad!"], reason: "invalid-name" },
          ...inside(["bad!"], "invalid-name"),
        ],
      },
      {
        commands: [{ name: "dup", options: [] }, { name: "dup", aliases: ["d2"], options: flags(), commands: subtree() }],
        expected: [
          { kind: "command", name: "dup", path: [], reason: "duplicate" },
          { kind: "alias", name: "d2", path: ["dup"], reason: "duplicate" },
          ...inside(["dup"], "duplicate"),
        ],
      },
      {
        commands: [{ name: "l1", options: [], commands: [{ name: "l2", options: [], commands: [{ name: "l3", options: [], commands: [{ name: "l4", options: flags(), commands: subtree() }] }] }] }],
        expected: [
          { kind: "command", name: "l4", path: ["l1", "l2", "l3"], reason: "too-deep" },
          ...inside(["l1", "l2", "l3", "l4"], "too-deep"),
        ],
      },
    ];
    for (const { commands, expected } of cases) {
      const { script, skipped } = renderCompletion({ name: "tool", options: [], commands }, "bash");
      expect(skipped).toEqual(expected);
      expect(script).not.toMatch(/--force|-f\b|child|'c'|--deep|grand|bad|d2|l4/);
    }
  });

  it("reports a cyclic subtree inside a command left out once and stops", () => {
    const loop: { name: string; aliases: string[]; options: CompletionOption[]; commands: unknown[] } = {
      name: "loop",
      aliases: ["lp!"],
      options: [{ long: "--again", takesValue: false }],
      commands: [],
    };
    const inner = { name: "inner", options: [], commands: [loop] };
    loop.commands.push(inner);
    const { skipped } = renderCompletion({ name: "tool", options: [], commands: [{ name: "bad!", options: [], commands: [loop] }] } as CompletionSpec, "bash");
    expect(skipped).toEqual([
      { kind: "command", name: "bad!", path: [], reason: "invalid-name" },
      { kind: "command", name: "loop", path: ["bad!"], reason: "invalid-name" },
      { kind: "alias", name: "lp!", path: ["bad!", "loop"], reason: "invalid-name" },
      { kind: "option", name: "--again", path: ["bad!", "loop"], reason: "invalid-name" },
      { kind: "command", name: "inner", path: ["bad!", "loop"], reason: "invalid-name" },
    ]);
  });

  it("reports a deep chain inside a command left out without running out of stack", () => {
    const chain = (length: number): CompletionCommand => {
      let node: CompletionCommand = { name: `n${length - 1}`, options: [] };
      for (let index = length - 2; index >= 0; index -= 1) {
        node = { name: `n${index}`, options: [], commands: [node] };
      }
      return node;
    };
    const parents: { commands: CompletionCommand[]; reason: CompletionSkipReason; before: number }[] = [
      { commands: [{ name: "bad!", options: [], commands: [chain(3001)] }], reason: "invalid-name", before: 1 },
      { commands: [{ name: "dup", options: [] }, { name: "dup", options: [], commands: [chain(3001)] }], reason: "duplicate", before: 1 },
      { commands: [{ name: "l1", options: [], commands: [{ name: "l2", options: [], commands: [chain(3002)] }] }], reason: "too-deep", before: 0 },
    ];
    for (const { commands, reason, before } of parents) {
      const { script, skipped } = renderCompletion({ name: "tool", options: [], commands }, "bash");
      expect(script).toContain("-F _clifn_tool tool");
      expect(skipped).toHaveLength(before + 3001);
      expect(skipped.every((entry) => entry.kind === "command" && entry.reason === reason)).toBe(true);
    }
  });

  it("reports each command object of a shared subtree once", () => {
    // Every node lists all ten nodes, so walking each path would grow factorially; each object is reported once.
    const nodes: { name: string; options: never[]; commands: unknown[] }[] = Array.from({ length: 10 }, (_, index) => ({
      name: `n${index}`,
      options: [],
      commands: [],
    }));
    for (const node of nodes) node.commands.push(...nodes);
    const spec = { name: "tool", options: [], commands: [{ name: "bad!", options: [], commands: nodes }] } as CompletionSpec;
    const { skipped } = renderCompletion(spec, "bash");
    expect(skipped).toEqual([
      { kind: "command", name: "bad!", path: [], reason: "invalid-name" },
      ...nodes.map((node) => ({ kind: "command", name: node.name, path: ["bad!"], reason: "invalid-name" })),
    ]);
  });

  it("stops at the third level of a cyclic hand-written spec", () => {
    const loop: { name: string; options: never[]; commands: unknown[] } = { name: "loop", options: [], commands: [] };
    loop.commands.push(loop);
    const { skipped } = renderCompletion({ name: "tool", options: [], commands: [loop] } as CompletionSpec, "bash");
    expect(skipped).toEqual([{ kind: "command", name: "loop", path: ["loop", "loop", "loop"], reason: "too-deep" }]);
  });

  it("validates descriptions but writes none into the bash script", () => {
    const spec: CompletionSpec = {
      name: "tool",
      options: [{ long: "--a", description: "it's a [b]: c\\d\nsecond", takesValue: true, choices: ["x:y"] }],
      commands: [{ name: "run:all", description: "it's: [x]\u001b[31m", options: [] }],
    };
    const { script, skipped } = renderCompletion(spec, "bash");
    expect(skipped).toEqual([]);
    expect(script).not.toMatch(/it'|second|\u001b/);
    expectCode(
      () => renderCompletion({ name: "x", options: [], commands: [{ name: "a", description: 1, options: [] }] } as never, "bash"),
      "CLIFN_COMPLETION_INVALID_SPEC",
    );
  });

  it("rejects a malformed spec, a program name outside the grammar and an unknown shell", () => {
    expectCode(() => renderCompletion({ name: "bad name", options: [], commands: [] }, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "", options: [], commands: [] }, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "x", options: [], commands: "nope" } as never, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "x", options: [{ long: "--a" }], commands: [] } as never, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion(null as never, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "x", options: [], commands: [{ name: "a", aliases: new Array(1), options: [] }] }, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "x", options: new Array(1), commands: [] }, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "x", options: [{ long: "--a", takesValue: true, valueOptional: "yes" }], commands: [] } as never, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    expectCode(() => renderCompletion({ name: "x", options: [{ long: "--a", takesValue: false, inherited: 0 }], commands: [] } as never, "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
    for (const shell of ["zsh", "fish", "powershell"]) {
      expectCode(() => renderCompletion(GOLDEN_SPEC, shell as CompletionShell), "CLIFN_COMPLETION_UNSUPPORTED_SHELL");
    }
  });
});

describe("completion instructions and the completion command", () => {
  it("tells the user where bash looks for the script", () => {
    expect(completionInstructions("demo", "bash")).toEqual([
      "To load demo completions in every new bash shell (with bash-completion 2), save the script:",
      "  mkdir -p ~/.local/share/bash-completion/completions",
      "  demo completion bash > ~/.local/share/bash-completion/completions/demo",
      "Or source it from ~/.bashrc:",
      '  eval "$(demo completion bash)"',
    ]);
    expect(completionInstructions("demo", "bash", { command: "demo shell-completion bash" })[2]).toBe(
      "  demo shell-completion bash > ~/.local/share/bash-completion/completions/demo",
    );
    for (const shell of ["zsh", "fish", "tcsh"]) {
      expectCode(() => completionInstructions("demo", shell as CompletionShell), "CLIFN_COMPLETION_UNSUPPORTED_SHELL");
    }
    expectCode(() => completionInstructions("de mo", "bash"), "CLIFN_COMPLETION_INVALID_SPEC");
  });

  it("adds a completion <shell> command to a program in a few lines", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const program = new Command("demo").exitOverride();
    program
      .command("completion")
      .argument("<shell>")
      .action((shell: CompletionShell) => {
        stdout.push(renderCompletion(GOLDEN_SPEC, shell).script);
        stderr.push(...completionInstructions(GOLDEN_SPEC.name, shell).map((line) => `${line}\n`));
      });

    await program.parseAsync(["completion", "bash"], { from: "user" });

    expect(stdout.join("")).toBe(readFileSync(goldenPath("bash"), "utf8"));
    expect(stderr[0]).toBe("To load demo completions in every new bash shell (with bash-completion 2), save the script:\n");
  });

  it("is exported from the package root", () => {
    expect(core.renderCompletion).toBe(renderCompletion);
    expect(core.completionInstructions).toBe(completionInstructions);
    expect(core.CompletionError).toBe(CompletionError);
  });
});
