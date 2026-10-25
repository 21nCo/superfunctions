import { afterEach, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { UnixDockerEngine, DockerEngineError } from "./docker-engine.js";
const owned: { server: Server; directory: string }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.server.closeAllConnections();
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    await rm(item.directory, { recursive: true, force: true });
  }
});
async function fixture(listener: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), "cifn-engine-")),
    socket = join(directory, "engine.sock");
  const server = createServer(listener);
  let sockets = 0;
  server.on("connection", (socket) => {
    sockets++;
    socket.once("close", () => sockets--);
  });
  owned.push({ server, directory });
  server.listen(socket);
  await once(server, "listening");
  return {
    engine: new UnixDockerEngine(socket),
    get sockets() {
      return sockets;
    },
  };
}
function frame(stream: number, value: string) {
  const payload = Buffer.from(value),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
it("decodes split multiplexed streams and preserves UTF-8 and line boundaries", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
    const packet = Buffer.concat([
      frame(1, "first 😀\n"),
      frame(2, "error\n"),
      frame(1, "tail"),
    ]);
    for (let index = 0; index < packet.length; index += 3)
      res.write(packet.subarray(index, index + 3));
    res.end();
  });
  const lines: string[] = [];
  const result = await f.engine.attach(
    "/exec/id/start",
    {},
    new AbortController().signal,
    1000,
    (value) => lines.push(...value),
  );
  expect(result.stdout).toBe("first 😀\ntail");
  expect(result.stderr).toBe("error\n");
  expect(lines).toEqual(["first 😀", "error", "tail"]);
});
it("closes the owned transport after a stalled stream deadline", async () => {
  let peerClosed!: Promise<void>;
  const f = await fixture((req, res) => {
    peerClosed = new Promise((resolve) => res.once("close", resolve));
    res.writeHead(200);
    res.write(frame(1, "started\n"));
  });
  await expect(
    f.engine.attach("/exec/id/start", {}, new AbortController().signal, 50),
  ).rejects.toBeInstanceOf(DockerEngineError);
  await peerClosed;
  expect(f.sockets).toBe(0);
});
it("rejects malformed/oversized framing without returning partial output", async () => {
  for (const packet of [
    Buffer.from([9, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([1, 0, 0, 0, 0, 32, 0, 0]),
    Buffer.from([1, 0, 0]),
  ]) {
    const f = await fixture((_req, res) => res.end(packet));
    await expect(
      f.engine.attach("/exec/id/start", {}, new AbortController().signal, 1000),
    ).rejects.toBeInstanceOf(DockerEngineError);
  }
});
it("sanitizes engine error bodies and closes an externally aborted request", async () => {
  const error = await fixture((_req, res) => {
    res.writeHead(403);
    res.end("secret-provider-error");
  });
  await expect(error.engine.json("GET", "/info")).rejects.toMatchObject({
    status: 403,
    message: "Docker engine operation failed",
  });
  const controller = new AbortController();
  let peerClosed!: Promise<void>;
  const held = await fixture((_req, res) => {
    peerClosed = new Promise((resolve) => res.once("close", resolve));
    res.writeHead(200);
    res.write(frame(1, "started\n"));
  });
  const response = held.engine.attach(
    "/exec/id/start",
    {},
    controller.signal,
    1000,
    () => controller.abort(),
  );
  await expect(response).rejects.toBeInstanceOf(DockerEngineError);
  await peerClosed;
  expect(held.sockets).toBe(0);
});
