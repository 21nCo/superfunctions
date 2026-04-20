import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import { createRunManifest, type DeterministicSettings } from '@probefn/contracts';

import { buildBaselineKey, inferViewportTag } from '../src/index.js';
import { readBaselineRegistry, recordBaseline } from '../src/baseline-registry.js';

const tempDirectories: string[] = [];

const deterministic: DeterministicSettings = {
  enabled: true,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  animationPolicy: 'freeze',
  networkIdleMs: 500,
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('baseline registry', () => {
  it('builds the documented deterministic baseline-key format', () => {
    expect(
      buildBaselineKey({
        routeIdentity: 'home',
        viewportTag: inferViewportTag({ width: 1440, height: 900 }),
        browser: 'chromium',
        colorScheme: 'light',
        width: 1440,
        height: 900,
        timezoneTag: 'utc',
      }),
    ).toBe('home.desktop.chromium.light.1440x900.utc');
  });

  it('records registry entries, warns on mismatched key dimensions, and replaces duplicate keys deterministically', async () => {
    const repoRoot = await createRepoRoot();
    await seedCheckpoint(repoRoot, {
      runId: 'run_one',
      sessionId: 'sess_one',
      checkpointId: 'chk_landing',
      checkpointName: 'landing',
      viewport: { width: 1440, height: 900 },
      screenshotSeed: [0, 68, 204, 255],
    });

    const baselineKey = 'home.desktop.chromium.light.390x844.utc';
    const firstResult = await recordBaseline({
      repoRoot,
      artifactRoot: '.artifacts/runs/run_one',
      checkpointId: 'chk_landing',
      baselineKey,
      sessionId: 'sess_one',
      runId: 'run_one',
      deterministic,
      now: () => '2026-04-16T04:10:00Z',
    });

    expect(firstResult).toEqual({
      baselineKey,
      registryPath: '.artifacts/baselines/registry.json',
      sourceCheckpointId: 'chk_landing',
      warnings: [
        'Baseline key dimensions differ from checkpoint viewport; a distinct baseline entry was recorded.',
      ],
    });

    const firstRegistry = await readBaselineRegistry(repoRoot);
    expect(firstRegistry.entries).toHaveLength(1);
    expect(firstRegistry.entries[0]).toMatchObject({
      baselineKey,
      sourceCheckpointId: 'chk_landing',
      sourceRunId: 'run_one',
      deterministic: {
        viewport: { width: 1440, height: 900 },
      },
    });

    await seedCheckpoint(repoRoot, {
      runId: 'run_two',
      sessionId: 'sess_two',
      checkpointId: 'chk_landing_v2',
      checkpointName: 'landing',
      viewport: { width: 1440, height: 900 },
      screenshotSeed: [255, 0, 0, 255],
    });

    const secondResult = await recordBaseline({
      repoRoot,
      artifactRoot: '.artifacts/runs/run_two',
      checkpointId: 'chk_landing_v2',
      baselineKey,
      sessionId: 'sess_two',
      runId: 'run_two',
      deterministic,
      now: () => '2026-04-16T04:11:00Z',
    });

    expect(secondResult.warnings).toHaveLength(1);

    const registryContents = await readBaselineRegistry(repoRoot);
    expect(registryContents.entries).toHaveLength(1);
    expect(registryContents.entries[0]).toMatchObject({
      baselineKey,
      sourceCheckpointId: 'chk_landing_v2',
      sourceRunId: 'run_two',
      recordedAt: '2026-04-16T04:11:00Z',
    });

    const copiedManifest = JSON.parse(
      await readFile(
        path.resolve(
          repoRoot,
          '.artifacts/baselines/entries/home.desktop.chromium.light.390x844.utc/checkpoint.json',
        ),
        'utf8',
      ),
    );
    expect(copiedManifest.checkpointId).toBe('chk_landing_v2');
  });
});

async function createRepoRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-baselines-'));
  tempDirectories.push(directory);
  return directory;
}

