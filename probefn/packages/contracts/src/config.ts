import { existsSync } from 'node:fs';
import path from 'node:path';

import { createJiti } from 'jiti';
import { z } from 'zod';

import { createProbefnError, type ProbefnError } from './errors.js';

const browserEngineSchema = z.enum(['chromium', 'firefox', 'webkit']);
const sessionModeSchema = z.enum(['debug', 'design-review', 'visual-regression', 'mixed']);
const devServerModeSchema = z.enum(['attach', 'spawn']);
const colorSchemeSchema = z.enum(['light', 'dark']);
const reducedMotionSchema = z.enum(['reduce', 'no-preference']);
const animationPolicySchema = z.enum(['freeze', 'allow']);

function isRepositoryRelativePath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  if (path.isAbsolute(value) || value.startsWith('~')) {
    return false;
  }

  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function repositoryRelativePathSchema(fieldName: string, defaultValue: string) {
  return z
    .string()
    .trim()
    .prefault(defaultValue)
    .superRefine((value, context) => {
      if (!isRepositoryRelativePath(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} must be a repository-relative path.`,
        });
      }
    });
}

const deterministicSettingsSchema = z.object({
  enabled: z.boolean().prefault(true),
  viewport: z.object({
    width: z.number().int().positive().prefault(1440),
    height: z.number().int().positive().prefault(900),
  }).prefault({ width: 1440, height: 900 }),
  locale: z.string().trim().min(1).prefault('en-US'),
  timezone: z.string().trim().min(1).prefault('UTC'),
  colorScheme: colorSchemeSchema.prefault('light'),
  reducedMotion: reducedMotionSchema.prefault('reduce'),
  animationPolicy: animationPolicySchema.prefault('freeze'),
  networkIdleMs: z.number().int().positive().prefault(500),
});

const devServerSpecSchema = z
  .object({
    mode: devServerModeSchema,
    name: z.string().trim().min(1),
    command: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    url: z.string().trim().url().optional(),
    readyPattern: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().prefault(120000),
    envAllowlist: z.array(z.string().trim().min(1)).prefault([]),
  })
  .superRefine((value, context) => {
    if (value.mode === 'spawn' && !value.command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Spawn dev servers require a command.',
        path: ['command'],
      });
    }

    if (value.cwd && !isRepositoryRelativePath(value.cwd)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cwd must be a repository-relative path.',
        path: ['cwd'],
      });
    }

    if (!value.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Dev servers require a reachable url.',
        path: ['url'],
      });
    }
  });

const probefnConfigSchema = z.object({
  schemaVersion: z.literal('1.0').prefault('1.0'),
  projectName: z.string().trim().min(1).optional(),
  artifactRoot: repositoryRelativePathSchema('artifactRoot', '.artifacts'),
  baselineRoot: repositoryRelativePathSchema('baselineRoot', '.artifacts/baselines'),
  defaultBrowser: browserEngineSchema.prefault('chromium'),
  defaultMode: sessionModeSchema.prefault('mixed'),
  devServers: z.record(z.string(), devServerSpecSchema).prefault({}),
  analyzers: z.record(z.string(), z.unknown()).optional(),
  redaction: z.record(z.string(), z.unknown()).optional(),
  storageCaps: z.object({
    maxArtifactBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    maxEventsPerSink: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxOwnershipSlots: z.number().int().min(2).max(65536).optional(),
    maxAccountingDatabaseBytes: z.number().int().min(65536).max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict().optional(),
  deterministicDefaults: deterministicSettingsSchema.prefault({}),
});

export type BrowserEngine = z.infer<typeof browserEngineSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type DevServerMode = z.infer<typeof devServerModeSchema>;
export type DeterministicSettings = z.infer<typeof deterministicSettingsSchema>;
export type DevServerSpec = z.infer<typeof devServerSpecSchema>;
export type ProbefnConfig = z.infer<typeof probefnConfigSchema>;

export interface LoadConfigOptions {
  cwd?: string;
}

export function defineConfig(config: ProbefnConfig): ProbefnConfig {
  return config;
}

export function validateConfig(input: unknown): ProbefnConfig {
  const parsed = probefnConfigSchema.safeParse(input);

  if (!parsed.success) {
    throw formatConfigError(parsed.error, input);
  }

  return parsed.data;
}

export async function loadConfig(
  configPath: string,
  options: LoadConfigOptions = {},
): Promise<ProbefnConfig> {
  const cwd = options.cwd ?? process.cwd();
  const absoluteConfigPath = path.resolve(cwd, configPath);

  if (!existsSync(absoluteConfigPath)) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Config file ${configPath} does not exist.`,
      retryable: false,
      details: {
        configPath,
      },
    });
  }

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
  });

  let loadedModule: unknown;

  try {
    loadedModule = await jiti.import(absoluteConfigPath);
  } catch (error) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Could not load config file ${configPath}.`,
      retryable: false,
      details: {
        configPath,
      },
      cause: error,
    });
  }

  const rawConfig =
    loadedModule &&
    typeof loadedModule === 'object' &&
    'default' in loadedModule
      ? (loadedModule as { default: unknown }).default
      : loadedModule;

  return validateConfig(rawConfig);
}

function formatConfigError(error: z.ZodError, input: unknown): ProbefnError {
  const primaryIssue = error.issues[0];
  const issuePath = primaryIssue?.path.join('.') ?? '';

  if (issuePath === 'defaultBrowser') {
    const browserValue =
      typeof input === 'object' && input !== null && 'defaultBrowser' in input
        ? String((input as { defaultBrowser: unknown }).defaultBrowser)
        : 'unknown';

    return createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Invalid browser engine "${browserValue}" in probefn config.`,
      retryable: false,
      details: {
        path: issuePath,
      },
    });
  }

  if (issuePath.endsWith('timeoutMs')) {
    return createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'timeoutMs must be a positive integer in probefn config.',
      retryable: false,
      details: {
        path: issuePath,
      },
    });
  }

  if (issuePath === 'artifactRoot' || issuePath === 'baselineRoot') {
    return createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `${issuePath} must be a repository-relative path.`,
      retryable: false,
      details: {
        path: issuePath,
      },
    });
  }

  return createProbefnError({
    code: 'E_CONFIG_INVALID',
    message: primaryIssue?.message ?? 'Probefn config validation failed.',
    retryable: false,
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}
