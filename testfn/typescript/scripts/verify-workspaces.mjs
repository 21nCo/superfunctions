/** Owned framework fixtures; no browser launch, external sites, or providers. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from '../dist/index.js';
const original = process.cwd();
const directory = await realpath(await mkdtemp(join(tmpdir(), 'testfn-framework-cwd-')));
const dependencies = fileURLToPath(new URL('../../../node_modules', import.meta.url));
try {
  const workspaces = [];
  for (const framework of ['vitest', 'jest', 'playwright', 'puppeteer']) {
    const cwd = join(directory, framework);
    await mkdir(join(cwd, 'tests'), { recursive: true });
    await symlink(dependencies, join(cwd, 'node_modules'), 'dir');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ type: framework === 'jest' ? 'commonjs' : 'module' }));
    const imports = framework === 'jest' ? "const {writeFileSync}=require('node:fs');const assert=require('node:assert/strict');" : `import {${framework === 'playwright' ? 'test as it' : 'it'}} from '${framework === 'playwright' ? '@playwright/test' : framework === 'puppeteer' ? 'node:test' : 'vitest'}';import {writeFileSync} from 'node:fs';import assert from 'node:assert/strict';`;
    const callback = framework === 'playwright' ? "async ({}, info)" : "()";
    const extra = framework === 'playwright' ? "assert.equal(info.config.metadata.workspace, process.cwd());await info.attach('proof',{body:Buffer.from('owned'),contentType:'text/plain'});" : "";
    await writeFile(join(cwd, 'tests/owned.test.js'), `${imports}it('workspace',${callback}=>{assert.equal(process.cwd(),${JSON.stringify(cwd)});writeFileSync('witness',process.cwd());${extra}});`);
    if (framework === 'playwright') {
      await mkdir(join(cwd, 'settings'));
      await writeFile(join(cwd, 'settings/config.ts'), `export default { timeout: 10000, metadata: {workspace:${JSON.stringify(cwd)}} };`);
    }
    workspaces.push({ framework, cwd, ...(framework === 'playwright' ? {configFile: 'settings/config.ts'} : {}) });
  }
  const pending = workspaces.map(config => new TestRunner({ ...config, reporters: [], timeout: 20000, testPattern: './tests/*.test.js' }).run());
  process.chdir(directory);
  const results = await Promise.all(pending);
  for (const [index, result] of results.entries()) {
    assert.equal(result.summary.passed, 1, JSON.stringify({ framework: workspaces[index].framework, result }));
    assert.equal(result.summary.failed, 0);
    assert.equal(await readFile(join(workspaces[index].cwd, 'witness'), 'utf8'), workspaces[index].cwd);
    assert.ok(!(await readdir(workspaces[index].cwd)).some(name => name.startsWith('.testfn-')), 'generated config cleaned');
  }
  assert.equal(process.cwd(), directory);
  console.log(JSON.stringify({ passed: true, frameworks: workspaces.map(x => x.framework), concurrent: true, hostCwdPreserved: true }));
} finally { process.chdir(original); await rm(directory, { recursive: true, force: true }); }
