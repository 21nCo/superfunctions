import { execSync } from 'node:child_process';

export interface HostFnDeployOptions {
  environment: string;
  ci?: boolean;
  local?: boolean;
  workspace: string;
  env?: Record<string, string>;
}

export interface HostFnDeployResult {
  success: boolean;
  exitCode: number;
  lines: string[];
  error?: string;
}

export function executeHostFnDeploy(options: HostFnDeployOptions): HostFnDeployResult {
  const { environment, ci = true, local = false, workspace, env } = options;
  const lines: string[] = [];

  let command = `hostfn deploy ${environment}`;
  if (local) command += ' --local';
  if (ci) command += ' --ci';

  lines.push(`Deploying: ${command}`);

  try {
    const output = execSync(command, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000,
      shell: '/bin/sh',
      env: env ? { ...process.env, ...env } : process.env,
    });
    if (output) {
      lines.push(...output.split('\n').filter(l => l !== ''));
    }
    lines.push('Deploy succeeded');
    return { success: true, exitCode: 0, lines };
  } catch (err: unknown) {
    const error = err as { status?: number; stdout?: string; stderr?: string };
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const exitCode = typeof error.status === 'number' ? error.status : 1;
    if (stdout) lines.push(...stdout.split('\n').filter(l => l !== ''));
    if (stderr) lines.push(...stderr.split('\n').filter(l => l !== ''));
    lines.push(`Deploy failed with exit code ${exitCode}`);
    return { success: false, exitCode, lines, error: `Deploy failed with exit code ${exitCode}` };
  }
}
