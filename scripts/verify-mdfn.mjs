#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const graph = JSON.parse(readFileSync("mdfn/package-graph.json", "utf8"));
const nodes = [...graph.stable, ...graph.optional];
const packOnly = process.argv.includes("--pack-only");
const commands = [["node", ["scripts/verify-mdfn-package-graph.mjs"]]];
if (!packOnly) {
  for (const node of nodes) commands.push(["npm", ["run", "build", `--workspace=${node.path}`]]);
  for (const node of nodes) commands.push(["npm", ["run", "typecheck", `--workspace=${node.path}`]]);
  for (const node of nodes) commands.push(["npm", ["run", "test", `--workspace=${node.path}`]]);
}
if (!process.argv.includes("--skip-pack")) for (const node of nodes) commands.push(["npm", ["pack", "--dry-run", "--json", `--workspace=${node.path}`]]);
if (!process.argv.includes("--skip-pack")) commands.push(["node", ["scripts/verify-mdfn-consumers.mjs"]]);
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", env: { ...process.env, CI: "1" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ ok: true, packages: nodes.length, packChecked: !process.argv.includes("--skip-pack"), consumersChecked: !process.argv.includes("--skip-pack") }));
