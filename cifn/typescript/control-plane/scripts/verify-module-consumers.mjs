import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Independent consumer processes exercise built entrypoints without source loaders.
// Dependencies are the installed workspace graph; this is not a fresh-install matrix.
const cjs = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const esm = new URL('../dist/index.mjs', import.meta.url).href;
const probe = `
  const assert = (await import('node:assert/strict')).default;
  assert.equal(typeof api.DatabaseStore.open, 'function');
  assert.ok(api.getCiFnStoreSchema()[api.CIFN_STATE_TABLE]);
  const result = api.validate({name:'consumer',on:{workflow_dispatch:{}},jobs:{build:{'runs-on':'default',steps:[{run:'true'}]}}});
  assert.equal(result.ok, true);
  const {app} = api.createApp();
  assert.equal(typeof app.fetch, 'function');
`;
execFileSync(process.execPath, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const api=createRequire(import.meta.url)(${JSON.stringify(cjs)}); ${probe}`], { stdio: 'inherit' });
execFileSync(process.execPath, ['--input-type=module', '-e', `import * as api from ${JSON.stringify(esm)}; ${probe}`], { stdio: 'inherit' });
console.log('Fresh CJS and ESM consumer processes passed against built entrypoints');
