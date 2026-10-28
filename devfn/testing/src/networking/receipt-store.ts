import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NETWORKING_QUALIFICATION_CONTRACT } from "./matrix.js";
import { RECEIPT_CHECK, type NetworkingQualificationReceipt } from "./receipt.js";

/** The harness-owned directory every run receipt and operator approval is kept in. */
export const receiptRoot = (): string => path.join(os.homedir(), ".devfn-networking-qualification");

/** A plain file name for a receipt or an approval in the harness directory, never a path. */
export const HARNESS_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.json$/;

/** The path of name in root, or undefined unless name is a plain harness file name that stays inside root. */
export function harnessFile(root: string, name: string): string | undefined {
  if (!HARNESS_FILE_NAME.test(name)) return undefined;
  const file = path.resolve(root, name);
  return file.startsWith(`${path.resolve(root)}${path.sep}`) ? file : undefined;
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Accept root only as a real directory of this user that nobody else can
 * write; with create, a missing root is created with mode 0700 first.
 */
export async function ownedDirectory(root: string, create: boolean): Promise<void> {
  if (create) await mkdir(root, { mode: 0o700 }).catch((error: unknown) => { if (errorCode(error) !== "EEXIST") throw error; });
  const entry = await lstat(root);
  if (!entry.isDirectory() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) {
    throw new Error(`${root} is not a harness-owned receipt directory (a directory, not a symlink, of this user with mode 0700).`);
  }
}

/**
 * One receipt name in the harness-owned receipt directory, held by one run
 * attempt. The directory is created with mode 0700 and accepted only as a
 * real directory of this user that nobody else can write, and the name is
 * claimed with an exclusive lock, so no other run withdraws or replaces its
 * receipt. Every removal and replacement acts on the entry it took, never on
 * an earlier check of the name: whatever is not this harness's receipt is
 * put back and never overwritten. Each withdrawal and write runs without
 * yielding, so a signal handler never finds one half done.
 */
export class ReceiptSlot {
  private constructor(readonly file: string, private readonly lock: string) {}

  /** Claim name in root; throws when the name or root is not the harness's own, or another run holds the name. */
  static async claim(name: string, root = receiptRoot()): Promise<ReceiptSlot> {
    const file = harnessFile(root, name);
    if (!file) throw new Error(`--out ${name} is not a receipt file name such as macos.json; receipts are kept in ${root}.`);
    await ownedDirectory(root, true);
    const lock = `${file}.lock`;
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") throw new Error(`Another qualification run holds ${file} (${lock}); remove that lock only once no run uses it.`);
      throw error;
    });
    return new ReceiptSlot(file, lock);
  }

  /** Remove the receipt held under the name, if any: any earlier one, or only runId's. Anything else is put back and the call throws. */
  async withdraw(runId?: string): Promise<void> { this.withdrawSync(runId); }

  /** Write receipt with mode 0600, replacing only this run's earlier receipt; a reader sees a complete receipt or none. */
  async write(receipt: NetworkingQualificationReceipt): Promise<void> {
    const temporary = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", flush: true });
      chmodSync(temporary, 0o600);
      this.withdrawSync(receipt.runId);
      // A link never replaces an entry, so anything that took the name meanwhile is left as it is.
      try { linkSync(temporary, this.file); } catch (error) {
        if (errorCode(error) === "EEXIST") throw new Error(`${this.file} was taken while the receipt was written; it is left untouched.`);
        throw error;
      }
    } finally { try { rmSync(temporary, { force: true }); } catch { /* a private name; the write's own outcome is what counts */ } }
  }

  async release(): Promise<void> { this.releaseSync(); }

  releaseSync(): void { rmSync(this.lock, { force: true }); }

  /**
   * For an exit that cannot wait: withdraw runId's receipt, then release the
   * claim. Returns what could not be done, so the caller reports it.
   */
  abandonSync(runId: string): string[] {
    const problems: string[] = [];
    try { this.withdrawSync(runId); } catch (error) { problems.push(`the receipt ${this.file} could not be withdrawn and is not evidence: ${error instanceof Error ? error.message : String(error)}`); }
    try { this.releaseSync(); } catch (error) { problems.push(`the lock ${this.lock} could not be removed: ${error instanceof Error ? error.message : String(error)}`); }
    return problems;
  }

  private withdrawSync(runId?: string): void {
    const taken = `${this.file}.${randomBytes(6).toString("hex")}.withdrawn`;
    try { renameSync(this.file, taken); } catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    const entry = lstatSync(taken);
    let held: Partial<NetworkingQualificationReceipt> | null | undefined;
    try { held = entry.isFile() ? JSON.parse(readFileSync(taken, "utf8")) as Partial<NetworkingQualificationReceipt> | null : undefined; } catch { held = undefined; }
    if (held?.contract === NETWORKING_QUALIFICATION_CONTRACT && held.check === RECEIPT_CHECK && (runId === undefined || held.runId === runId)) {
      rmSync(taken);
      return;
    }
    const what = runId === undefined ? "a networking qualification receipt" : `the receipt of run ${runId}`;
    try { this.restore(taken, entry); } catch { throw new Error(`${this.file} is not ${what}, and the name was taken again meanwhile; it is kept as ${taken}.`); }
    throw new Error(`${this.file} is not ${what}; it is left untouched.`);
  }

  /**
   * Put a taken entry back under the name, failing rather than replacing
   * anything that is there now. A file, FIFO, socket or device is linked
   * back without being opened, so none of them is read or waited on.
   */
  private restore(taken: string, entry: Stats): void {
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(taken), this.file);
    else if (entry.isDirectory()) { mkdirSync(this.file); renameSync(taken, this.file); return; }
    else linkSync(taken, this.file);
    rmSync(taken);
  }
}
