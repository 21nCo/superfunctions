import { describe, expect, it } from "vitest";

import { validateDevFnConfig } from "../src/index.js";

const manifest = (process: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ version: 1, project: { id: "fixture" }, processes: { app: process }, profiles: { default: { processes: ["app"] } }, ...extra });

describe("runtime isolation declarations", () => {
  it("keeps explicit artifact isolation and drops nothing a manifest declares", () => {
    expect(validateDevFnConfig(manifest({ adapter: "command", command: ["node", "a.mjs"], artifacts: "runtime" })).processes!.app.artifacts).toBe("runtime");
    expect(validateDevFnConfig(manifest({ adapter: "wrangler", command: ["dev"], artifacts: "shared" })).processes!.app.artifacts).toBe("shared");
    expect(validateDevFnConfig(manifest({ adapter: "command", command: ["node", "a.mjs"] })).processes!.app).not.toHaveProperty("artifacts");
    for (const artifacts of ["isolated", true, ""]) {
      expect(() => validateDevFnConfig(manifest({ adapter: "command", command: ["node"], artifacts }))).toThrow(/artifacts/);
    }
  });

  it("requires a Wrangler, Xcode or extfn command to pass its per-runtime directory, since DevFn never rewrites adapter flags", () => {
    expect(() => validateDevFnConfig(manifest({ adapter: "wrangler", command: ["dev"], artifacts: "runtime" }))).toThrow(/--persist-to/);
    expect(() => validateDevFnConfig(manifest({ adapter: "xcode", command: ["build"], artifacts: "runtime" }))).toThrow(/-derivedDataPath/);
    expect(validateDevFnConfig(manifest({ adapter: "wrangler", command: ["dev", "--persist-to", "{{env.DEVFN_ARTIFACT_DIR}}"], artifacts: "runtime" })).processes!.app.artifacts).toBe("runtime");
    expect(validateDevFnConfig(manifest({ adapter: "xcode", command: ["-derivedDataPath", "{{env.DEVFN_ARTIFACT_DIR}}/derived"], artifacts: "runtime" })).processes!.app.artifacts).toBe("runtime");
    // extfn dev writes dist/<target>-dev and has no output-directory option: isolating it needs a command that passes the directory.
    expect(() => validateDevFnConfig(manifest({ adapter: "extfn", artifacts: "runtime" }))).toThrow(/extfn dev has no output-directory option/);
    expect(validateDevFnConfig(manifest({ adapter: "extfn", artifacts: "shared" })).processes!.app.artifacts).toBe("shared");
  });

  it("rejects environment outputs that two runtimes could resolve to one file", () => {
    const outputs = (...paths: string[]) => validateDevFnConfig(manifest({ adapter: "command", command: ["node"] }, { environmentOutputs: paths.map((item) => ({ path: item })) })).environmentOutputs;
    for (const pair of [
      [".env.{runtime}", ".env.a-{runtime}"], // runtime b's second file is runtime a-b's first: .env.a-b
      ["env/{runtime}.env", "env/x-{runtime}.env"],
      ["app-{runtime}.env", "app-{runtime}-x.env"],
      ["a.{runtime}", "{runtime}.b"], // a.b for runtimes b and a
      ["A.{runtime}", "{runtime}.b"], // one file on a case-insensitive file system
      [".env.{runtime}", "./.env.{runtime}"],
      [".env.{runtime}", ".env.default"], // the default runtime's own file
      [".env.{RUNTIME}.{runtime}", ".env.{RUNTIME}.a-{runtime}"], // a literal {RUNTIME} is text: .env.{RUNTIME}.a-b for runtimes a-b and b
    ]) expect(() => outputs(...pair), pair.join(" + ")).toThrow(/can name one file/);
    expect(() => outputs(".env.{runtime}.{runtime}")).toThrow(/once/);
    // Names a runtime name cannot bridge, separate directories, and a literal file the default runtime alone writes beside its own are distinct.
    for (const pair of [
      [".env.{runtime}", ".env.{runtime}.json"],
      ["app-{runtime}.env", "api-{runtime}.env"],
      ["config/{runtime}.env", "other/{runtime}.env"],
      [".env.{runtime}", ".env.local"],
      ["{runtime}.a.env", "{runtime}.b.env"],
    ]) expect(outputs(...pair), pair.join(" + ")).toHaveLength(2);
    // Outputs without the token keep the behavior of earlier releases.
    expect(outputs(".env", ".env")).toHaveLength(2);
  });

  it("accepts the {runtime} output token only in a file name", () => {
    const outputs = (output: string) => validateDevFnConfig(manifest({ adapter: "command", command: ["node"] }, { environmentOutputs: [{ path: output }] })).environmentOutputs;
    expect(outputs(".env.{runtime}")).toEqual([{ path: ".env.{runtime}", format: "dotenv" }]);
    expect(outputs("config/{runtime}.json")).toEqual([{ path: "config/{runtime}.json", format: "dotenv" }]);
    expect(() => outputs("env/{runtime}/app.env")).toThrow(/only in its file name/);
  });

  it("loads a manifest whatever its outputs name, so status and down always reach an existing receipt; DevFn's own state is refused when a start claims it", () => {
    const outputs = (output: string, extra: Record<string, unknown> = {}) =>
      validateDevFnConfig(manifest({ adapter: "command", command: ["node"] }, { environmentOutputs: [{ path: output }], ...extra })).environmentOutputs;
    // .devfn/outputs was free for outputs before named runtimes; receipts and instances are refused at the start, not here.
    for (const output of [".devfn/outputs/app.env", ".devfn/receipts/{runtime}.json", ".devfn/instances/0123456789ab/{runtime}.env", ".devfn/runtime.env"]) expect(outputs(output), output).toHaveLength(1);
    expect(outputs("run/instances/{runtime}.env", { runtimeDir: "run" })).toHaveLength(1);
  });
});
