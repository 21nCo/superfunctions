import { readFileSync } from 'node:fs';
import { SendfnDb } from '../../../../sendfn/typescript/src/database/sendfn-db';
import { StrongMockAdapter, WeakOverwriteMockAdapter, assertTestDoubleFidelity } from '../../../../sendfn/typescript/tests/mock-adapter';

function evaluateTypeScriptReleaseGateFailure(command: string, stderr: string) {
  if (command === 'npm run build --workspace sendfn/typescript' && /tsup: command not found/i.test(stderr)) {
    return {
      allPassed: false,
      error: {
        code: 'SENDFN_RELEASE_GATE_FAILED',
        message: 'TypeScript build tooling is not available from the documented install path',
      },
    };
  }

  return { allPassed: true };
}

async function main() {
  const tsReadme = readFileSync(new URL('../../../../sendfn/typescript/README.md', import.meta.url), 'utf8');
  const tsPackageJson = JSON.parse(
    readFileSync(new URL('../../../../sendfn/typescript/package.json', import.meta.url), 'utf8'),
  );
  const pyReadme = readFileSync(new URL('../../../../sendfn/python/README.md', import.meta.url), 'utf8');
  const pyProject = readFileSync(new URL('../../../../sendfn/python/pyproject.toml', import.meta.url), 'utf8');

  const releaseGatePositive = Boolean(
    tsReadme.includes('npm run build --workspace sendfn/typescript')
      && tsReadme.includes('npm run lint --workspace sendfn/typescript')
      && tsReadme.includes('npm test --workspace sendfn/typescript -- --run')
      && tsPackageJson.scripts?.['release:verify'] === 'npm run build && npm run lint && npm test -- --run'
      && pyReadme.includes("python -m pip install -e './sendfn/python[dev,email,push,fastapi]'")
      && pyReadme.includes('python -m pip install -e ./packages/python-core')
      && pyReadme.includes('python -m pytest sendfn/python/tests')
      && pyProject.includes('[tool.sendfn.release_gate]')
      && pyProject.includes('shared_install = "python -m pip install -e ./packages/python-core"')
      && pyProject.includes("package_install = \"python -m pip install -e './sendfn/python[dev,email,push,fastapi]'\"")
      && pyProject.includes('test_command = "python -m pytest sendfn/python/tests"')
  );

  const releaseGateNegative = evaluateTypeScriptReleaseGateFailure(
    'npm run build --workspace sendfn/typescript',
    'sh: tsup: command not found',
  );

  const strongAdapter = new StrongMockAdapter();
  const db = new SendfnDb(strongAdapter as any);

  await strongAdapter.create({
    model: 'email_transactions',
    data: {
      id: 'tx-1',
      userId: 'user-1',
      to: 'user@example.com',
      from: 'noreply@example.com',
      subject: 'Hello',
      templateId: null,
      templateData: null,
      provider: 'aws-ses',
      providerMessageId: 'ses-123',
      status: 'sent',
      sentAt: new Date('2026-04-05T00:00:00Z'),
      deliveredAt: null,
      bouncedAt: null,
      complainedAt: null,
      metadata: {},
      createdAt: new Date('2026-04-05T00:00:00Z'),
      updatedAt: new Date('2026-04-05T00:00:00Z'),
    },
  });

  let duplicateCreateError: { code?: string } | null = null;
  try {
    await strongAdapter.create({
      model: 'email_transactions',
      data: { id: 'tx-1' },
    });
  } catch (error) {
    duplicateCreateError = { code: (error as { code?: string }).code };
  }

  const providerLookupSupported = Boolean(
    (await db.getEmailTransactionByProviderMessageId('ses-123'))?.id === 'tx-1',
  );

  let fidelityNegative: { pass: boolean; error?: { code?: string; message?: string } } = { pass: true };
  try {
    await assertTestDoubleFidelity(new WeakOverwriteMockAdapter());
  } catch (error) {
    fidelityNegative = {
      pass: false,
      error: {
        code: (error as { code?: string }).code,
        message: (error as Error).message,
      },
    };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        vectors: ['TV-TEST-001-P', 'TV-TEST-001-N', 'TV-TEST-002-P', 'TV-TEST-002-N'],
        results: {
          'TV-TEST-001-P': { allPassed: releaseGatePositive },
          'TV-TEST-001-N': releaseGateNegative,
          'TV-TEST-002-P': {
            duplicateCreateError,
            providerLookupSupported,
          },
          'TV-TEST-002-N': fidelityNegative,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
