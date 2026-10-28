import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

import { startedProcessBirthSignature } from "@devfn/processes";

import { createOriginBridge, startedEndpoint } from "./ngrok-bridge.js";
import { parseNgrokConnectorConfig, renderNgrokAgentConfig } from "./ngrok.js";
import { writePrivateJson } from "./state.js";

/**
 * The DevFn ngrok connector: argv is the connector configuration file, the
 * readiness port, the ngrok executable and the agent identity file. It runs the origin bridge on a
 * free loopback port, then the ngrok agent with a configuration that
 * forwards every selected endpoint to that bridge. GET /ready on the
 * readiness port answers 200, with the public URL of each hostname, once
 * the agent reports every endpoint started. The agent receives only PATH,
 * the private HOME and the authtoken; DevFn's process wrapper redacts the
 * authtoken from everything written to the connector log. The connector
 * exits when the agent does, so a dead agent never looks ready, and kills
 * the agent whenever it exits itself: an agent left behind would keep its
 * public endpoints forwarding to a freed loopback port that any local
 * process could bind, past the bridge's allowlist. A connector killed
 * outright runs no code, so the agent's verified identity is recorded
 * before the agent may route anything, and the tunnel service stops an
 * agent its connector left behind through it (see agentIdentityFile).
 * The URLs the service reads back at launch are the ones it reports, so an
 * endpoint the agent later reports at another URL stops the connector:
 * status then shows it stopped, and recovery relaunches it and reads the
 * new URLs back, instead of the old URL being reported as current.
 */
let agent: ChildProcess | undefined;
// Synchronous, so it holds for every exit: fatal error, signal timeout or the agent's own exit (then a no-op).
process.on("exit", () => { agent?.kill("SIGKILL"); });
const fatal = (error: unknown) => {
  process.stderr.write(`DevFn ngrok connector failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

async function main(): Promise<void> {
  const [configFile, readyPortText, command, identityFile] = process.argv.slice(2);
  const config = parseNgrokConnectorConfig(await readFile(configFile, "utf8"));
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !command || !path.isAbsolute(command) || !identityFile || !path.isAbsolute(identityFile)) {
    throw new Error("The ngrok connector needs a private HOME, an absolute ngrok path and an absolute agent identity file.");
  }
  const bridge = createOriginBridge({ hostnames: config.hostnames, originPort: config.origin.port, ca: await readFile(config.origin.caFile, "utf8") });
  await new Promise<void>((resolve, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", resolve); });
  bridge.on("error", fatal);
  const address = bridge.address();
  const agentFile = path.join(home, `agent-${process.pid}.yml`);
  await writeFile(agentFile, renderNgrokAgentConfig(config, typeof address === "object" && address ? address.port : 0), { mode: 0o600 });

  const urls: Record<string, string> = {};
  // Every endpoint started, each at its own URL; a reserved one at exactly its hostname.
  const ready = () => new Set(config.hostnames.map((hostname) => urls[hostname])).size === config.hostnames.length &&
    config.hostnames.every((hostname) => urls[hostname] !== undefined && (config.endpoints === "ephemeral" || urls[hostname] === `https://${hostname}`));
  const readiness = http.createServer((request, response) => {
    const body = request.url === "/ready" && ready() ? JSON.stringify({ urls }) : "";
    response.writeHead(body ? 200 : 503, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { readiness.once("error", reject); readiness.listen(Number(readyPortText), "127.0.0.1", resolve); });
  readiness.on("error", fatal);

  // On POSIX the agent first runs as a shell that waits for "start" on stdin
  // and then execs ngrok in the same process (through env, which drops the
  // variables the shell adds), so the identity recorded below stays the
  // agent's; a connector that dies before recording it closes stdin, and the
  // shell exits without ever starting ngrok. Windows has no such gate: an
  // agent its connector loses before recording it is a documented gap.
  const argv = ["start", "--all", "--config", agentFile];
  const gated = process.platform !== "win32";
  const gate = 'read -r gate && [ "$gate" = start ] && exec /usr/bin/env -u PWD -u OLDPWD -u SHLVL -u _ "$0" "$@"';
  const child = spawn(gated ? "/bin/sh" : command, gated ? ["-c", gate, command, ...argv] : argv, {
    env: { PATH: process.env.PATH ?? "", HOME: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN ?? "" },
    stdio: [gated ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true,
  });
  agent = child;
  readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
    process.stdout.write(`${line}\n`);
    const started = startedEndpoint(line);
    if (started && config.hostnames.includes(started.name)) {
      if (urls[started.name] !== undefined && urls[started.name] !== started.url) fatal(new Error(`the ngrok agent reassigned the endpoint for ${started.name}`));
      urls[started.name] = started.url;
    }
  });
  child.stderr!.pipe(process.stderr);
  const exit = (code: number) => { void rm(agentFile, { force: true }).finally(() => process.exit(code)); };
  child.once("error", fatal);
  // Only an agent that exited stops being one the service must look for.
  child.once("exit", (code) => { void rm(identityFile, { force: true }).finally(() => exit(code === 0 ? 0 : 1)); });
  // Until it is recorded the gate stays closed: failing here exits the connector, and the agent with it, before ngrok runs.
  const birthSignature = child.pid ? await startedProcessBirthSignature(child.pid) : undefined;
  if (!child.pid || !birthSignature) throw new Error("The ngrok agent's process identity could not be read.");
  await writePrivateJson(identityFile, { version: 1, pid: child.pid, birthSignature, startedAt: new Date().toISOString(), configFile: path.basename(configFile) });
  child.stdin?.end("start\n");
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => { child.kill("SIGTERM"); setTimeout(() => exit(0), 2_000).unref(); });
}

main().catch(fatal);
