import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

import { processGroupStatus, processIdentityStatus } from "../src/index.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A parent that never reaps keeps its exited child a zombie on every host,
// as a container PID 1 that does not reap keeps every orphan.
it.skipIf(process.platform === "win32")("treats an exited, unreaped group leader and members as gone, and a live member as possibly running", async () => {
  const parent = spawn("perl", ["-e", String.raw`$| = 1; my $c = fork; if (!$c) { setpgrp(0, 0); my $m = fork; if (!$m) { exec "sleep", "30" } print "$$ $m\n"; exit 0 } sleep 60`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [line] = await once(parent.stdout, "data") as [Buffer];
    const [leader, member] = line.toString().trim().split(" ").map(Number);
    await delay(200);
    // The leader is a zombie of a live parent outside its group.
    await expect(processIdentityStatus(leader)).resolves.toBe("exited");
    await expect(processGroupStatus(leader)).resolves.toBe("unverified");
    process.kill(member, "SIGKILL");
    // The member is reaped, or stays a zombie where no init reaps it.
    const deadline = Date.now() + 5_000;
    while (await processGroupStatus(leader) !== "exited" && Date.now() < deadline) await delay(50);
    await expect(processGroupStatus(leader)).resolves.toBe("exited");
  } finally {
    parent.kill("SIGKILL");
  }
});
