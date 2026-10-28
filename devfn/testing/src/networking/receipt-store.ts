import { randomBytes } from "node:crypto";
import { rmSync, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NETWORKING_QUALIFICATION_CONTRACT } from "./matrix.js";
import { RECEIPT_CHECK, type NetworkingQualificationReceipt } from "./receipt.js";

/** The harness-owned directory every run receipt is kept in. */
export const receiptRoot = (): string => path.join(os.homedir(), ".devfn-networking-qualification");

const RECEIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/;

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * One receipt name in the harness-owned receipt directory, held by one run
 * attempt. The directory is created with mode 0700 and accepted only as a
 * real directory of this user that nobody else can write, and the name is
 * claimed with an exclusive lock, so no other run withdraws or replaces its
 * receipt. Every removal and replacement acts on the entry it took, never on
 * an earlier check of the name: whatever is not this harness's receipt is
 * put back and never overwritten.
 */
export class ReceiptSlot {
  private constructor(readonly file: string, private readonly lock: string) {}

  /** Claim name in root; throws when the name or root is not the harness's own, or another run holds the name. */
  static async claim(name: string, root = receiptRoot()): Promise<ReceiptSlot> {
    if (!RECEIPT_NAME.test(name)) throw new Error(`--out ${name} is not a receipt file name such as macos.json; receipts are kept in ${root}.`);
    await mkdir(root, { mode: 0o700 }).catch((error: unknown) => { if (errorCode(error) !== "EEXIST") throw error; });
    const entry = await lstat(root);
    if (!entry.isDirectory() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) {
      throw new Error(`${root} is not a harness-owned receipt directory (a directory, not a symlink, of this user with mode 0700).`);
    }
    const file = path.resolve(root, name);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`--out ${name} does not stay inside ${root}.`);
    const lock = `${file}.lock`;
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") throw new Error(`Another qualification run holds ${file} (${lock}); remove that lock only once no run uses it.`);
      throw error;
    });
    return new ReceiptSlot(file, lock);
  }

  /** Remove the receipt held under the name, if any: any earlier one, or only runId's. Anything else is put back and the call throws. */
  async withdraw(runId?: string): Promise<void> {
    const taken = `${this.file}.${randomBytes(6).toString("hex")}.withdrawn`;
    try { await rename(this.file, taken); } catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    const entry = await lstat(taken);
    const held = entry.isFile() ? await readFile(taken, "utf8").then((text) => JSON.parse(text) as Partial<NetworkingQualificationReceipt> | null).catch(() => undefined) : undefined;
    if (held?.contract === NETWORKING_QUALIFICATION_CONTRACT && held.check === RECEIPT_CHECK && (runId === undefined || held.runId === runId)) {
      await rm(taken);
      return;
    }
    const what = runId === undefined ? "a networking qualification receipt" : `the receipt of run ${runId}`;
    if (await this.restore(taken, entry).then(() => true, () => false)) throw new Error(`${this.file} is not ${what}; it is left untouched.`);
    throw new Error(`${this.file} is not ${what}, and the name was taken again meanwhile; it is kept as ${taken}.`);
  }

  /** Write receipt with mode 0600, replacing only this run's earlier receipt; a reader sees a complete receipt or none. */
  async write(receipt: NetworkingQualificationReceipt): Promise<void> {
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
      await chmod(temporary, 0o600);
      await this.withdraw(receipt.runId);
      // A link never replaces an entry, so anything that took the name meanwhile is left as it is.
      await link(temporary, this.file).catch((error: unknown) => {
        if (errorCode(error) === "EEXIST") throw new Error(`${this.file} was taken while the receipt was written; it is left untouched.`);
        throw error;
      });
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async release(): Promise<void> { await rm(this.lock, { force: true }); }

  /** For an exit that cannot wait for release. */
  releaseSync(): void { rmSync(this.lock, { force: true }); }

  /** Put a taken entry back under the name, failing rather than replacing anything that is there now. */
  private async restore(taken: string, entry: Stats): Promise<void> {
    if (entry.isFile()) await link(taken, this.file);
    else if (entry.isSymbolicLink()) await symlink(await readlink(taken), this.file);
    else if (entry.isDirectory()) { await mkdir(this.file); await rename(taken, this.file); return; }
    else throw new Error(`cannot restore ${taken}`);
    await rm(taken);
  }
}
