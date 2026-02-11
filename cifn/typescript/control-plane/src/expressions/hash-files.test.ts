import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFiles } from './hash-files.js';

describe('hashFiles', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'cifn-hash-'));
  });

  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TV-EXPR-007: returns same hash for same file contents (deterministic)', () => {
    const filePath = join(workspace, 'package-lock.json');
    writeFileSync(filePath, '"abc"\n');
    const hash1 = hashFiles(workspace, 'package-lock.json');
    const hash2 = hashFiles(workspace, 'package-lock.json');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('TV-EXPR-007: different file contents produce different hash', () => {
    writeFileSync(join(workspace, 'a.txt'), 'content1');
    const hash1 = hashFiles(workspace, 'a.txt');
    writeFileSync(join(workspace, 'a.txt'), 'content2');
    const hash2 = hashFiles(workspace, 'a.txt');
    expect(hash1).not.toBe(hash2);
  });

  it('no matches returns hash of empty string (deterministic)', () => {
    const hash1 = hashFiles(workspace, 'nonexistent*.xyz');
    const hash2 = hashFiles(workspace, 'nonexistent*.xyz');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });
});
