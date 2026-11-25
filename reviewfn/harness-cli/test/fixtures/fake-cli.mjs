// A stand-in agent CLI. It echoes what it received, writes its answer to a file or stdout, and misbehaves on command.
// Usage: fake-cli.mjs --state <dir> [--answer valid|invalid|invalid-once|not-json] [--prompt <file>] [--out <file>]
//   [--model-json <model>] [--model-stderr <model>] [--exit <code>] [--stderr <text>] [--hang 1] [--flood 1]
//   [--enforce-schema <file>] [--extra-json <object>] [--mixed <bytes>] [--linger 1] [--version] [any other --flag value]
// --enforce-schema drops every top-level property the schema file does not declare, as a schema-enforcing CLI would.
// --flood keeps appending to the output file, printing nothing on stdout. --extra-json merges an object into a valid answer.
// --mixed writes <bytes> to stdout and <bytes> to the output file, then hangs.
// --linger keeps running after the answer is written.
// --cut-utf8 writes a file model report of --model-json and <bytes> of stdout ending mid-character plus an invalid byte, then hangs.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("fake-cli version 1.2.3 (fixture)\n"); process.exit(0); }
const options = {};
for (let index = 0; index < argv.length; index += 2) options[argv[index].replace(/^--/, "")] = argv[index + 1];
const state = options.state;
const stdin = options.prompt === undefined ? readFileSync(0, "utf8") : "";
const prompt = options.prompt === undefined ? stdin : readFileSync(options.prompt, "utf8");
const calls = path.join(state, "calls.jsonl");
const attempt = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length + 1 : 1;
appendFileSync(calls, `${JSON.stringify({ argv, env: process.env, cwd: process.cwd(), prompt, stdin })}\n`);

// A model report on stderr comes first, so a CLI that then hangs or fails has still reported the model it served.
if (options["model-stderr"]) process.stderr.write(`starting\nserved model: ${options["model-stderr"]}\n`);
if (options.stderr) process.stderr.write(`${options.stderr}\n`);

if (options["cut-utf8"] !== undefined) {
  writeFileSync(options.out, JSON.stringify({ model: options["model-json"] }));
  process.stdout.write(Buffer.concat([Buffer.from("z".repeat(Number(options["cut-utf8"]))), Buffer.from([0xe2, 0x80, 0xff])]));
  setInterval(() => {}, 1_000);
} else if (options.mixed !== undefined) {
  writeFileSync(options.out, "y".repeat(Number(options.mixed)));
  process.stdout.write("z".repeat(Number(options.mixed)));
  setInterval(() => {}, 1_000);
} else if (options.flood !== undefined) {
  const chunk = `${"x".repeat(4_096)}\n`;
  setInterval(() => appendFileSync(options.out, chunk), 5);
} else if (options.hang !== undefined) {
  // A descendant that ignores SIGTERM proves the whole process group is killed, not only the direct child. It is Node
  // itself, so the hang works on every platform; it stops on its own after a minute.
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000); setTimeout(() => process.exit(0), 60_000);"], { stdio: "ignore" });
  writeFileSync(path.join(state, "descendant.pid"), String(child.pid));
  setInterval(() => {}, 1_000);
} else {
  const valid = { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] };
  const kind = options.answer ?? "valid";
  const invalid = kind === "invalid" || (kind === "invalid-once" && attempt === 1);
  let object = invalid ? { findings: "none" } : { ...valid, ...(options["model-json"] ? { model: options["model-json"] } : {}), ...JSON.parse(options["extra-json"] ?? "{}") };
  if (options["enforce-schema"] !== undefined) {
    const declared = JSON.parse(readFileSync(options["enforce-schema"], "utf8")).properties ?? {};
    object = Object.fromEntries(Object.entries(object).filter(([key]) => Object.hasOwn(declared, key)));
  }
  let answer = kind === "not-json" ? "this is not JSON" : JSON.stringify(object);
  if (options.out !== undefined) writeFileSync(options.out, answer);
  else process.stdout.write(`Thinking...\n{"type":"progress","step":1}\n${JSON.stringify(valid).slice(0, 5)}\n${answer}\ndone\n`);
  process.exitCode = Number(options.exit ?? 0);
  if (options.linger !== undefined) setInterval(() => {}, 1_000);
}
