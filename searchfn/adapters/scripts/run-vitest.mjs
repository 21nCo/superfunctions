import { spawnSync } from "node:child_process";

const forwarded = process.argv.slice(2).filter((arg) => arg !== "--runInBand");
const result = spawnSync("vitest", forwarded, {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
