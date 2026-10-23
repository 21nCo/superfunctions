import { it, expect } from 'vitest';
import { realpath, mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TestRunner } from '../src/core/test-runner.js';

it('runs different framework workspaces concurrently while host cwd changes', async () => {
  const original = process.cwd();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'testfn-cwd-')));
  try {
    const workspaces = ['one', 'two'].map(name => join(directory, name));
    for (const workspace of workspaces) {
      await mkdir(join(workspace, 'tests'), { recursive: true });
      await symlink(resolve(original, '../../node_modules'), join(workspace, 'node_modules'), 'dir');
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(workspace, 'tests/owned.test.js'), `import {it,expect} from 'vitest'; import {writeFileSync} from 'node:fs'; it('workspace',()=>{writeFileSync('witness',process.cwd());expect(process.cwd()).toBe(${JSON.stringify(workspace)});});`);
    }
    const pending = workspaces.map(cwd => new TestRunner({ framework: 'vitest', cwd, reporters: [], timeout: 15000 }).run());
    process.chdir(directory);
    const results = await Promise.all(pending);
    expect(results.map(result => result.summary.passed)).toEqual([1, 1]);
    for (const workspace of workspaces) expect(await readFile(join(workspace, 'witness'), 'utf8')).toBe(workspace);
    expect(process.cwd()).toBe(directory);
  } finally { process.chdir(original); await rm(directory, { recursive: true, force: true }); }
}, 30000);

it('captures default cwd before asynchronous discovery and forwards it to custom adapters', async () => {
  const original = process.cwd();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'testfn-cwd-default-')));
  try {
    const runner = new TestRunner({ framework: 'vitest', reporters: [] });
    runner.setAdapter({
      name: 'fixture', supports: () => true,
      async discover(_patterns, options) {
        expect(options?.cwd).toBe(original);
        return [{ id: 'test', file: 'test.js', name: 'test' }];
      },
      async run(_tests, options) {
        expect(options.cwd).toBe(original);
        return [{ id: 'test', status: 'passed', duration: 0 }];
      },
    });
    const pending = runner.run();
    process.chdir(directory);
    expect((await pending).summary.passed).toBe(1);
    expect(process.cwd()).toBe(directory);
  } finally { process.chdir(original); await rm(directory, { recursive: true, force: true }); }
});

it('resolves path-only framework artifacts inside the explicit workspace', async () => {
  const { JsonFrameworkAdapter } = await import('../src/integrations/json-adapter.js');
  class Fixture extends JsonFrameworkAdapter {
    name = 'fixture';
    protected arguments() { return ['-e', 'console.log("{}")']; }
    protected parse() { return [{ id: 'one', status: 'passed' as const, duration: 0, artifacts: [{ type: 'log' as const, path: 'artifact.txt' }] }]; }
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'testfn-artifact-cwd-')));
  try {
    const result = await new Fixture().run([{ id: 'one', name: 'one', file: 'test.js' }], { cwd: directory });
    expect(result[0].artifacts?.[0].path).toBe(join(directory, 'artifact.txt'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
