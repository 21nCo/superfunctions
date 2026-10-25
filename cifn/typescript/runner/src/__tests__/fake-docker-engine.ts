import { DockerEngineError, type DockerEngine } from "../docker-engine.js";
import type { RunStepResult } from "../executor/run-step.js";
export function fakeDockerEngine(
  mode = "success",
  calls: string[][] = [],
): DockerEngine & {
  created: number;
  deleted: number;
  commands: string[];
  hold?: () => Promise<void>;
} {
  let present = false,
    running = false,
    id = "",
    exec = 0,
    lastCode = 0;
  const cid = "a".repeat(64);
  const commands: string[] = [];
  const engine = {
    created: 0,
    deleted: 0,
    commands,
    hold: undefined as (() => Promise<void>) | undefined,
    async json(method: string, path: string, body?: unknown): Promise<unknown> {
      if (path === "/info") return { ID: "daemon-owned" };
      if (path.startsWith("/containers/create")) {
        engine.created++;
        present = true;
        id = (body as { Labels: Record<string, string> }).Labels[
          "io.21n.cifn.owner"
        ];
        if (mode === "create-unknown") throw new DockerEngineError();
        return { Id: cid };
      }
      if (path === `/containers/${cid}/start`) {
        running = true;
        calls.push(["start"]);
        return undefined;
      }
      if (path === `/containers/${cid}/exec`) {
        exec++;
        const env = (body as { Env: string[] }).Env;
        commands.push(
          env
            .find((value) => value.startsWith("CIFN_INTERNAL_COMMAND="))!
            .slice("CIFN_INTERNAL_COMMAND=".length),
        );
        lastCode =
          mode === "nonzero" || commands.at(-1)?.includes("exit 7") ? 7 : 0;
        return { Id: exec.toString(16).padStart(64, "0") };
      }
      if (path.startsWith("/exec/") && path.endsWith("/json"))
        return {
          ID: exec.toString(16).padStart(64, "0"),
          ContainerID: cid,
          Running: false,
          ExitCode: lastCode,
        };
      if (method === "DELETE") {
        calls.push(["rm"]);
        if (mode === "cleanup-failure") throw new DockerEngineError();
        present = false;
        running = false;
        engine.deleted++;
        return undefined;
      }
      if (path.startsWith("/containers/") && path.endsWith("/json")) {
        if (!present) throw new DockerEngineError(404);
        return {
          Id: cid,
          Config: {
            Labels: {
              "io.21n.cifn.owner": mode === "foreign" ? "foreign" : id,
            },
          },
          State: { Running: running },
        };
      }
      throw new Error("Unexpected fake engine path");
    },
    async attach(
      _path: string,
      _body: unknown,
      signal: AbortSignal,
      _timeout: number,
      onLines?: (lines: string[]) => void,
    ): Promise<RunStepResult> {
      if (mode === "timeout") throw new DockerEngineError();
      onLines?.(["container output"]);
      if (engine.hold) await engine.hold();
      if (signal.aborted) throw new DockerEngineError();
      return {
        exitCode: 0,
        stdout: "container output",
        stderr: "",
        lines: ["container output"],
        streamed: !!onLines,
      };
    },
  };
  return engine;
}
