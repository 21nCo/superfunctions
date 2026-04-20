import { readFileSync } from 'node:fs';

function evaluateDocDriftNegative(input: {
  pythonReadmeFeatureLabel: string;
  pythonPublicImports: string[];
}) {
  if (
    /coming soon/i.test(input.pythonReadmeFeatureLabel)
    && input.pythonPublicImports.includes('sendfn.push.FcmProvider')
    && input.pythonPublicImports.includes('sendfn.push.ApnsProvider')
  ) {
    return {
      valid: false,
      error: {
        code: 'SENDFN_DOC_DRIFT',
        message: 'Documentation does not match shipped public behavior',
      },
    };
  }

  return { valid: true, mismatches: [] };
}

async function main() {
  const typescriptReadme = readFileSync(
    new URL('../../../../typescript/README.md', import.meta.url),
    'utf8',
  );
  const pythonReadme = readFileSync(
    new URL('../../../../python/README.md', import.meta.url),
    'utf8',
  );
  const packageJson = JSON.parse(
    readFileSync(new URL('../../../../typescript/package.json', import.meta.url), 'utf8'),
  );

  const result = {
    ok: true,
    vectors: ['TV-DOC-001-P', 'TV-DOC-001-N'],
    results: {
      'TV-DOC-001-P': {
        valid: Boolean(
          packageJson.name === 'sendfn'
            && typescriptReadme.includes("import { sendfn, awsSesAdapter, consoleSmsAdapter } from 'sendfn';")
            && typescriptReadme.includes('npm install sendfn @superfunctions/db @superfunctions/http')
            && !typescriptReadme.includes('@sendfn/core')
            && !typescriptReadme.includes('Twilio')
            && typescriptReadme.includes("app.post('/webhooks/aws-ses'")
            && pythonReadme.includes('Push Notifications')
            && pythonReadme.includes('SMS')
            && !pythonReadme.match(/coming soon/i)
            && pythonReadme.includes('python -m pytest sendfn/python/tests')
            && pythonReadme.includes('AWS SES webhook endpoints must receive the full SNS envelope unchanged.')
        ),
        mismatches: [],
      },
      'TV-DOC-001-N': evaluateDocDriftNegative({
        pythonReadmeFeatureLabel: 'Push Notifications - coming soon',
        pythonPublicImports: ['sendfn.push.FcmProvider', 'sendfn.push.ApnsProvider'],
      }),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
