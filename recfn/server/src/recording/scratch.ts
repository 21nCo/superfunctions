import { constants, type Stats, type Dir } from 'node:fs';
import { mkdir, open, opendir, realpath, lstat, readFile, readlink, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface Identity { host: string; boot: string; namespace: string }
interface RootMarker { version: 1; kind: 'recfn-scratch'; id: string; path: string }
interface Owner { version: 1; root: string; token: string; pid: number; identity: Identity | null }
export interface ScratchCleanupOptions { maxEntries?: number; maxBytes?: number; maxDurationMs?: number }
export interface ScratchCleanupReport {
  examined: number; removed: number; removedBytes: number; incomplete: boolean;
  skipped: Array<{ entry: string; reason: string }>;
}
export interface RecordingScratchOptions { directory: string; cleanup?: ScratchCleanupOptions }
const markerName = '.recfn-scratch.json';
const ownerName = 'owner.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const identityValid = (value: unknown): value is Identity => !!value && typeof value === 'object' && ['host', 'boot', 'namespace'].every(key => /^[0-9a-f]{64}$/.test((value as Record<string, string>)[key] ?? ''));
let identityPromise: Promise<Identity | null> | undefined;
/** Unsupported platforms retain scratch and report no-cleanup; capture itself remains portable. */
async function hostIdentity(): Promise<Identity | null> {
  return identityPromise ??= (async () => {
    try {
      if (process.platform === 'linux') {
        const [host, boot, namespace] = await Promise.all([readFile('/etc/machine-id', 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid')]);
        if (!/^[0-9a-f]{32}\s*$/i.test(host) || !/^[0-9a-f-]{36}\s*$/i.test(boot) || !/^pid:\[\d+\]$/.test(namespace)) return null;
        return { host: hash(host.trim()), boot: hash(boot.trim()), namespace: hash(namespace) };
      }
      if (process.platform === 'darwin') {
        const run = promisify(execFile);
        const [hardware, boot] = await Promise.all([
          run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 2000, maxBuffer: 128 * 1024 }),
          run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 2000, maxBuffer: 4096 }),
        ]);
        const host = /"IOPlatformUUID"\s*=\s*"([0-9A-F-]{36})"/i.exec(hardware.stdout)?.[1];
        const started = /sec = (\d+), usec = (\d+)/.exec(boot.stdout);
        if (!host || !started) return null;
        return { host: hash(host.toLowerCase()), boot: hash(`${started[1]}:${started[2]}`), namespace: hash('darwin-host-pid-namespace') };
      }
    } catch { /* No authority to reclaim on identity failure. */ }
    return null;
  })();
}
function privateStat(stat: Stats, directory: boolean): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.geteuid && stat.uid !== process.geteuid()) || (!directory && stat.nlink !== 1)) throw new Error('Scratch entry must be private, owned, and not a link.');
}
async function readJson(filename: string): Promise<unknown> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); privateStat(stat, false);
    if ((stat.mode & 0o222) !== 0) throw new Error('Scratch metadata must be read-only.');
    if (stat.size > 4096) throw new Error('Scratch metadata exceeds its bound.');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally { await file.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function writeJson(filename: string, value: unknown): Promise<void> {
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.chmod(0o400); await file.sync(); }
  finally { await file.close(); }
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('Invalid scratch budget.');
  return result;
}

