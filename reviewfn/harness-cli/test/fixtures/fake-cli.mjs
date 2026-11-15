// A stand-in agent CLI. It echoes what it received, writes its answer to a file or stdout, and misbehaves on command.
// Usage: fake-cli.mjs --state <dir> [--answer valid|invalid|invalid-once|not-json] [--prompt <file>] [--out <file>]
//   [--model-json <model>] [--model-stderr <model>] [--exit <code>] [--stderr <text>] [--hang] [--version] [any other --flag value]
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

if (options.hang !== undefined) {
  // A descendant that ignores SIGTERM proves the whole process group is killed, not only the direct child.
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; exec sleep 60"], { stdio: "ignore" });
  writeFileSync(path.join(state, "descendant.pid"), String(child.pid));
  setInterval(() => {}, 1_000);
} else {
  const valid = { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] };
  const kind = options.answer ?? "valid";
  const invalid = kind === "invalid" || (kind === "invalid-once" && attempt === 1);
  let answer = kind === "not-json" ? "this is not JSON" : JSON.stringify(invalid ? { findings: "none" } : { ...valid, ...(options["model-json"] ? { model: options["model-json"] } : {}) });
  if (options["model-stderr"]) process.stderr.write(`starting\nserved model: ${options["model-stderr"]}\n`);
  if (options.stderr) process.stderr.write(`${options.stderr}\n`);
  if (options.out !== undefined) writeFileSync(options.out, answer);
  else process.stdout.write(`Thinking...\n{"type":"progress","step":1}\n${JSON.stringify(valid).slice(0, 5)}\n${answer}\ndone\n`);
  process.exitCode = Number(options.exit ?? 0);
}
