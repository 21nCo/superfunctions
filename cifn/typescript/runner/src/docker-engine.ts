import { request } from "node:http";
import { StringDecoder } from "node:string_decoder";
import type { RunStepResult } from "./executor/run-step.js";

export class DockerEngineError extends Error {
  constructor(readonly status?: number) {
    super("Docker engine operation failed");
  }
}
export interface DockerEngine {
  json(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  attach(
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    onLines?: (lines: string[]) => void,
  ): Promise<RunStepResult>;
}
/** Private local Unix-socket client. Remote TCP/SSH contexts are deliberately unsupported. */
export class UnixDockerEngine implements DockerEngine {
  constructor(private readonly socketPath: string) {}
  private exchange(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    consume?: (data: Buffer) => void,
  ): Promise<Buffer> {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload && payload.length > 1_048_576)
      return Promise.reject(new DockerEngineError());
    return new Promise((resolve, reject) => {
      let settled = false,
        closed = false,
        bytes = 0;
      const chunks: Buffer[] = [];
      let complete: (() => void) | undefined;
      const done = (error?: unknown, result?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        complete = () =>
          error ? reject(error) : resolve(result ?? Buffer.alloc(0));
        req.destroy();
        if (closed) complete();
      };
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          agent: false,
          headers: {
            Connection: "close",
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": String(payload.length),
                }
              : {}),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            res.resume();
            req.destroy();
            done(new DockerEngineError(status));
            return;
          }
          res.on("data", (chunk: Buffer) => {
            try {
              if (consume) consume(chunk);
              else {
                bytes += chunk.length;
                if (bytes > 1_048_576) throw new DockerEngineError();
                chunks.push(chunk);
              }
            } catch {
              req.destroy();
              res.destroy();
              done(new DockerEngineError());
            }
          });
          res.once("aborted", () => done(new DockerEngineError()));
          res.once("error", () => done(new DockerEngineError()));
          res.once("end", () => done(undefined, Buffer.concat(chunks)));
        },
      );
      req.once("close", () => {
        closed = true;
        if (complete) complete();
        else done(new DockerEngineError());
      });
      const abort = () => {
        req.destroy();
        done(new DockerEngineError());
      };
      const timer = setTimeout(abort, timeoutMs);
      req.once("error", () => done(new DockerEngineError()));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else req.end(payload);
    });
  }
  async json(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.exchange(method, path, body, signal, 10000);
    if (!result.length) return undefined;
    try {
      return JSON.parse(result.toString("utf8"));
    } catch {
      throw new DockerEngineError();
    }
  }
  async attach(
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    onLines?: (lines: string[]) => void,
  ): Promise<RunStepResult> {
    let pending = Buffer.alloc(0),
      bytes = 0;
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const texts = ["", ""],
      partials = ["", ""];
    const publish = (index: number, text: string) => {
      texts[index] += text;
      partials[index] += text;
      const lines = partials[index].split("\n");
      partials[index] = lines.pop()!;
      if (lines.length) onLines?.(lines.filter(Boolean));
    };
    await this.exchange("POST", path, body, signal, timeoutMs, (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) throw new DockerEngineError();
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const stream = pending[0];
        if (
          (stream !== 1 && stream !== 2) ||
          pending[1] ||
          pending[2] ||
          pending[3]
        )
          throw new DockerEngineError();
        const length = pending.readUInt32BE(4);
        if (length > 1_048_576) throw new DockerEngineError();
        if (pending.length < 8 + length) break;
        publish(
          stream - 1,
          decoders[stream - 1].write(pending.subarray(8, 8 + length)),
        );
        pending = pending.subarray(8 + length);
      }
    });
    if (pending.length) throw new DockerEngineError();
    for (let index = 0; index < 2; index++)
      publish(index, decoders[index].end());
    onLines?.(partials.filter(Boolean));
    return {
      exitCode: 0,
      stdout: texts[0],
      stderr: texts[1],
      lines: [...texts[0].split("\n"), ...texts[1].split("\n")].filter(Boolean),
      streamed: !!onLines,
    };
  }
}
