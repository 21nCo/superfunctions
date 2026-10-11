import http from "node:http";
import readline from "node:readline";

import { createOAuthRelayHandler } from "./server.js";

/**
 * Relay process entry. Configuration arrives as the first stdin line, so
 * nothing about it appears in argv. The single stdout line echoes the
 * starter's nonce and the bound loopback port; stdout is then closed and the
 * process writes nothing else, so no request, state or code can reach a log.
 * The relay then waits for its starter to record it and send "commit": a
 * starter that exits first closes stdin, and the relay exits with it, so no
 * relay keeps running without a durable record.
 */
async function main(): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) return;
  const config = JSON.parse(first.value as string) as { stateDir: string; origin: string; nonce: string };
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
  const commit = await lines.next();
  if (commit.done || commit.value !== "commit") { server.closeAllConnections(); process.exit(0); }
  await lines.return?.();
}

main().catch(() => { process.exit(1); });
