import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

import { createOriginBridge, startedEndpoint } from "./ngrok-bridge.js";
import { parseNgrokConnectorConfig, renderNgrokAgentConfig } from "./ngrok.js";

/**
 * The DevFn ngrok connector: argv is the connector configuration file, the
 * readiness port and the ngrok executable. It runs the origin bridge on a
 * free loopback port, then the ngrok agent with a configuration that
 * forwards every selected endpoint to that bridge. GET /ready on the
 * readiness port answers 200, with the public URL of each hostname, once
 * the agent reports every endpoint started. The agent receives only PATH,
 * the private HOME and the authtoken; DevFn's process wrapper redacts the
 * authtoken from everything written to the connector log. The connector
 * exits when the agent does, so a dead agent never looks ready.
 */
async function main(): Promise<void> {
  const [configFile, readyPortText, command] = process.argv.slice(2);
  const config = parseNgrokConnectorConfig(await readFile(configFile, "utf8"));
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !command || !path.isAbsolute(command)) throw new Error("The ngrok connector needs a private HOME and an absolute ngrok path.");
  const bridge = createOriginBridge({ hostnames: config.hostnames, originPort: config.origin.port, ca: await readFile(config.origin.caFile, "utf8") });
  await new Promise<void>((resolve, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", resolve); });
  const address = bridge.address();
  const agentFile = path.join(home, `agent-${process.pid}.yml`);
  await writeFile(agentFile, renderNgrokAgentConfig(config, typeof address === "object" && address ? address.port : 0), { mode: 0o600 });

  const urls: Record<string, string> = {};
  const ready = () => config.hostnames.every((hostname) => urls[hostname] !== undefined && (config.endpoints === "ephemeral" || urls[hostname] === `https://${hostname}`));
  const readiness = http.createServer((request, response) => {
    const body = request.url === "/ready" && ready() ? JSON.stringify({ urls }) : "";
    response.writeHead(body ? 200 : 503, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { readiness.once("error", reject); readiness.listen(Number(readyPortText), "127.0.0.1", resolve); });

  const agent = spawn(command, ["start", "--all", "--config", agentFile], {
    env: { PATH: process.env.PATH ?? "", HOME: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN ?? "" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  readline.createInterface({ input: agent.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const started = startedEndpoint(line);
    if (started && config.hostnames.includes(started.name)) urls[started.name] = started.url;
    process.stdout.write(`${line}\n`);
  });
  agent.stderr.pipe(process.stderr);
  const exit = (code: number) => { void rm(agentFile, { force: true }).finally(() => process.exit(code)); };
  agent.once("error", () => exit(1));
  agent.once("exit", (code) => exit(code === 0 ? 0 : 1));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { agent.kill("SIGTERM"); setTimeout(() => exit(0), 2_000).unref(); });
}

main().catch((error: unknown) => {
  process.stderr.write(`DevFn ngrok connector failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
