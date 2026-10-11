import http from "node:http";

import { createOAuthRelayHandler } from "./server.js";

/**
 * Relay process entry. Configuration arrives on stdin, so nothing about it
 * appears in argv. The single stdout line echoes the starter's nonce and the
 * bound loopback port; stdout is then closed and the process writes nothing
 * else, so no request, state or code can reach a log.
 */
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const config = JSON.parse(input) as { stateDir: string; origin: string; nonce: string };
  const server = http.createServer(createOAuthRelayHandler({ stateDir: config.stateDir, origin: config.origin }));
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  process.stdout.on("error", () => undefined);
  process.stdout.end(`${JSON.stringify({ nonce: config.nonce, port: typeof address === "object" && address ? address.port : 0 })}\n`);
  const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2_000).unref(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => { process.exitCode = 1; });
