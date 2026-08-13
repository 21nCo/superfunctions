import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const probeDirectory = dirname(fileURLToPath(import.meta.url));
const consoleDirectory = dirname(dirname(probeDirectory));
const installationPath = join(probeDirectory, 'installation.mjs');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const artifactDirectory = process.env.SUPERCONSOLE_PROBE_ARTIFACTS
  ?? join(process.env.TMPDIR ?? '/tmp', `superconsole-probe-${stamp}`);
const baseUrl = 'http://127.0.0.1:4178';
const serverLog = [];
const browserLog = [];

await mkdir(artifactDirectory, { recursive: true });

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'npm_execpath is required to launch the production preview.');
const preview = spawn(process.execPath, [npmCli, 'run', 'preview'], {
  cwd: consoleDirectory,
  env: { ...process.env, SUPERCONSOLE_INSTALLATION: installationPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
preview.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
preview.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));

async function waitForPreview() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (preview.exitCode !== null) throw new Error(`Preview exited with code ${preview.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/admin/v1/registry`);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error('Timed out waiting for the production preview.');
}

let browser;
let page;
let failure;
try {
  await waitForPreview();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') browserLog.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserLog.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserLog.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
  page.on('response', (response) => {
    if (response.status() >= 500) browserLog.push(`response: ${response.status()} ${response.url()}`);
  });

  const overviewResponse = await page.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.equal(overviewResponse?.status(), 200, 'The production overview must render successfully.');
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  const registry = await page.evaluate(async () => {
    const response = await fetch('/api/admin/v1/registry');
    return response.json();
  });
  assert.equal(registry.ok, true);
  assert.deepEqual(registry.data.modules.map(({ id }) => id), ['cifn']);
  assert.deepEqual(registry.data.enabledModules.map(({ id }) => id), ['cifn']);
  await page.screenshot({ path: join(artifactDirectory, '01-overview-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Open CiFn' }).click();
  await page.waitForURL('**/modules/cifn');
  await page.getByRole('heading', { name: 'Runs' }).waitFor();
  await page.getByText('21nCo/super-functions').waitFor();
  await page.getByRole('button', { name: 'Open run probe-run-001' }).click();
  await page.waitForURL('**/modules/cifn/runs/probe-run-001');
  await page.getByRole('heading', { name: 'Jobs' }).waitFor();
  await page.getByText('verify', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDirectory, '02-cifn-run-detail.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  await page.getByRole('button', { name: 'Close navigation' }).waitFor();
  await page.getByRole('navigation', { name: 'Super Console navigation' }).last().waitFor();
  await page.screenshot({ path: join(artifactDirectory, '03-mobile-drawer.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close navigation' }).waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);

  assert.deepEqual(browserLog, []);
} catch (error) {
  failure = error;
  if (page) {
    await page.screenshot({ path: join(artifactDirectory, 'failure.png'), fullPage: true }).catch(() => undefined);
    await writeFile(join(artifactDirectory, 'failure.html'), await page.content()).catch(() => undefined);
  }
} finally {
  await browser?.close().catch(() => undefined);
  preview.kill('SIGTERM');
  await new Promise((resolve) => {
    if (preview.exitCode !== null) return resolve();
    preview.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
  await writeFile(join(artifactDirectory, 'server.log'), serverLog.join(''));
  await writeFile(join(artifactDirectory, 'browser.log'), browserLog.join('\n'));
  await writeFile(join(artifactDirectory, 'result.json'), `${JSON.stringify({
    ok: !failure,
    baseUrl,
    artifactDirectory,
    failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack } : failure,
  }, null, 2)}\n`);
}

if (failure) throw failure;
console.log(JSON.stringify({ ok: true, artifactDirectory }));
