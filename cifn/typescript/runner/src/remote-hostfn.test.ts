import { it, expect } from "vitest";
import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRemoteShellJob } from "./remote-runner.js";
it("executes admitted remote HostFn through the trusted host executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cifn-remote-hostfn-")),
    exe = join(root, "hostfn"),
    witness = join(root, "args");
  try {
    writeFileSync(
      exe,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.WITNESS,JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(exe, 0o700);
    const result = await executeRemoteShellJob(
      {
        runId: "owned",
        jobKey: "deploy",
        env: { WITNESS: witness },
        jobSpec: {
          "runs-on": "hostfn-runner",
          steps: [
            { uses: "hostfn/deploy", with: { environment: "production" } },
          ],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        hostFn: {
          executable: exe,
          timeoutMs: 5000,
          labels: ["hostfn-runner"],
          local: true,
        },
      } as any,
    );
    expect(result.status).toBe("success");
    expect(JSON.parse(readFileSync(witness, "utf8"))).toEqual([
      "deploy",
      "--local",
      "--ci",
      "--",
      "production",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("default-denies deployments, unmatched labels and image combinations before any step", async () => {
  const root = mkdtempSync(join(tmpdir(), "cifn-remote-hostfn-deny-")),
    exe = join(root, "hostfn"),
    witness = join(root, "args");
  try {
    writeFileSync(
      exe,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.WITNESS,'ran');\n`,
    );
    chmodSync(exe, 0o700);
    const hostFn = {
      executable: exe,
      timeoutMs: 5000,
      labels: ["hostfn-runner"],
    };
    for (const [policy, label, image] of [
      [undefined, "hostfn-runner", undefined],
      [hostFn, "default", undefined],
      [hostFn, "hostfn-runner", "owned:image"],
    ] as const) {
      const result = await executeRemoteShellJob(
        {
          runId: "owned",
          jobKey: "deploy",
          env: { WITNESS: witness },
          jobSpec: {
            "runs-on": label,
            ...(image ? { image } : {}),
            steps: [
              { run: `printf forbidden > '${witness}'` },
              { uses: "hostfn/deploy", with: { environment: "production" } },
            ],
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { hostFn: policy },
      );
      expect(result.status).toBe("failure");
    }
    expect(() => readFileSync(witness)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("host-owned local mode cannot be changed by the pipeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "cifn-remote-hostfn-flags-")),
    exe = join(root, "hostfn"),
    witness = join(root, "args");
  try {
    writeFileSync(
      exe,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.WITNESS,JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(exe, 0o700);
    const result = await executeRemoteShellJob(
      {
        runId: "owned",
        jobKey: "deploy",
        env: { WITNESS: witness },
        jobSpec: {
          "runs-on": "hostfn-runner",
          steps: [
            {
              uses: "hostfn/deploy",
              with: {
                environment: "--help",
                local: true,
                ci: false,
                executable: "/not/trusted",
              },
            },
          ],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        hostFn: {
          executable: exe,
          timeoutMs: 5000,
          labels: ["hostfn-runner"],
          local: false,
        },
      },
    );
    expect(result.status).toBe("success");
    expect(JSON.parse(readFileSync(witness, "utf8"))).toEqual([
      "deploy",
      "--ci",
      "--",
      "--help",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("rejects malformed host policy before creating runner journal state", async () => {
  const { RemoteRunner } = await import("./remote-runner.js");
  const root = mkdtempSync(join(tmpdir(), "cifn-remote-hostfn-policy-"));
  try {
    for (const hostFn of [
      { executable: "relative", timeoutMs: 1, labels: ["deploy"] },
      { executable: "/trusted", timeoutMs: 0, labels: ["deploy"] },
      { executable: "/trusted", timeoutMs: 1, labels: [] },
      { executable: "/trusted", timeoutMs: 1, labels: ["*"] },
      {
        executable: "/trusted",
        timeoutMs: 1,
        labels: ["deploy"],
        local: "yes",
      },
    ])
      expect(
        () =>
          new RemoteRunner({
            baseUrl: "http://127.0.0.1",
            runnerId: "owned",
            runnerSecret: "owned",
            stateDirectory: join(root, "state"),
            hostFn: hostFn as any,
          }),
      ).toThrow("Invalid trusted HostFn policy");
    expect(existsSync(join(root, "state"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
