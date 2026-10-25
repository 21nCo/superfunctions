/** Run from any directory: node flowfn/typescript/scripts/provider-acceptance.mjs.
 * Requires Docker and the workspace npm installation. Creates only disposable
 * loopback-bound Redis/PostgreSQL containers, and removes them in finally.
 * Add --redis-only to create only Redis and run only Redis native cases.
 * Add --python for the complete Python source suite (requires uv; defaults to
 * Python 3.12, overridable with FLOWFN_PYTHON_VERSION).
 * Use --python-wheel instead to test a fresh installed wheel outside the checkout.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const suffix = randomUUID();
const containers = [];
const redisOnly = process.argv.includes("--redis-only");
const pythonWheel = process.argv.includes("--python-wheel");
const python = pythonWheel || process.argv.includes("--python");
const pythonRoot = fileURLToPath(new URL("../../python/", import.meta.url));
let wheelRoot;
function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ??
      new Error(
        `${program} ${args.join(" ")} failed: ${result.stderr ?? result.status}`,
      )
    );
  return result.stdout?.trim();
}
async function start(kind, image, port, extra = []) {
  const name = `flowfn-acceptance-${kind}-${suffix}`;
  command("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1::${port}`,
    ...extra,
    image,
  ]);
  containers.push(name);
  const mapped = command("docker", ["port", name, String(port)])
    .split(":")
    .at(-1);
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = spawnSync(
      "docker",
      [
        "exec",
        name,
        ...(kind === "redis"
          ? ["redis-cli", "ping"]
          : ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"]),
      ],
      { encoding: "utf8" },
    );
    if (ready.status === 0) return mapped;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${kind} did not become ready`);
}
try {
  let pythonRequirement = ".[dev,redis,postgres]";
  if (pythonWheel) {
    wheelRoot = mkdtempSync(join(tmpdir(), "flowfn-wheel-acceptance-"));
    const wheelDir = join(wheelRoot, "wheels");
    command("uv", ["build", "--wheel", "--out-dir", wheelDir, pythonRoot], { stdio: "inherit" });
    const wheels = readdirSync(wheelDir).filter(name => name.endsWith(".whl"));
    if (wheels.length !== 1) throw new Error("Expected exactly one newly built FlowFn wheel");
    pythonRequirement = `flowfn[dev,redis,postgres] @ ${pathToFileURL(join(wheelDir, wheels[0])).href}`;
    cpSync(join(pythonRoot, "tests"), join(wheelRoot, "tests"), { recursive: true,
      filter: source => !source.includes("__pycache__") && !source.endsWith(".pyc") });
  }
  if (!python) command('npm', ['run', 'build'], { stdio: 'inherit' });
  const redis = await start("redis", "redis:7-alpine", 6379);
  const postgres = redisOnly ? undefined : await start("postgres", "postgres:16-alpine", 5432, [
    "-e",
    "POSTGRES_PASSWORD=flowfn-local-acceptance",
  ]);
  const npm = process.env.NPM_CLI;
  const args = [
    "run",
    "test",
    "--",
    "--testTimeout",
    "30000",
    "--hookTimeout",
    "30000",
    "src/adapters/redis.test.ts",
    ...(redisOnly ? [] : ["src/adapters/postgres/postgres.test.ts"]),
    ...process.argv.slice(2).filter(arg => arg !== "--python" && arg !== "--python-wheel" && arg !== "--redis-only"),
  ];
  const environment = {
    ...process.env,
    FLOWFN_REDIS_URL: `redis://127.0.0.1:${redis}`,
    ...(postgres ? { FLOWFN_POSTGRES_URL: `postgres://postgres:flowfn-local-acceptance@127.0.0.1:${postgres}/postgres` } : {}),
  };
  if (redisOnly) delete environment.FLOWFN_POSTGRES_URL;
  if (pythonWheel) delete environment.PYTHONPATH;
  command(python ? "uv" : process.env.FLOWFN_BENCHMARK ? process.execPath : npm ? process.execPath : "npm", python ? [
    "run", "--isolated", "--no-project", "--python", process.env.FLOWFN_PYTHON_VERSION ?? "3.12",
    "--with", pythonRequirement, "python", ...(pythonWheel ? ["-I", "-c", `
import pathlib, sys
import flowfn, pytest
location = pathlib.Path(flowfn.__file__).resolve()
assert "site-packages" in location.parts, location
assert pathlib.Path.cwd() not in location.parents, location
print("Installed wheel import verified:", location, flush=True)
sys.path.insert(0, str(pathlib.Path.cwd()))
raise SystemExit(pytest.main(["tests", "-o", "addopts=", "-o", "asyncio_mode=auto", "-q"]))
`] : ["-m", "pytest", "tests", "-o", "addopts=", "-q"]),
  ] : process.env.FLOWFN_BENCHMARK ? ["--expose-gc", "scripts/queue-benchmark.mjs"] : npm ? [npm, ...args] : args, {
    stdio: "inherit",
    ...(python ? { cwd: wheelRoot ?? pythonRoot } : {}),
    env: environment,
  });
} finally {
  const cleanupErrors = [];
  for (const name of containers.reverse()) {
    try {
      command("docker", ["rm", "-f", name]);
      const remaining = command("docker", [
        "ps",
        "-a",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.Names}}",
      ]);
      if (remaining) throw new Error(`Container cleanup failed: ${name}`);
    } catch (error) { cleanupErrors.push(error); }
  }
  if (wheelRoot) {
    try { rmSync(wheelRoot, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "FlowFn acceptance container cleanup failed");
}
