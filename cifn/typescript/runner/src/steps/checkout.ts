import { execSync } from 'node:child_process';

export interface CheckoutOptions {
  repo: string;
  ref: string;
  workspace: string;
  token?: string;
}

export interface CheckoutResult {
  success: boolean;
  lines: string[];
  error?: string;
}

export function executeCheckout(options: CheckoutOptions): CheckoutResult {
  const { repo, ref, workspace, token } = options;
  const lines: string[] = [];
  const secretsToRedact: string[] = [];

  let cloneUrl = repo;
  if (token && cloneUrl.startsWith('https://')) {
    const url = new URL(cloneUrl);
    url.username = 'x-access-token';
    url.password = token;
    cloneUrl = url.toString();
    secretsToRedact.push(token);
    secretsToRedact.push(cloneUrl);
  }

  const redactLine = (line: string): string => {
    let redacted = line;
    for (const secret of secretsToRedact) {
      if (secret.length > 0) {
        redacted = redacted.split(secret).join('***');
      }
    }
    return redacted;
  };

  try {
    lines.push(`Cloning ${repo} at ref ${ref}`);

    const cloneCmd = `git clone --depth 1 --branch ${ref} ${cloneUrl} .`;
    const output = execSync(cloneCmd, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (output) {
      lines.push(...output.split('\n').filter(l => l !== '').map(redactLine));
    }

    lines.push(`Checkout complete: ${ref}`);
    return { success: true, lines };
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    const errMsg = typeof error.stderr === 'string' ? redactLine(error.stderr) : (error.message ? redactLine(error.message) : 'Unknown error');
    lines.push(`Checkout failed: ${errMsg}`);
    return { success: false, lines, error: errMsg };
  }
}
