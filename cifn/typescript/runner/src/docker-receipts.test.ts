import { test, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOwnedDockerJob } from "./owned-docker-job.js";
import {
  inspectDockerReceipt,
  cleanupDockerReceipt,
} from "./docker-receipts.js";
import { fakeDockerEngine } from "./__tests__/fake-docker-engine.js";
import { ProcessGroupUncertainError } from "./executor/owned-shell.js";
async function fixture(mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "cifn-operator-")),
    state = join(root, "state"),
    workspace = join(root, "workspace");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(workspace);
  const engine = fakeDockerEngine(mode);
  await openOwnedDockerJob(engine, state, "fixture", "daemon-owned", 1000, {
    image: "cached",
    workspace,
    owner: "exact-owner",
  });
  const id = readdirSync(state)[0],
    snapshot = inspectDockerReceipt(state, "fixture", id);
  const decision = {
    id,
    fingerprint: snapshot.fingerprint,
    owner: snapshot.owner,
    operatorId: "operator-a",
    stoppedOwner: true as const,
  };
  return {
    root,
    state,
    id,
    engine,
    decision,
    connect: async () => ({ engine, daemonId: "daemon-owned" }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("exact receipt cleanup retains unknown result and original receipt; reopen is idempotent", async () => {
  const f = await fixture();
  try {
    const result = await cleanupDockerReceipt(
      f.state,
      "fixture",
      f.decision,
      f.connect,
    );
    expect(result.executionOutcome).toBe("unknown");
    expect(f.engine.deleted).toBe(1);
    expect(existsSync(join(f.state, f.id, "receipt.json"))).toBe(true);
    expect(existsSync(join(f.state, f.id, "cleanup.lock"))).toBe(false);
    expect(
      await cleanupDockerReceipt(f.state, "fixture", f.decision, async () => {
        throw Error("must not connect");
      }),
    ).toEqual(result);
    await expect(
      cleanupDockerReceipt(
        f.state,
        "fixture",
        { ...f.decision, operatorId: "different" },
        f.connect,
      ),
    ).rejects.toThrow();
  } finally {
    f.cleanup();
  }
});
test("rejects stale fingerprint, owner, attestation, unsupported version and path escape before daemon calls", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { fingerprint: "0".repeat(64) },
      { owner: "wrong" },
      { stoppedOwner: false },
      { id: "../escape" },
    ])
      await expect(
        cleanupDockerReceipt(
          f.state,
          "fixture",
          { ...f.decision, ...change } as typeof f.decision,
          async () => {
            throw Error("not admitted");
          },
        ),
      ).rejects.toThrow();
    expect(f.engine.deleted).toBe(0);
    const path = join(f.state, f.id, "receipt.json"),
      value = JSON.parse(readFileSync(path, "utf8"));
    value.version = 1;
    writeFileSync(path, JSON.stringify(value));
    expect(() => inspectDockerReceipt(f.state, "fixture", f.id)).toThrow();
  } finally {
    f.cleanup();
  }
});
test("fails closed on symlinks and bounded oversized receipt reads", async () => {
  const f = await fixture();
  try {
    const path = join(f.state, f.id, "receipt.json");
    rmSync(path);
    symlinkSync("/etc/passwd", path);
    expect(() => inspectDockerReceipt(f.state, "fixture", f.id)).toThrow();
    rmSync(path);
    writeFileSync(path, "x".repeat(16385), { mode: 0o600 });
    expect(() => inspectDockerReceipt(f.state, "fixture", f.id)).toThrow();
  } finally {
    f.cleanup();
  }
});
test("concurrent independent cleanup callers admit one operator; uncertain durable lock is never stolen", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const first = cleanupDockerReceipt(
      f.state,
      "fixture",
      Object.assign({}, f.decision, { unrelated: "must-not-persist" }),
      async () => {
        entered();
        await held;
        return f.connect();
      },
    );
    await ready;
    expect(
      readFileSync(join(f.state, f.id, "cleanup.lock"), "utf8"),
    ).not.toContain("must-not-persist");
    await expect(
      cleanupDockerReceipt(f.state, "fixture", f.decision, f.connect),
    ).rejects.toThrow();
    release();
    await first;
    expect(f.engine.deleted).toBe(1);
  } finally {
    f.cleanup();
  }
  const failed = await fixture("cleanup-failure");
  try {
    await expect(
      cleanupDockerReceipt(
        failed.state,
        "fixture",
        failed.decision,
        failed.connect,
      ),
    ).rejects.toBeInstanceOf(ProcessGroupUncertainError);
    expect(existsSync(join(failed.state, failed.id, "cleanup.lock"))).toBe(
      true,
    );
    await expect(
      cleanupDockerReceipt(
        failed.state,
        "fixture",
        failed.decision,
        failed.connect,
      ),
    ).rejects.toThrow();
    expect(existsSync(join(failed.state, failed.id, "cleanup.json"))).toBe(
      false,
    );
  } finally {
    failed.cleanup();
  }
});
test("daemon identity mismatch preserves receipt and lock without deletion", async () => {
  const f = await fixture();
  try {
    await expect(
      cleanupDockerReceipt(f.state, "fixture", f.decision, async () => ({
        engine: f.engine,
        daemonId: "different",
      })),
    ).rejects.toBeInstanceOf(ProcessGroupUncertainError);
    expect(f.engine.deleted).toBe(0);
    expect(existsSync(join(f.state, f.id, "cleanup.lock"))).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("never overwrites an independently appeared terminal receipt", async () => {
  const f = await fixture();
  try {
    const terminal = join(f.state, f.id, "cleanup.json");
    await expect(
      cleanupDockerReceipt(f.state, "fixture", f.decision, async () => {
        writeFileSync(terminal, '{"unexpected":"preserve"}', { mode: 0o600 });
        return f.connect();
      }),
    ).rejects.toBeInstanceOf(ProcessGroupUncertainError);
    expect(readFileSync(terminal, "utf8")).toBe('{"unexpected":"preserve"}');
    expect(existsSync(join(f.state, f.id, "cleanup.lock"))).toBe(true);
  } finally {
    f.cleanup();
  }
});
