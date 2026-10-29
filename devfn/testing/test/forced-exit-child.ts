// A run in a child process for the forced-exit fixture: it publishes its receipt in the slot "receipt.json" of a
// given root and gets repeated signals while publishing (sent to itself), or while its root removal or its
// reconciliation rewrite is held (sent by the parent once it prints "holding"). Its run root is the parent's
// private directory holding that receipt root. With stderr "full", it first fills its stderr, which the parent does
// not read, until not one more byte fits. Run through tsx.
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";

const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const [root, phase, stderr] = process.argv.slice(2);
const log = (line: string): void => { fs.writeSync(1, `${line}\n`); };
if (stderr === "full") {
  // process.stderr makes fd 2 nonblocking, so a full pipe answers EAGAIN instead of blocking.
  void process.stderr.fd;
  const fill = (): number => {
    let written = 0;
    for (let size = 65_536; size >= 1;) {
      try { written += fs.writeSync(2, "x".repeat(size)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; size = Math.floor(size / 2); }
    }
    return written;
  };
  // Full once two fills, apart, wrote nothing: the parent stopped reading.
  for (let idle = 0; idle < 2;) {
    idle = fill() === 0 ? idle + 1 : 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// Each move and removal in the root is logged once done, so the parent reads their order.
for (const name of ["linkSync", "renameSync", "rmSync"] as const) {
  const real = fs[name] as (...args: unknown[]) => unknown;
  Object.assign(fs, { [name]: (...args: unknown[]) => {
    const result = real(...args);
    if (String(args[0]).startsWith(root)) log(`${name} ${args.slice(0, name === "rmSync" ? 1 : 2).map((item) => path.basename(String(item))).join(" ")}`);
    return result;
  } });
}
syncBuiltinESMExports();
const { executeRun, interruptOnSignals } = await import("../src/networking/cli.js");
const { DisposableInventory } = await import("../src/networking/inventory.js");
const { ReceiptSlot } = await import("../src/networking/receipt-store.js");
const { NETWORKING_QUALIFICATION_CONTRACT } = await import("../src/networking/matrix.js");
const { RECEIPT_CHECK } = await import("../src/networking/receipt.js");
type Receipt = import("../src/networking/receipt.js").NetworkingQualificationReceipt;

// Signal handlers keep nothing alive, and a held step must outlast the signals.
setInterval(() => undefined, 1000);
const hold = async (): Promise<void> => { log("holding"); await new Promise(() => undefined); };
const runId = "abcdef123456";
const slot = await ReceiptSlot.claim("receipt.json", root);
const signal = interruptOnSignals(slot, runId, path.join(root, "inventory.json"), () => undefined);
const strays: string[] = [];
let writes = 0;
await executeRun({ slot, strays,
  options: { scenarios: [], platform: process.platform, prerequisites: [], drivers: {}, inventory: new DisposableInventory({ runId, root: path.dirname(root), domains: [] }),
    resources: { remove: async () => undefined, present: async () => false }, snapshot: async () => ({}), signal },
  receipt: (_results, runErrors) => ({ contract: NETWORKING_QUALIFICATION_CONTRACT, check: RECEIPT_CHECK, runId, runErrors }) as unknown as Receipt,
  write: async (receipt) => {
    writes += 1;
    if (phase === "reconciliation" && writes > 1) await hold();
    if (phase === "publication") { process.kill(process.pid, "SIGINT"); process.kill(process.pid, "SIGTERM"); }
    await slot.write(receipt);
    log("published");
    if (phase === "reconciliation") strays.push("late");
  },
  reap: async () => undefined,
  removeRoot: async () => {
    if (phase === "unwithdrawable") fs.chmodSync(root, 0o500);
    if (phase === "root removal" || phase === "unwithdrawable") await hold();
    // Publication: the signals sent while the receipt was written arrive meanwhile.
    if (phase === "publication") await new Promise((resolve) => setTimeout(resolve, 5000));
  } });
log("returned");
process.exit(0);
