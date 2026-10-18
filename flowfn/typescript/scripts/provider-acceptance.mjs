/** Run from any directory: node flowfn/typescript/scripts/provider-acceptance.mjs.
 * Requires Docker and the workspace npm installation. Creates only disposable
 * loopback-bound Redis/PostgreSQL containers, and removes them in finally.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const suffix = randomUUID();
const containers = [];
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
  command('npm', ['run', 'build'], { stdio: 'inherit' });
  const redis = await start("redis", "redis:7-alpine", 6379);
  const postgres = await start("postgres", "postgres:16-alpine", 5432, [
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
    "src/adapters/postgres/postgres.test.ts",
    ...process.argv.slice(2),
  ];
  command(process.env.FLOWFN_BENCHMARK ? process.execPath : npm ? process.execPath : "npm", process.env.FLOWFN_BENCHMARK ? ["--expose-gc", "scripts/queue-benchmark.mjs"] : npm ? [npm, ...args] : args, {
    stdio: "inherit",
    env: {
      ...process.env,
      FLOWFN_REDIS_URL: `redis://127.0.0.1:${redis}`,
      FLOWFN_POSTGRES_URL: `postgres://postgres:flowfn-local-acceptance@127.0.0.1:${postgres}/postgres`,
    },
  });
} finally {
  for (const name of containers.reverse()) {
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
  }
}
