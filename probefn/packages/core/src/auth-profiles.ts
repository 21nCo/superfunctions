import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError } from '@probefn/contracts/errors';
import { ArtifactStore, assertArtifactIdentifier, assertRepositoryRelativePath } from '@probefn/storage';

export interface PlaywrightStorageState {
  cookies: unknown[];
  origins: unknown[];
}

export interface AuthProfileStoreOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
}

export interface SavedAuthProfile {
  profileId: string;
  storageStatePath: string;
}

export interface LoadedAuthProfile extends SavedAuthProfile {
  storageState: PlaywrightStorageState;
}

export class AuthProfileStore {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;

  public constructor(options: AuthProfileStoreOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
  }

  public getProfileStorageStatePath(profileId: string): string {
    return path.posix.join(
      this.artifactStore.getArtifactRoot(),
      'auth-profiles',
      sanitizeSegment(profileId),
      'storage-state.json',
    );
  }

  public getSessionStorageStatePath(runId: string): string {
    return path.posix.join(
      this.artifactStore.getRunPaths(runId).runRoot,
      'session-storage',
      'storage-state.json',
    );
  }

  public async saveProfile(
    input: {
      profileId: string;
      storageState: PlaywrightStorageState;
    },
  ): Promise<SavedAuthProfile> {
    const storageStatePath = this.getProfileStorageStatePath(input.profileId);
    await this.writeJson(storageStatePath, input.storageState);
    return {
      profileId: input.profileId,
      storageStatePath,
    };
  }

  public async saveProfileFromPath(
    input: {
      profileId: string;
      sourceStorageStatePath: string;
    },
  ): Promise<SavedAuthProfile> {
    const storageStatePath = this.getProfileStorageStatePath(input.profileId);
    await this.assertExists(input.sourceStorageStatePath, 'sourceStorageStatePath');
    await this.copyRepoRelativeFile(input.sourceStorageStatePath, storageStatePath);
    return {
      profileId: input.profileId,
      storageStatePath,
    };
  }

  public async loadProfile(profileId: string): Promise<LoadedAuthProfile> {
    const storageStatePath = this.getProfileStorageStatePath(profileId);
    try {
      const storageState = JSON.parse(
        await readFile(path.resolve(this.repoRoot, storageStatePath), 'utf8'),
      ) as PlaywrightStorageState;
      return {
        profileId,
        storageStatePath,
        storageState,
      };
    } catch (error) {
      if (isMissing(error)) {
        throw createProbefnError({
          code: 'E_AUTH_PROFILE_NOT_FOUND',
          message: `Auth profile ${profileId} was not found.`,
          retryable: false,
          details: {
            authProfileId: profileId,
          },
        });
      }

      throw error;
    }
  }

  public async initializeSessionStorageFromProfile(
    input: {
      profileId: string;
      runId: string;
    },
  ): Promise<SavedAuthProfile> {
    const storageStatePath = this.getSessionStorageStatePath(input.runId);
    const loaded = await this.loadProfile(input.profileId);
    await this.artifactStore.importArtifactFile(storageStatePath, path.resolve(this.repoRoot, loaded.storageStatePath));
    return {
      profileId: input.profileId,
      storageStatePath,
    };
  }

  public async writeSessionStorageState(
    input: {
      runId: string;
      storageState: PlaywrightStorageState;
    },
  ): Promise<string> {
    const storageStatePath = this.getSessionStorageStatePath(input.runId);
    await this.artifactStore.writeArtifact(storageStatePath, `${JSON.stringify(input.storageState, null, 2)}\n`);
    return storageStatePath;
  }

  public async hasStorageStatePath(storageStatePath: string | undefined): Promise<boolean> {
    if (!storageStatePath) {
      return false;
    }

    try {
      await this.assertExists(storageStatePath, 'storageStatePath');
      return true;
    } catch (error) {
      const probefnError =
        error &&
        typeof error === 'object' &&
        'code' in error
          ? (error as { code?: string })
          : null;
      if (probefnError?.code === 'E_STORAGE_WRITE_FAILED') {
        return false;
      }

      throw error;
    }
  }

  private async writeJson(relativePath: string, value: PlaywrightStorageState): Promise<void> {
    const absolutePath = path.resolve(this.repoRoot, relativePath);
    await mkdir(path.dirname(absolutePath), {
      recursive: true,
    });
    await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  private async copyRepoRelativeFile(sourceRelativePath: string, targetRelativePath: string): Promise<void> {
    assertRepositoryRelativePath(sourceRelativePath);
    assertRepositoryRelativePath(targetRelativePath);
    const targetPath = path.resolve(this.repoRoot, targetRelativePath);
    await mkdir(path.dirname(targetPath), {
      recursive: true,
    });
    await copyFile(
      path.resolve(this.repoRoot, sourceRelativePath),
      targetPath,
    );
  }

  private async assertExists(relativePath: string, pathLabel: string): Promise<void> {
    assertRepositoryRelativePath(relativePath);
    try {
      await access(path.resolve(this.repoRoot, relativePath));
    } catch (error) {
      throw createProbefnError({
        code: 'E_STORAGE_WRITE_FAILED',
        message: `${pathLabel} does not exist.`,
        retryable: false,
        details: {
          path: relativePath,
        },
        cause: error,
      });
    }
  }
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (sanitized.length === 0) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Auth profile identifiers must contain at least one safe character.',
      retryable: false,
    });
  }

  assertArtifactIdentifier(sanitized, 'Auth profile id');
  return sanitized;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
