import { expect, it, vi } from 'vitest';
import { realpath, mkdtemp, mkdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeTestFnRun, executeTestFnRunAsync } from './steps/testfn-run.js';
it('synchronous legacy entry fails before changing directory or starting framework work',()=>{
  const change=vi.spyOn(process,'chdir');
  try { expect(executeTestFnRun({workspace:'/must-not-be-opened'})).toMatchObject({success:false,exitCode:1});expect(change).not.toHaveBeenCalled(); }
  finally { change.mockRestore(); }
});
it('executes actual brace-glob selected files, propagates failure and restores cwd',async()=>{
  const original=process.cwd(),directory=await mkdtemp(join(tmpdir(),'cifn-testfn-glob-'));
  try {
    await mkdir(join(directory,'tests'));
    await writeFile(join(directory,'package.json'),JSON.stringify({type:'module'}));
    await symlink(resolve(original,'../../../node_modules'),join(directory,'node_modules'),'dir');
    await writeFile(join(directory,'tests/a.test.js'),"import {it,expect} from 'vitest'; import {writeFileSync} from 'node:fs'; it('actual',()=>{writeFileSync('witness','ran');expect(1).toBe(1)});");
    await writeFile(join(directory,'tests/b.spec.ts'),"import {it,expect} from 'vitest';it('second',()=>expect(2).toBe(2));");
    await writeFile(join(directory,'tests/ignored.js'),"throw new Error('must not discover');");
    const options={workspace:directory,testPattern:'./tests/**/*.{test,spec}.{ts,js}',timeout:15000,parallel:1};
    const passed=await executeTestFnRunAsync(options);expect(passed.success,passed.error).toBe(true);expect(passed.lines).toContain('Tests completed: 2 total');await access(join(directory,'witness'));expect(process.cwd()).toBe(original);
    await writeFile(join(directory,'tests/b.spec.ts'),"import {it,expect} from 'vitest';it('failure',()=>expect(2).toBe(3));");
    const failed=await executeTestFnRunAsync(options);expect(failed.success).toBe(false);expect(failed.exitCode).toBe(1);expect(process.cwd()).toBe(original);
  } finally { process.chdir(original);await rm(directory,{recursive:true,force:true}); }
},45000);
it('overlapping workspaces execute independently without changing the host cwd', async () => {
  const original = process.cwd();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cifn-overlap-')));
  try {
    for (const name of ['one', 'two']) {
      const workspace = join(directory, name);
      await mkdir(join(workspace, 'tests'), { recursive: true });
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
      await symlink(resolve(original, '../../../node_modules'), join(workspace, 'node_modules'), 'dir');
      await writeFile(join(workspace, 'tests/owned.test.js'), `import {it,expect} from 'vitest'; import {writeFileSync} from 'node:fs'; it('${name}',async()=>{await new Promise(r=>setTimeout(r,150));writeFileSync('witness','${name}');expect(process.cwd()).toBe(${JSON.stringify(workspace)});});`);
    }
    const results = await Promise.all(['one', 'two'].map(name => executeTestFnRunAsync({ workspace: join(directory, name), reporter: 'json', timeout: 15000 })));
    expect(results.map(result => result.success)).toEqual([true, true]);
    const { readFile } = await import('node:fs/promises');
    for (const name of ['one', 'two']) {
      expect(await readFile(join(directory, name, 'witness'), 'utf8')).toBe(name);
      await access(join(directory, name, 'testfn-results.json'));
    }
    expect(process.cwd()).toBe(original);
  } finally { process.chdir(original); await rm(directory, { recursive: true, force: true }); }
}, 45000);