async function seedCheckpoint(
  repoRoot: string,
  input: {
    runId: string;
    sessionId: string;
    checkpointId: string;
    checkpointName: string;
    viewport: { width: number; height: number };
    screenshotSeed: [number, number, number, number];
  },
): Promise<void> {
  const runRoot = path.resolve(repoRoot, '.artifacts', 'runs', input.runId);
  const checkpointRoot = path.resolve(runRoot, 'checkpoints', input.checkpointName);
  await mkdir(checkpointRoot, { recursive: true });

  const screenshot = new PNG({
    width: 4,
    height: 4,
  });
  for (let index = 0; index < screenshot.data.length; index += 4) {
    screenshot.data[index] = input.screenshotSeed[0];
    screenshot.data[index + 1] = input.screenshotSeed[1];
    screenshot.data[index + 2] = input.screenshotSeed[2];
    screenshot.data[index + 3] = input.screenshotSeed[3];
  }

  const screenshotPath = '.artifacts/runs/' + input.runId + `/checkpoints/${input.checkpointName}/screenshot.png`;
  const domPath = '.artifacts/runs/' + input.runId + `/checkpoints/${input.checkpointName}/dom.json`;
  const axPath = '.artifacts/runs/' + input.runId + `/checkpoints/${input.checkpointName}/ax.json`;
  const layoutPath = '.artifacts/runs/' + input.runId + `/checkpoints/${input.checkpointName}/layout.json`;
  const stylesPath = '.artifacts/runs/' + input.runId + `/checkpoints/${input.checkpointName}/styles.json`;

  await writeFile(path.resolve(repoRoot, screenshotPath), PNG.sync.write(screenshot));
  await writeFile(path.resolve(repoRoot, domPath), JSON.stringify({ html: '<main>ok</main>' }, null, 2));
  await writeFile(path.resolve(repoRoot, axPath), JSON.stringify({ snapshot: 'ok' }, null, 2));
  await writeFile(
    path.resolve(repoRoot, layoutPath),
    `${JSON.stringify(
      {
        elements: [
          {
            elementId: 'el_primary_cta',
            role: 'button',
            name: 'Primary CTA',
            text: 'Primary CTA',
            visible: true,
            disabled: false,
            bounds: { x: 16, y: 32, width: 180, height: 80 },
            selectorHints: { id: 'primary-cta', role: 'button', name: 'Primary CTA' },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.resolve(repoRoot, stylesPath),
    `${JSON.stringify(
      {
        elements: [
          {
            role: 'button',
            name: 'Primary CTA',
            text: 'Primary CTA',
            id: 'primary-cta',
            bounds: { x: 16, y: 32, width: 180, height: 80 },
            clientWidth: 180,
            clientHeight: 80,
            scrollWidth: 180,
            scrollHeight: 80,
            color: 'rgb(255, 255, 255)',
            backgroundColor: 'rgb(0, 68, 204)',
            outlineStyle: 'solid',
            outlineWidth: '2px',
            outlineColor: 'rgb(10, 102, 255)',
            boxShadow: '0 0 0 3px rgb(10, 102, 255)',
            borderColor: 'rgb(0, 68, 204)',
            borderWidth: '0px',
            fontSize: '24px',
            lineHeight: '32px',
            whiteSpace: 'normal',
            overflowX: 'visible',
            overflowY: 'visible',
            textOverflow: 'clip',
            focusable: true,
            focusIndicatorVisible: true,
            visible: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(
    path.resolve(repoRoot, runRoot, 'session.json'),
    `${JSON.stringify(
      createRunManifest({
        sessionId: input.sessionId,
        runId: input.runId,
        mode: 'visual-regression',
        browser: 'chromium',
        artifactRoot: `.artifacts/runs/${input.runId}`,
        startedAt: '2026-04-16T04:00:00Z',
        status: 'completed',
        deterministic,
        devServer: {
          mode: 'spawn',
          name: 'web',
          url: 'http://127.0.0.1:4000',
          resolvedUrl: 'http://127.0.0.1:4000',
        },
      }),
      null,
      2,
    )}\n`,
  );

  await writeFile(
    path.resolve(repoRoot, checkpointRoot, 'checkpoint.json'),
    `${JSON.stringify(
      {
        schemaVersion: '1.0',
        checkpointId: input.checkpointId,
        sessionId: input.sessionId,
        runId: input.runId,
        browser: 'chromium',
        name: input.checkpointName,
        url: 'http://127.0.0.1:4000/',
        viewport: input.viewport,
        artifacts: [
          { kind: 'screenshot', path: screenshotPath, sha256: 'a' },
          { kind: 'dom', path: domPath, sha256: 'b' },
          { kind: 'ax', path: axPath, sha256: 'c' },
          { kind: 'layout', path: layoutPath, sha256: 'd' },
          { kind: 'styles', path: stylesPath, sha256: 'e' },
        ],
        createdAt: '2026-04-16T04:00:01Z',
      },
      null,
      2,
    )}\n`,
  );
}
