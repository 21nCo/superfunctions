import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { bundledInputs } from './bundled-inputs.mjs';

for (const version of ['1.29.0', '1.32.1']) {
  test(`bundler verifies SDK ${version} and records actual inputs`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcpfn-build-inputs-'));
    const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
    try {
      write(join(root, 'package.json'), JSON.stringify({ name:'@mcpfn/core', dependencies: {'@modelcontextprotocol/sdk': '1.32.1'}, devDependencies: {zod:'4.6.6'} }));
      write(join(root, 'node_modules/@modelcontextprotocol/sdk/package.json'), JSON.stringify({name:'@modelcontextprotocol/sdk', version}));
      const sdkSource = 'export const sdk = "fixture";';
      write(join(root, 'node_modules/@modelcontextprotocol/sdk/types.js'), sdkSource);
      write(join(root, 'node_modules/zod/package.json'), JSON.stringify({name:'zod',version:'4.6.6', main:'index.js'}));
      write(join(root, 'node_modules/zod/index.js'), 'export const zod = "fixture";');
      write(join(root, 'entry.js'), 'export {sdk} from "@modelcontextprotocol/sdk/types.js"; export {zod} from "zod";');
      if (version !== '1.32.1') {
        assert.throws(() => bundledInputs(root), /Unexpected bundled @modelcontextprotocol\/sdk build input/);
      } else {
        const {plugin} = bundledInputs(root);
        await build({entryPoints:[join(root,'entry.js')], bundle:true, format:'esm', outfile:join(root,'dist/index.js'), plugins:[plugin]});
        const inventory = JSON.parse(readFileSync(join(root,'dist/embedded-inputs-esm.json')));
        const sdk = inventory.inputs.find(input => input.name === '@modelcontextprotocol/sdk');
        assert.equal(sdk.version, version);
        assert.equal(sdk.sha256, createHash('sha256').update(sdkSource).digest('hex'));
        assert.equal(inventory.inputs.length, 2);
        await build({entryPoints:[join(root,'entry.js')], bundle:true, format:'cjs', outfile:join(root,'dist/index.cjs'), plugins:[bundledInputs(root).plugin]});
        const verifier = fileURLToPath(new URL('./verify-bundled-inputs.mjs', import.meta.url));
        execFileSync(process.execPath,[verifier,root,'--seal'],{stdio:'pipe'});
        execFileSync(process.execPath,[verifier,root],{stdio:'pipe'});
        write(join(root,'dist/index.cjs'),'/* replaced after build */');
        assert.throws(() => execFileSync(process.execPath,[verifier,root],{stdio:'pipe'}), /Bundle differs from recorded build output/);

      }
    } finally { rmSync(root, {recursive:true,force:true}); }
  });
}


test('rejects a foreign Zod nested inside an SDK directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcpfn-foreign-input-'));
  const write = (file, content) => { mkdirSync(dirname(file), {recursive:true}); writeFileSync(file,content); };
  try {
    write(join(root,'package.json'),JSON.stringify({dependencies:{'@modelcontextprotocol/sdk':'1.32.1'},devDependencies:{zod:'4.6.6'}}));
    const sdkRoot = join(root,'node_modules/@modelcontextprotocol/sdk');
    write(join(sdkRoot,'package.json'),JSON.stringify({name:'@modelcontextprotocol/sdk',version:'1.32.1'}));
    write(join(sdkRoot,'types.js'),'export {value} from "./node_modules/zod/index.js";');
    write(join(sdkRoot,'node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'4.6.6'}));
    write(join(sdkRoot,'node_modules/zod/index.js'),'export const value = 1;');
    write(join(root,'node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'4.6.6'}));
    await assert.rejects(build({entryPoints:[join(sdkRoot,'types.js')],bundle:true,format:'esm',write:false,logLevel:'silent',plugins:[bundledInputs(root).plugin]}),/Foreign bundled zod input/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
