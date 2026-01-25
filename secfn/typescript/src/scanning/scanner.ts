import { readFile } from 'fs/promises';
import { glob } from 'glob';
import simpleGit, { type SimpleGit } from 'simple-git';
import type { SecretPattern, SecretScanResult } from '../types/index.js';
import type { IndexedDBStorage } from '../storage/indexeddb-storage.js';
import { DEFAULT_PATTERNS } from './patterns.js';
import { generateId, calculateEntropy, redactSecret } from '../utils/helpers.js';

export interface SecretScannerConfig {
  patterns?: SecretPattern[];
  excludePaths?: string[];
  minEntropy?: number;
  maxFileSize?: number;
  storage?: IndexedDBStorage;
}

export interface ScanOptions {
  saveResults?: boolean;
}

export interface GitScanOptions {
  branch?: string;
  commits?: number;
}

export class SecretScanner {
  private patterns: SecretPattern[];
  private excludePaths: string[];
  private minEntropy: number;
  private maxFileSize: number;
  private storage?: IndexedDBStorage;
  private git: SimpleGit;

  constructor(config: SecretScannerConfig = {}) {
    this.patterns = config.patterns || DEFAULT_PATTERNS;
    this.excludePaths = config.excludePaths || ['node_modules/**', 'dist/**', 'build/**', '.git/**'];
    this.minEntropy = config.minEntropy || 3.0;
    this.maxFileSize = config.maxFileSize || 1024 * 1024;
    this.storage = config.storage;
    this.git = simpleGit();
  }

  async scanDirectory(dir: string, options: ScanOptions = {}): Promise<SecretScanResult[]> {
    const files = await glob('**/*', {
      cwd: dir,
      absolute: true,
      nodir: true,
      ignore: this.excludePaths,
    });

    const results: SecretScanResult[] = [];

    for (const file of files) {
      try {
        const fileResults = await this.scanFile(file);
        results.push(...fileResults);
      } catch (error) {
        console.error(`[SecFn] Error scanning file ${file}:`, error);
      }
    }

    if (options.saveResults && this.storage) {
      for (const result of results) {
        await this.storage.saveScanResult(result);
      }
    }

    return results;
  }

  async scanFile(filePath: string): Promise<SecretScanResult[]> {
    try {
      const content = await readFile(filePath, 'utf-8');
      
      if (content.length > this.maxFileSize) {
        console.warn(`[SecFn] Skipping large file: ${filePath}`);
        return [];
      }

      return this.scanContent(content, filePath);
    } catch (error) {
      console.error(`[SecFn] Error reading file ${filePath}:`, error);
      return [];
    }
  }

  scanContent(content: string, filePath: string): SecretScanResult[] {
    const results: SecretScanResult[] = [];
    const lines = content.split('\n');

    for (const pattern of this.patterns) {
      const matches = content.matchAll(pattern.pattern);

      for (const match of matches) {
        if (!match[0] || !match.index) continue;

        const matchedSecret = match[1] || match[0];
        const entropy = calculateEntropy(matchedSecret);

        if (pattern.entropy && entropy < Math.min(pattern.entropy, this.minEntropy)) {
          continue;
        }

        const { line, column } = this.getLineAndColumn(content, match.index);
        const context = this.getContext(lines, line);

        const result: SecretScanResult = {
          id: generateId('scan'),
          timestamp: Date.now(),
          file: filePath,
          line,
          column,
          pattern: pattern.name,
          match: matchedSecret,
          redactedMatch: redactSecret(matchedSecret),
          severity: pattern.severity,
          entropy,
          context,
          resolved: false,
          falsePositive: false,
        };

        results.push(result);
      }
    }

    return results;
  }

  async scanGitHistory(options: GitScanOptions = {}): Promise<SecretScanResult[]> {
    const branch = options.branch || 'HEAD';
    const commitCount = options.commits || 100;

    const log = await this.git.log([branch, `-n`, `${commitCount}`]);
    const results: SecretScanResult[] = [];

    for (const commit of log.all) {
      try {
        const diff = await this.git.show([commit.hash]);
        const commitResults = this.scanContent(diff, `commit:${commit.hash.substring(0, 7)}`);
        
        for (const result of commitResults) {
          result.metadata = {
            commit: commit.hash,
            author: commit.author_name,
            date: commit.date,
            message: commit.message,
          };
        }

        results.push(...commitResults);
      } catch (error) {
        console.error(`[SecFn] Error scanning commit ${commit.hash}:`, error);
      }
    }

    if (this.storage) {
      for (const result of results) {
        await this.storage.saveScanResult(result);
      }
    }

    return results;
  }

  addPattern(pattern: SecretPattern): void {
    this.patterns.push(pattern);
  }

  removePattern(name: string): void {
    this.patterns = this.patterns.filter(p => p.name !== name);
  }

  getPatterns(): SecretPattern[] {
    return [...this.patterns];
  }

  private getLineAndColumn(content: string, index: number): { line: number; column: number } {
    const beforeMatch = content.substring(0, index);
    const lines = beforeMatch.split('\n');
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    
    return { line, column };
  }

  private getContext(lines: string[], lineNumber: number, contextLines = 2): string {
    const start = Math.max(0, lineNumber - contextLines - 1);
    const end = Math.min(lines.length, lineNumber + contextLines);
    return lines.slice(start, end).join('\n');
  }

  async getScanHistory(limit = 100): Promise<SecretScanResult[]> {
    if (!this.storage) {
      throw new Error('Storage not configured');
    }
    return await this.storage.getScanHistory(limit);
  }
}
