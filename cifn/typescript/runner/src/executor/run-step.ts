import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';

export interface RunStepResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  lines: string[];
}

export function executeRunStep(command: string, workspacePath: string, env?: Record<string, string>): RunStepResult {
  const execEnv = env ? { ...process.env, ...env } : process.env;
  try {
    const stdout = execSync(command, {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000,
      shell: '/bin/sh',
      env: execEnv,
    } satisfies ExecSyncOptionsWithStringEncoding);
    const lines = stdout.split('\n').filter(l => l !== '');
    return { exitCode: 0, stdout, stderr: '', lines };
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: string; stderr?: string };
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const exitCode = typeof error.status === 'number' ? error.status : 1;
    const lines = [
      ...stdout.split('\n').filter(l => l !== ''),
      ...stderr.split('\n').filter(l => l !== ''),
    ];
    return { exitCode, stdout, stderr, lines };
  }
}
