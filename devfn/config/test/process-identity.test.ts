import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Replace what a /proc file reads as, to model hosts that restrict /proc.
const procFiles = vi.hoisted(() => new Map<string, () => Promise<string>>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const replaced = procFiles.get(String(args[0]));
      return replaced ? await replaced() : await actual.readFile(...args);
    },
  };
});

const { processGroupStatus, processIdentityStatus } = await import("../src/index.js");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => { procFiles.clear(); });

async function eventually<T>(read: () => Promise<T>, expected: T): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value = await read();
  while (value !== expected && Date.now() < deadline) { await delay(20); value = await read(); }
  return value;
}

const IDLE = "setInterval(() => {}, 1_000)";
// The leader runs in a group of its own and starts a member in it.
const LEADER = `const member = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" }); process.stdout.write(process.pid + " " + member.pid + "\\n"); ${IDLE}`;
const PARENT = `const leader = require("node:child_process").spawn(process.execPath, ["-e", process.argv[1]], { detached: true, stdio: ["ignore", "pipe", "ignore"] }); leader.stdout.pipe(process.stdout); ${IDLE}`;

/**
 * Run check with a group whose leader has exited but is not reaped, and a
 * live member: the leader's parent is stopped, so it cannot reap it, as a
 * container PID 1 that does not reap never reaps an orphan.
 */
async function withZombieLeader(check: (pids: { leader: number; member: number }) => Promise<void>): Promise<void> {
  const parent = spawn(process.execPath, ["-e", PARENT, LEADER], { stdio: ["ignore", "pipe", "inherit"] });
  let leader: number | undefined;
  try {
    const [line] = await once(parent.stdout, "data") as [Buffer];
    const [leaderPid, member] = line.toString().trim().split(" ").map(Number);
    leader = leaderPid;
    process.kill(parent.pid!, "SIGSTOP");
    process.kill(leader, "SIGTERM");
    await expect(eventually(() => processIdentityStatus(leaderPid), "exited")).resolves.toBe("exited");
    await check({ leader, member });
  } finally {
    if (leader) { try { process.kill(-leader, "SIGKILL"); } catch { /* already gone */ } }
    try { process.kill(parent.pid!, "SIGCONT"); } catch { /* already gone */ }
    parent.kill("SIGKILL");
  }
}

it.skipIf(process.platform === "win32")("treats an exited, unreaped group leader and members as gone, and a live member as possibly running", async () => {
  await withZombieLeader(async ({ leader, member }) => {
    await expect(processGroupStatus(leader)).resolves.toBe("unverified");
    process.kill(member, "SIGKILL");
    // The member is reaped, or stays a zombie where no init reaps it.
    await expect(eventually(() => processGroupStatus(leader), "exited")).resolves.toBe("exited");
  });
});

describe.skipIf(process.platform !== "linux")("incomplete /proc group evidence", () => {
  it("keeps a group with a live member whose /proc entry cannot be read possibly running", async () => {
    await withZombieLeader(async ({ leader, member }) => {
      procFiles.set(`/proc/${member}/stat`, async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
      await expect(processGroupStatus(leader)).resolves.toBe("unverified");
      procFiles.set(`/proc/${member}/stat`, async () => "unparseable");
      await expect(processGroupStatus(leader)).resolves.toBe("unverified");
      expect(process.kill(member, 0)).toBe(true);
    });
  });

  it("counts a group whose members are reaped between its signal and its listing as gone", async () => {
    await withZombieLeader(async ({ leader, member }) => {
      process.kill(member, "SIGKILL");
      // Signal 0 still reaches the unreaped leader; both are reaped before /proc is listed.
      for (const pid of [leader, member]) procFiles.set(`/proc/${pid}/stat`, async () => { throw Object.assign(new Error("reaped"), { code: "ENOENT" }); });
      await expect(processGroupStatus(leader)).resolves.toBe("exited");
    });
  });

  it("never proves a group gone while /proc hides other users' processes", async () => {
    await withZombieLeader(async ({ leader, member }) => {
      process.kill(member, "SIGKILL");
      await expect(eventually(() => processGroupStatus(leader), "exited")).resolves.toBe("exited");
      const mountinfo = "22 1 0:5 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw,hidepid=invisible\n";
      procFiles.set("/proc/self/mountinfo", async () => mountinfo);
      await expect(processGroupStatus(leader)).resolves.toBe("unverified");
      procFiles.set("/proc/self/mountinfo", async () => mountinfo.replace("hidepid=invisible", "hidepid=0"));
      await expect(processGroupStatus(leader)).resolves.toBe("exited");
    });
  });
});
