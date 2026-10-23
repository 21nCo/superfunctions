import { spawnSync } from 'node:child_process';
import type { RunStepResult } from './executor/run-step.js';

export interface DockerExecutorOptions {
  image: string;
  workspace: string;
  command: string;
  env?: Record<string, string>;
}

export interface DockerCommandRunner {
  run(args: string[], options: { cwd: string; env?: Record<string, string> }): {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: string;
  };
}

class DefaultDockerCommandRunner implements DockerCommandRunner {
  run(args: string[], options: { cwd: string; env?: Record<string, string> }) {
    const res = spawnSync('docker', args, {
      cwd: options.cwd,
      encoding: 'utf-8',
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: 600_000,
    });
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      error: res.error ? String(res.error.message ?? res.error) : undefined,
    };
  }
}

export class DockerExecutor {
  private readonly runner: DockerCommandRunner;

  constructor(runner?: DockerCommandRunner) {
    this.runner = runner ?? new DefaultDockerCommandRunner();
  }

  execute(options: DockerExecutorOptions): RunStepResult {
    const args = [
      'run',
      '--rm',
      '-v', `${options.workspace}:/workspace`,
      '-w', '/workspace',
    ];

    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }

    args.push(options.image, 'sh', '-lc', options.command);

    const output = this.runner.run(args, { cwd: options.workspace, env: options.env });

    const stdout = output.stdout ?? '';
    const stderr = output.stderr ?? '';
    const lines = [...stdout.split('\n'), ...stderr.split('\n')].filter(line => line !== '');
    const exitCode = output.status ?? 1;

    if (output.error) {
      lines.push(`docker error: ${output.error}`);
    }

    return {
      exitCode,
      stdout,
      stderr,
      lines,
    };
  }
}
