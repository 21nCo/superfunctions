import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createThumbnailProcessor } from '@filefn/processing';
import { stripFileFnPrefix } from './filefn-path.ts';

const require = createRequire(import.meta.url);

function honoVersion() {
  let directory = dirname(require.resolve('hono'));
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === 'hono') return pkg.version;
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, 'Hono package manifest was not found');
    directory = parent;
  }
}

test('strips the /filefn mount and keeps a leading slash', () => {
  assert.equal(stripFileFnPrefix('/filefn'), '/');
  assert.equal(stripFileFnPrefix('/filefn/'), '/');
  assert.equal(stripFileFnPrefix('/filefn/upload/init'), '/upload/init');
  assert.equal(stripFileFnPrefix('/filefn-other'), '/filefn-other');
  assert.equal(stripFileFnPrefix('/health'), '/health');
});

test('loads Hono at or above the patched 4.12.4 floor', () => {
  const version = honoVersion();
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major > 4 || (major === 4 && (minor > 12 || (minor === 12 && patch >= 4))), version);
});

test('creates a thumbnail with the example’s processing dependency', async () => {
  const fromProcessing = createRequire(require.resolve('@filefn/processing'));
  const sharp = fromProcessing('sharp');
  const processor = createThumbnailProcessor({ sizes: [{ name: 'smoke', width: 4, height: 4 }] });
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: 'white' },
  }).png().toBuffer();
  const result = await processor.process({
    fileId: 'test-file', versionId: 'test-version', storageKey: 'example.png',
    mimeType: 'image/png', size: png.length, fileName: 'example.png',
  }, async () => png);
  assert.equal(result.success, true);
  assert.equal(result.artifacts.length, 1);
  const image = await sharp(result.artifacts[0].data).metadata();
  assert.deepEqual({ format: image.format, width: image.width, height: image.height }, {
    format: 'jpeg', width: 4, height: 4,
  });
});
