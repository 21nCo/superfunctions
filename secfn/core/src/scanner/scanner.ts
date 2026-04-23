import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { glob } from "glob";
import type { RulePack, ScanTarget, SecurityFinding } from "../types.js";
import { defaultSecretRulePack } from "./rules.js";

const execFileAsync = promisify(execFile);

export interface SecurityScannerOptions {
  rulePacks?: RulePack[];
  excludePaths?: string[];
  maxFileSize?: number;
}

export interface ScanDirectoryOptions {
  saveContent?: false;
}

export interface GitHistoryScanOptions {
  commits?: number;
  branch?: string;
}

export class SecurityScanner {
  private readonly rulePacks: RulePack[];
  private readonly excludePaths: string[];
  private readonly maxFileSize: number;

  constructor(options: SecurityScannerOptions = {}) {
    this.rulePacks = options.rulePacks ?? [defaultSecretRulePack];
    this.excludePaths = options.excludePaths ?? [
      "node_modules/**",
      "dist/**",
      "build/**",
      ".git/**",
      ".next/**",
      "coverage/**",
    ];
    this.maxFileSize = options.maxFileSize ?? 1024 * 1024;
  }

  scanContent(content: string, target: ScanTarget): SecurityFinding[] {
    return this.rulePacks.flatMap((pack) =>
      pack.rules.flatMap((rule) => rule.evaluate({ content, target })),
    );
  }

  async scanFile(filePath: string): Promise<SecurityFinding[]> {
    const content = await readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > this.maxFileSize) {
      return [];
    }
    return this.scanContent(content, { path: filePath });
  }

  async scanDirectory(dir: string): Promise<SecurityFinding[]> {
    const files = await glob("**/*", {
      cwd: dir,
      absolute: true,
      nodir: true,
      ignore: this.excludePaths,
    });
    const findings: SecurityFinding[] = [];
    for (const file of files) {
      try {
        findings.push(...await this.scanFile(file));
      } catch {
        // Binary/unreadable files are ignored by design.
      }
    }
    return findings;
  }

  async scanGitHistory(options: GitHistoryScanOptions = {}): Promise<SecurityFinding[]> {
    const commits = String(options.commits ?? 100);
    const branch = options.branch ?? "HEAD";
    const { stdout } = await execFileAsync("git", ["log", branch, `-n${commits}`, "--format=%H"]);
    const findings: SecurityFinding[] = [];
    for (const hash of stdout.split("\n").filter(Boolean)) {
      const shown = await execFileAsync("git", ["show", "--format=medium", "--no-ext-diff", hash]);
      const commitFindings = this.scanContent(shown.stdout, {
        path: `commit:${hash}`,
        displayPath: `commit:${hash.slice(0, 12)}`,
      });
      for (const finding of commitFindings) {
        finding.metadata = { ...(finding.metadata ?? {}), commit: hash };
      }
      findings.push(...commitFindings);
    }
    return findings;
  }
}

export function createSecurityScanner(options?: SecurityScannerOptions): SecurityScanner {
  return new SecurityScanner(options);
}
