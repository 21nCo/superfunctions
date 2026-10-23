/** Owned POSIX descendant shutdown and exit-code acceptance; no npm/network needed. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') throw new Error('This process-group acceptance requires POSIX');
const root = await mkdtemp(join(tmpdir(), 'ui-shutdown-proof-'));
const receipt = join(root, 'receipt.json');
const fake = join(root, 'npm.mjs');
const launcher = fileURLToPath(new URL('../scripts/run-vitest-ui.mjs', import.meta.url));
let descendant;
let prefix;
try {
  await writeFile(fake, `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>{writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:child.pid,prefix,args:process.argv.slice(2),cwd:process.cwd()}));process.exit(0)});
`);
  const started = Date.now();
  const child = spawn(process.execPath, [launcher, '--testNamePattern', 'literal $value; with spaces'], {
    cwd: root, env: { ...process.env, npm_execpath: fake }, stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const data = JSON.parse(await readFile(receipt, 'utf8'));
  descendant = data.pid; prefix = data.prefix;
  assert.equal(code, 0);
  assert.equal(data.cwd, await realpath(root));
  assert.deepEqual(data.args.slice(-2), ['--testNamePattern', 'literal $value; with spaces']);
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(join(prefix, 'package.json')), { code: 'ENOENT' });
  await assert.rejects(import('node:fs/promises').then(fs => fs.stat(prefix)), { code: 'ENOENT' });
  assert.ok(Date.now() - started >= 5000, 'TERM-resistant descendant requires escalation');
  await writeFile(fake, 'process.exit(7);\n');
  const failure = spawn(process.execPath, [launcher], { env: { ...process.env, npm_execpath: fake }, stdio: 'inherit' });
  assert.equal((await once(failure, 'exit'))[0], 7);
  console.log(JSON.stringify({ descendantStopped: true, prefixRemoved: true, cwdAndArgumentsPreserved: true, exitCodePreserved: 7 }));
} finally {
  if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  if (prefix) await rm(prefix, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
