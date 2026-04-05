import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { Logger } from '../utils/logger.js';

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
  scripts?: Record<string, string>;
}

export class WorkspaceManager {
  private workspaceRoot: string | null = null;
  private workspacePackages: Map<string, string> = new Map();

  async detectWorkspace(cwd: string): Promise<boolean> {
    let currentDir = cwd;
    const root = resolve('/');

    while (currentDir !== root) {
      const pkgPath = join(currentDir, 'package.json');
      
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
        
        if (pkg.workspaces) {
          this.workspaceRoot = currentDir;
          await this.indexWorkspacePackages();
          return true;
        }
      }
      
      currentDir = dirname(currentDir);
    }

    return false;
  }

  private async indexWorkspacePackages(): Promise<void> {
    if (!this.workspaceRoot) return;

    const rootPkg = this.readPackageJson(this.workspaceRoot);
    if (!rootPkg?.workspaces) return;

    const workspaces = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : rootPkg.workspaces.packages;

    const glob = await import('fast-glob');
    
    for (const pattern of workspaces) {
      const matches = await glob.default(join(this.workspaceRoot, pattern, 'package.json'), {
        absolute: true,
      });

      for (const pkgPath of matches) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
        if (pkg.name) {
          this.workspacePackages.set(pkg.name, dirname(pkgPath));
        }
      }
    }
  }

  getWorkspaceDependencies(servicePath: string): string[] {
    const pkg = this.readPackageJson(servicePath);
    if (!pkg) return [];

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    const workspaceDeps: string[] = [];

    for (const [depName, depVersion] of Object.entries(allDeps)) {
      if (depVersion === '*' || depVersion === 'workspace:*' || depVersion.startsWith('workspace:')) {
        if (this.workspacePackages.has(depName)) {
          workspaceDeps.push(depName);
        }
      }
    }

    return workspaceDeps;
  }

  async bundleWorkspaceDependencies(servicePath: string, targetDir: string): Promise<void> {
    const workspaceDeps = this.getWorkspaceDependencies(servicePath);
    
    if (workspaceDeps.length === 0) {
      return;
    }

    Logger.info(`Bundling ${workspaceDeps.length} workspace dependencies...`);

    // Store workspace deps in __workspace__/ (not node_modules/) so they are:
    // 1. Included in the main rsync (not excluded like node_modules)
    // 2. Not wiped out when npm ci/install cleans node_modules
    const workspaceDir = join(targetDir, '__workspace__');
    mkdirSync(workspaceDir, { recursive: true });
    
    for (const depName of workspaceDeps) {
      const depPath = this.workspacePackages.get(depName);
      if (!depPath) continue;

      const depPkg = this.readPackageJson(depPath);
      if (depPkg?.scripts?.build) {
        Logger.log(`  → Building ${depName}...`);
        try {
          const { execSync } = await import('child_process');
          execSync('npm run build', { cwd: depPath, stdio: 'ignore' });
        } catch (error) {
          Logger.warn(`  ⚠ Failed to build ${depName}, bundling as-is`);
        }
      }

      const targetDepDir = join(workspaceDir, depName);
      
      mkdirSync(dirname(targetDepDir), { recursive: true });

      cpSync(depPath, targetDepDir, {
        recursive: true,
        filter: (src) => {
          const relativePath = src.replace(depPath, '');
          return !relativePath.includes('node_modules') &&
                 !relativePath.includes('.git');
        },
      });

      Logger.log(`  ✓ Bundled ${depName}`);
    }
  }

  async generateLockfile(targetDir: string): Promise<void> {
    const { execSync } = await import('child_process');
    const pkgJsonPath = join(targetDir, 'package.json');

    // Temporarily pin direct dependencies to their exact resolved versions from the
    // root monorepo lockfile. Without this, `npm install --package-lock-only` would
    // re-resolve all dependencies from the npm registry and may pick up newer
    // (potentially breaking) versions (e.g. better-auth 1.3.x → 1.5.x).
    //
    // We pin direct deps only (not transitive). Overriding transitive deps causes
    // EUSAGE errors from `npm ci` because the lockfile's transitive versions may no
    // longer match what the pinned direct dep's own package.json requires.
    let originalPkgJson: string | null = null;
    if (this.workspaceRoot) {
      const rootLockfilePath = join(this.workspaceRoot, 'package-lock.json');
      if (existsSync(rootLockfilePath)) {
        try {
          const rootLockfile = JSON.parse(readFileSync(rootLockfilePath, 'utf-8'));
          originalPkgJson = readFileSync(pkgJsonPath, 'utf-8');
          const pkg = JSON.parse(originalPkgJson);

          // Build a lookup from package name → resolved version in the root lockfile.
          // Skip npm alias packages (where the lockfile entry's `name` field differs
          // from the path-derived name, e.g. `string-width-cjs` → `string-width`).
          const rootVersions: Record<string, string> = {};
          for (const [pkgPath, pkgEntry] of Object.entries(
            (rootLockfile.packages || {}) as Record<string, { version?: string; name?: string }>
          )) {
            const match = pkgPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/);
            if (match && pkgEntry.version) {
              const pkgName = match[1];
              if (pkgEntry.name !== undefined && pkgEntry.name !== pkgName) continue;
              rootVersions[pkgName] = pkgEntry.version;
            }
          }

          // Replace semver ranges in direct deps with the exact resolved version.
          // This prevents npm from upgrading direct deps when generating the lockfile.
          for (const depGroup of ['dependencies', 'devDependencies'] as const) {
            for (const depName of Object.keys(pkg[depGroup] || {})) {
              const exactVersion = rootVersions[depName];
              if (exactVersion) {
                pkg[depGroup]![depName] = exactVersion;
              }
            }
          }

          writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
        } catch {
          originalPkgJson = null; // Fall through without pinning
        }
      }
    }

    try {
      execSync('npm install --package-lock-only --ignore-scripts', {
        cwd: targetDir,
        stdio: 'ignore',
      });
    } finally {
      // Restore package.json without overrides. The server uses `npm ci` which
      // reads the lockfile directly and ignores overrides, so the overrides
      // only need to be present during lockfile generation.
      if (originalPkgJson !== null) {
        writeFileSync(pkgJsonPath, originalPkgJson);
      }
    }
  }

  rewritePackageJson(servicePath: string, targetDir: string): void {
    const workspaceDeps = this.getWorkspaceDependencies(servicePath);
    
    if (workspaceDeps.length === 0) {
      return;
    }

    const pkgPath = join(targetDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;

    if (pkg.dependencies) {
      for (const depName of workspaceDeps) {
        if (pkg.dependencies[depName]) {
          pkg.dependencies[depName] = `file:./__workspace__/${depName}`;
        }
      }
    }

    if (pkg.devDependencies) {
      for (const depName of workspaceDeps) {
        if (pkg.devDependencies[depName]) {
          delete pkg.devDependencies[depName];
        }
      }
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }

  private readPackageJson(dir: string): PackageJson | null {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  getWorkspaceRoot(): string | null {
    return this.workspaceRoot;
  }

  isInWorkspace(): boolean {
    return this.workspaceRoot !== null;
  }
}
