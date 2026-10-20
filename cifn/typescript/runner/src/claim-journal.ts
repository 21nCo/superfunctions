import { mkdirSync, chmodSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, readdirSync, existsSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ClaimIdentity, JobCompletion } from '@cifn/control-plane';

export interface ClaimJournalEntry extends ClaimIdentity {
  version: 1;
  phase: 'prepared' | 'started' | 'completed' | 'finished' | 'reconciliation';
  result?: JobCompletion;
}
/** Contains identity/results only; never stores job payload, environment, or logs. */
export class ClaimJournal {
  constructor(private directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
  private path(dispatchId: string): string { return join(this.directory, createHash('sha256').update(dispatchId).digest('hex')); }
  private syncDirectory(): void { const fd = openSync(this.directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  get(dispatchId: string): ClaimJournalEntry | undefined {
    const path = this.path(dispatchId) + '.json';
    return existsSync(path) ? this.read(path) : undefined;
  }
  private read(path: string): ClaimJournalEntry {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ClaimJournalEntry;
    if (value.version !== 1 || typeof value.dispatchId !== 'string' || typeof value.executionId !== 'string' || !['prepared', 'started', 'completed', 'finished', 'reconciliation'].includes(value.phase)) throw new Error('Claim journal needs explicit repair');
    return value;
  }
  list(): ClaimJournalEntry[] { return readdirSync(this.directory).filter(name => name.endsWith('.json')).map(name => this.read(join(this.directory, name))); }
  save(entry: ClaimJournalEntry, createOnly = false): ClaimJournalEntry {
    const path = this.path(entry.dispatchId) + '.json';
    const temporary = path + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(entry)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      if (createOnly) {
        try { linkSync(temporary, path); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
        unlinkSync(temporary);
      } else renameSync(temporary, path);
      this.syncDirectory();
      return this.read(path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  hasStarted(dispatchId: string): boolean { return existsSync(this.path(dispatchId) + '.started'); }
  markStarted(entry: ClaimJournalEntry): boolean {
    let fd: number;
    try { fd = openSync(this.path(entry.dispatchId) + '.started', 'wx', 0o600); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false; throw cause; }
    try { writeFileSync(fd, entry.executionId); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory();
    this.save({ ...entry, phase: 'started' });
    return true;
  }
}
