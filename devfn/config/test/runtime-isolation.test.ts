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

  it("requires a Wrangler or Xcode command to pass its per-runtime directory, since DevFn never rewrites adapter flags", () => {
    expect(() => validateDevFnConfig(manifest({ adapter: "wrangler", command: ["dev"], artifacts: "runtime" }))).toThrow(/--persist-to/);
    expect(() => validateDevFnConfig(manifest({ adapter: "xcode", command: ["build"], artifacts: "runtime" }))).toThrow(/-derivedDataPath/);
    expect(validateDevFnConfig(manifest({ adapter: "wrangler", command: ["dev", "--persist-to", "{{env.DEVFN_ARTIFACT_DIR}}"], artifacts: "runtime" })).processes!.app.artifacts).toBe("runtime");
    expect(validateDevFnConfig(manifest({ adapter: "xcode", command: ["-derivedDataPath", "{{env.DEVFN_ARTIFACT_DIR}}/derived"], artifacts: "runtime" })).processes!.app.artifacts).toBe("runtime");
  });

  it("accepts the {runtime} output token only in a file name", () => {
    const outputs = (output: string) => validateDevFnConfig(manifest({ adapter: "command", command: ["node"] }, { environmentOutputs: [{ path: output }] })).environmentOutputs;
    expect(outputs(".env.{runtime}")).toEqual([{ path: ".env.{runtime}", format: "dotenv" }]);
    expect(outputs("config/{runtime}.json")).toEqual([{ path: "config/{runtime}.json", format: "dotenv" }]);
    expect(() => outputs("env/{runtime}/app.env")).toThrow(/only in its file name/);
  });
});
