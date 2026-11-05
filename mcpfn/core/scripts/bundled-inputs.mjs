import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

function metadataFor(file, name) {
  let directory = dirname(realpathSync(file));
  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return { directory, metadata };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    assert(parent !== directory, `Cannot locate metadata for ${name}`);
    directory = parent;
  }
}

// Capture the actual files supplied to esbuild, before SDK source maps erase
// their published JS origins. This is build provenance, not registry integrity
// verification: npm ci remains responsible for integrity of installed inputs.
export function bundledInputs(packageRoot, outputFormat) {
  const root = resolve(packageRoot);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const require = createRequire(join(root, 'package.json'));
  const sdk = metadataFor(require.resolve('@modelcontextprotocol/sdk/types.js'), '@modelcontextprotocol/sdk');
  const zod = metadataFor(require.resolve('zod/package.json'), 'zod');
  const expected = {
    '@modelcontextprotocol/sdk': { ...sdk, version: manifest.dependencies['@modelcontextprotocol/sdk'] },
    zod: { ...zod, version: manifest.devDependencies.zod },
  };
  for (const [name, entry] of Object.entries(expected)) {
    assert.equal(entry.metadata.version, entry.version, `Unexpected bundled ${name} build input`);
  }
  return {
    zodRoot: zod.directory,
    plugin: {
      name: 'mcpfn-bundled-inputs',
      setup(build) {
        const inputs = new Map();
        build.onLoad({ filter: /[/\\]node_modules[/\\](?:@modelcontextprotocol[/\\]sdk|zod)[/\\].*\.[cm]?js$/ }, args => {
          const segments = args.path.split(/[/\\]/);
          const packageSegment = segments[segments.lastIndexOf('node_modules') + 1];
          const name = packageSegment === '@modelcontextprotocol' ? '@modelcontextprotocol/sdk' : 'zod';
          const actual = metadataFor(args.path, name);
          assert.equal(actual.directory, expected[name].directory, `Foreign bundled ${name} input: ${args.path}`);
          assert.equal(actual.metadata.version, expected[name].version, `Unexpected bundled ${name} version`);
          const contents = readFileSync(args.path, 'utf8');
          inputs.set(name + '/' + relative(actual.directory, args.path).replaceAll('\\', '/'), {
            name, version: actual.metadata.version,
            file: relative(actual.directory, args.path).replaceAll('\\', '/'),
            sha256: createHash('sha256').update(contents).digest('hex'),
          });
          return { contents, loader: 'js', resolveDir: dirname(args.path) };
        });
        build.onEnd(result => {
          if (result.errors.length) return;
          for (const name of Object.keys(expected)) {
            assert([...inputs.values()].some(input => input.name === name), `No bundled ${name} inputs captured`);
          }
          mkdirSync(join(root, 'dist'), { recursive: true });
          writeFileSync(join(root, 'dist', `embedded-inputs-${outputFormat ?? (build.initialOptions.outExtension?.[".js"] === ".cjs" ? "cjs" : build.initialOptions.format)}.json`), JSON.stringify({
            schemaVersion: 1,
            inputs: [...inputs.values()].sort((a, b) => (a.name + a.file).localeCompare(b.name + b.file)),
          }, null, 2) + '\n');
        });
      },
    },
  };
}
