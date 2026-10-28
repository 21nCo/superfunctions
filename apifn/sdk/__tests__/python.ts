// Python prerequisites for the generated Python SDK tests: an interpreter (3.10 or later, with venv and pip;
// APIFN_SDK_PYTHON overrides `python3`) and PyPI access for the pinned tools in tests-python/requirements.txt,
// hatchling (the generated build backend) and the generated package's dependencies. Every command and its
// output is appended to a log, which APIFN_SDK_PYTHON_LOG names to keep it for a receipt.

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_DIR } from "./helpers.js";

export const REQUIREMENTS = path.join(PACKAGE_DIR, "tests-python/requirements.txt");

/** Variables that would let the parent environment change what a child interpreter imports. */
const ISOLATE = ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE", "VIRTUAL_ENV", "PIP_REQUIRE_VIRTUALENV", "PIP_TARGET", "PIP_PREFIX"];

export class PythonLog {
  constructor(readonly file: string) {
    writeFileSync(file, "");
  }

  /** Runs a command, logging it and its output; throws with the output's tail when it fails. */
  run(command: string, args: string[], options: { cwd: string; env?: Record<string, string>; input?: string }): string {
    const env: NodeJS.ProcessEnv = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", PYTHONDONTWRITEBYTECODE: "1", ...options.env };
    for (const name of ISOLATE) delete env[name];
    const started = Date.now();
    const result = spawnSync(command, args, { cwd: options.cwd, env, input: options.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    appendFileSync(this.file, `$ ${[command, ...args].join(" ")}  (cwd: ${options.cwd}; ${Date.now() - started} ms; exit ${result.status ?? result.signal ?? result.error})\n${output}${output.endsWith("\n") || output === "" ? "" : "\n"}\n`);
    if (result.status !== 0) {
      throw new Error(`${path.basename(command)} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error}):\n${output.slice(-6000)}`);
    }
    return result.stdout;
  }

  note(text: string): void {
    appendFileSync(this.file, `# ${text}\n\n`);
  }

  /** Copies the log where APIFN_SDK_PYTHON_LOG asks, for an acceptance receipt. */
  keep(): void {
    const target = process.env.APIFN_SDK_PYTHON_LOG;
    if (target) {
      mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      copyFileSync(this.file, path.resolve(target));
    }
  }
}

/** The interpreter the tests use; fails with the prerequisite when it is missing or older than 3.10. */
export function findPython(log: PythonLog, cwd: string): string {
  const python = process.env.APIFN_SDK_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  let version: string;
  try {
    version = log.run(python, ["-c", "import sys, venv, ensurepip; print('%d.%d.%d' % sys.version_info[:3])"], { cwd }).trim();
  } catch (error) {
    throw new Error(`The Python SDK tests need Python 3.10 or later with venv and ensurepip (set APIFN_SDK_PYTHON to choose one): ${(error as Error).message}`);
  }
  const [major, minor] = version.split(".").map(Number);
  if (major! < 3 || (major === 3 && minor! < 10)) throw new Error(`The Python SDK tests need Python 3.10 or later; ${python} is ${version}.`);
  log.note(`Python ${version} (${python})`);
  return python;
}

/** The interpreter inside a virtual environment. */
export function venvPython(dir: string): string {
  return process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
}

/** Creates a fresh virtual environment and installs `packages` (pip arguments) into it. */
export function createVenv(log: PythonLog, python: string, dir: string, packages: string[], cwd: string): string {
  log.run(python, ["-m", "venv", dir], { cwd });
  const interpreter = venvPython(dir);
  if (packages.length > 0) log.run(interpreter, ["-m", "pip", "install", "--no-input", ...packages], { cwd });
  return interpreter;
}
