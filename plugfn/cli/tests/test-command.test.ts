import { describe, expect, it, vi } from 'vitest';
import {
  formatDiagnosticReport,
  runProviderDiagnostics,
  testCommand,
} from '../src/commands/test.js';

describe('plugfn cli test command', () => {
  it('returns deterministic success diagnostics for known provider', async () => {
    const report = await runProviderDiagnostics({
      provider: 'github',
    });

    expect(report.ok).toBe(true);
    expect(report.provider).toBe('github');
    expect(report.checks.config).toBe(true);
    expect(report.checks.authUrl).toBe(true);
    expect(report.checks.callbackValidation).toBe(true);
  });

  it('fails with PROVIDER_NOT_FOUND for unknown providers', async () => {
    const report = await runProviderDiagnostics({
      provider: 'notreal',
    });

    expect(report.ok).toBe(false);
    expect(report.error).toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
      message: 'provider notreal is not registered',
    });
  });

  it('sets nonzero exit code on failing diagnostics in json mode', async () => {
    const stdout = vi.fn();
    const setExitCode = vi.fn();

    await testCommand(
      {
        provider: 'notreal',
        json: true,
      },
      {
        stdout,
        setExitCode,
      }
    );

    expect(setExitCode).toHaveBeenCalledWith(1);
    const output = stdout.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.error.code).toBe('PROVIDER_NOT_FOUND');
  });

  it('formats human-readable output with explicit pass/fail states', async () => {
    const report = await runProviderDiagnostics({
      provider: 'github',
      live: false,
    });
    const text = formatDiagnosticReport(report, false);

    expect(text).toContain('Provider diagnostics for github');
    expect(text).toContain('PASS config');
    expect(text).toContain('PASS authUrl');
    expect(text).toContain('PASS callbackValidation');
    expect(text).toContain('Overall: PASS');
  });
});