/** Cooperating processes on a dedicated host-local filesystem; not an OS disk quota. */
export class RecordingScratch {
  public lastCleanup: ScratchCleanupReport = { examined: 0, removed: 0, removedBytes: 0, incomplete: false, skipped: [] };
  private scan?: Dir;
  private scanning = false;
  private closed = false;
  private constructor(public readonly directory: string, private readonly marker: RootMarker, private readonly identity: Identity | null, private readonly defaults: ScratchCleanupOptions, private readonly inode: { dev: number; ino: number }) {}
  public get supportsCleanup(): boolean { return this.identity !== null && !this.closed; }
  public static async create(options: RecordingScratchOptions): Promise<RecordingScratch> {
    const directory = resolve(options.directory);
    if (!process.geteuid || constants.O_NOFOLLOW === undefined) throw new Error('Managed scratch requires private no-follow filesystem support.');
    if (await realpath(dirname(directory)) !== dirname(directory)) throw new Error('Scratch parent must use its canonical path without symlinks.');
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; } catch (error) { if (code(error) !== 'EEXIST') throw error; }
    const stat = await lstat(directory); privateStat(stat, true);
    if (await realpath(directory) !== directory) throw new Error('Scratch directory must use its canonical path without symlinks.');
    if (created) {
      const marker: RootMarker = { version: 1, kind: 'recfn-scratch', id: randomUUID(), path: directory };
      await writeJson(join(directory, markerName), marker); await syncDirectory(directory);
    }
    const marker = await readJson(join(directory, markerName)) as RootMarker;
    if (marker?.version !== 1 || marker.kind !== 'recfn-scratch' || !uuid(marker.id) || marker.path !== directory) throw new Error('Scratch root marker does not match.');
    const manager = new RecordingScratch(directory, marker, await hostIdentity(), options.cleanup ?? {}, { dev: stat.dev, ino: stat.ino });
    manager.lastCleanup = await manager.cleanup();
    return manager;
  }
  private async verifyRoot(): Promise<void> {
    const stat = await lstat(this.directory); privateStat(stat, true);
    if (stat.dev !== this.inode.dev || stat.ino !== this.inode.ino || await realpath(this.directory) !== this.directory) throw new Error('Scratch root identity changed.');
    const marker = await readJson(join(this.directory, markerName)) as RootMarker;
    if (JSON.stringify(marker) !== JSON.stringify(this.marker)) throw new Error('Scratch root marker changed.');
  }
  private async inspect(name: string): Promise<{ owner: Owner; bytes: number; files: string[]; dev: number; ino: number }> {
    const directory = join(this.directory, name);
    const stat = await lstat(directory); privateStat(stat, true);
    const files: string[] = []; let bytes = 0;
    for await (const entry of await opendir(directory)) {
      if (![ownerName, 'recording.enc'].includes(entry.name) || files.length >= 2) throw new Error('Unexpected scratch entry; retained.');
      const info = await lstat(join(directory, entry.name)); privateStat(info, false); bytes += info.size; files.push(entry.name);
    }
    const owner = await readJson(join(directory, ownerName)) as Owner;
    if (owner?.version !== 1 || owner.root !== this.marker.id || !uuid(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || (owner.identity !== null && !identityValid(owner.identity))) throw new Error('Invalid or incomplete owner manifest; retained.');
    return { owner, bytes, files, dev: stat.dev, ino: stat.ino };
  }
  private dead(owner: Owner): string | null {
    if (!this.identity || !owner.identity) return 'unsupported-owner-identity';
    if (owner.identity.host !== this.identity.host) return 'foreign-host';
    if (owner.identity.boot !== this.identity.boot) return null;
    if (owner.identity.namespace !== this.identity.namespace) return 'foreign-pid-namespace';
    try { process.kill(owner.pid, 0); return 'owner-live-or-pid-reused'; }
    catch (error) { return code(error) === 'ESRCH' ? null : 'owner-liveness-unknown'; }
  }
  private async remove(name: string, inspected: Awaited<ReturnType<RecordingScratch['inspect']>>): Promise<void> {
    await this.verifyRoot();
    const current = await this.inspect(name);
    if (current.owner.token !== inspected.owner.token || current.dev !== inspected.dev || current.ino !== inspected.ino) throw new Error('Scratch owner changed; retained.');
    const quarantine = `retired-${randomUUID()}`;
    await rename(join(this.directory, name), join(this.directory, quarantine));
    // A failed removal remains discoverable and owned; never claim it was cleaned.
    const owned = join(this.directory, quarantine);
    for (const file of current.files.filter(file => file !== ownerName)) await unlink(join(owned, file));
    await unlink(join(owned, ownerName));
    await rmdir(owned);
  }
  public async allocate(): Promise<{ directory: string; dispose(): Promise<void> }> {
    if (this.closed) throw new Error('Recording scratch manager is closed.');
    await this.verifyRoot();
    // Never reuse a directory name: concurrent cleaners cannot rename a successor owner.
    const name = `capture-${randomUUID()}`;
    const directory = join(this.directory, name);
    await mkdir(directory, { mode: 0o700 });
    const owner: Owner = { version: 1, root: this.marker.id, token: randomUUID(), pid: process.pid, identity: this.identity };
    await writeJson(join(directory, ownerName), owner); await syncDirectory(directory); await syncDirectory(this.directory);
    const inspected = await this.inspect(name);
    let disposed: Promise<void> | undefined;
    return { directory, dispose: () => disposed ??= this.remove(name, inspected) };
  }
  /** Closes an unfinished scan; callers stop workers first. Retained artifacts keep their own disposal. */
  public async close(): Promise<void> {
    if (this.scanning) throw new Error('Scratch cleanup is busy; await it before closing.');
    this.closed = true; const scan = this.scan; this.scan = undefined; await scan?.close();
  }
  public async cleanup(options: ScratchCleanupOptions = {}): Promise<ScratchCleanupReport> {
    if (this.closed) throw new Error('Recording scratch manager is closed.');
    if (this.scanning) throw new Error('Scratch cleanup is already running.');
    const report: ScratchCleanupReport = { examined: 0, removed: 0, removedBytes: 0, incomplete: false, skipped: [] };
    const maxEntries = limit(options.maxEntries ?? this.defaults.maxEntries, 128, 4096);
    const maxBytes = limit(options.maxBytes ?? this.defaults.maxBytes, 8 * 1024 * 1024 * 1024, Number.MAX_SAFE_INTEGER);
    const maxMs = limit(options.maxDurationMs ?? this.defaults.maxDurationMs, 1000, 60_000);
    const started = performance.now(); this.scanning = true;
    try {
      await this.verifyRoot();
      this.scan ??= await opendir(this.directory);
      for (;;) {
        if (report.examined >= maxEntries || performance.now() - started >= maxMs) { report.incomplete = true; break; }
        const entry = await this.scan.read();
        if (!entry) { await this.scan.close(); this.scan = undefined; break; }
        if (entry.name === markerName) continue;
        report.examined++;
        if (!/^capture-[0-9a-f-]{36}$/.test(entry.name) && !/^retired-[0-9a-f-]{36}$/.test(entry.name)) { report.skipped.push({ entry: entry.name, reason: 'unmanaged-entry' }); continue; }
        try {
          const inspected = await this.inspect(entry.name);
          const reason = this.dead(inspected.owner);
          if (reason) { report.skipped.push({ entry: entry.name, reason }); continue; }
          if (report.removedBytes + inspected.bytes > maxBytes) { report.skipped.push({ entry: entry.name, reason: 'byte-budget' }); report.incomplete = true; continue; }
          await this.remove(entry.name, inspected); report.removed++; report.removedBytes += inspected.bytes;
        } catch (error) {
          report.skipped.push({ entry: entry.name, reason: code(error) === 'ENOENT' ? 'concurrent-cleanup' : error instanceof Error ? error.message : 'cleanup-failed' });
          report.incomplete = true;
        }
      }
      this.lastCleanup = report;
      return report;
    } catch (error) {
      const scan = this.scan; this.scan = undefined; await scan?.close(); throw error;
    } finally { this.scanning = false; }
  }
}
export const createRecordingScratch = (options: RecordingScratchOptions): Promise<RecordingScratch> => RecordingScratch.create(options);
