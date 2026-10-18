/** Verify packed FlowFn and local shared prerequisites in an isolated install. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'flowfn-packed-'));
function run(program, args, cwd = fixture) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packages = ['packages/http', 'mcpfn/core', 'packages/admin', 'flowfn/typescript', 'flowfn/admin'];
  const tars = packages.map(path => {
    const result = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', fixture], join(root, path)))[0];
    if (path === 'flowfn/typescript' && result.files.some(file => /^(src|tests|scripts)\//.test(file.path)))
      throw new Error('Core archive contains development-only files');
    return join(fixture, result.filename);
  });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'flowfn-packed-acceptance', private: true, version: '1.0.0' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tars, 'typescript@5.9.3', '@types/node@20']);
  const body = `
let observed = 0;
const instrumentation = new FlowInstrumentation({ tracer: { startActiveSpan: (_name, _options, callback) => { observed++; return callback({ end() {}, recordException() {}, setStatus() {} }); } } });
instrumentation.enable();
const flow = createFlow({ adapter: new MemoryAdapter() });
const queue = flow.queue('packed');
queue.process(async job => job.data * 2);
const job = await queue.add('work', 21);
await queue.drain();
if ((await queue.getJob(job.id)).returnvalue !== 42) throw new Error('Packed processing failed');
await flow.close();
instrumentation.disable();
if (observed < 2) throw new Error('Packed instrumentation entry point does not share runtime state');
if (typeof RedisAdapter !== 'function' || typeof PostgresAdapter !== 'function') throw new Error('Missing adapter export');
`;
  writeFileSync(join(fixture, 'consumer.mjs'), `import { createFlow } from '@flowfn/core';\nimport { FlowInstrumentation } from '@flowfn/core/instrumentation';\nimport { MemoryAdapter } from '@flowfn/core/adapters/memory';\nimport { RedisAdapter } from '@flowfn/core/adapters/redis';\nimport { PostgresAdapter } from '@flowfn/core/adapters/postgres';\nimport * as admin from '@flowfn/admin';\nif (!admin.flowFnAdminCapability) throw new Error('Missing admin export');\n${body}`);
  writeFileSync(join(fixture, 'consumer.cjs'), `const { createFlow } = require('@flowfn/core');\nconst { FlowInstrumentation } = require('@flowfn/core/instrumentation');\nconst { MemoryAdapter } = require('@flowfn/core/adapters/memory');\nconst { RedisAdapter } = require('@flowfn/core/adapters/redis');\nconst { PostgresAdapter } = require('@flowfn/core/adapters/postgres');\n(async () => {${body}})().catch(error => { console.error(error); process.exitCode = 1; });`);
  run(process.execPath, ['consumer.mjs']);
  run(process.execPath, ['consumer.cjs']);
  run(process.execPath, ['-e', "const pkg=require('@flowfn/core/package.json');if(typeof require('@flowfn/core')[pkg.superfunctions.initFunction]!=='function')throw Error('Invalid initializer metadata')"]);
  const types = `import { FlowInstrumentation } from '@flowfn/core/instrumentation';\nnew FlowInstrumentation().enable();\nimport { createFlow, type Job, type BackoffStrategy } from '@flowfn/core';\nimport { MemoryAdapter } from '@flowfn/core/adapters/memory';\nimport { RedisAdapter } from '@flowfn/core/adapters/redis';\nimport { PostgresAdapter } from '@flowfn/core/adapters/postgres';\nconst strategy: BackoffStrategy = (attempt, error, job) => attempt;\nconst queue = createFlow({ adapter: new MemoryAdapter() }).queue<{ value: number }>('typed', { backoffStrategies: { strategy } });\nqueue.process(async job => job.data.value);\nvoid RedisAdapter; void PostgresAdapter;\n`;
  writeFileSync(join(fixture, 'consumer.mts'), types);
  writeFileSync(join(fixture, 'consumer.cts'), types);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'false', 'consumer.mts', 'consumer.cts']);
  const audit = JSON.parse(run('npm', ['audit', '--omit=dev', '--json']));
  console.log(JSON.stringify({ runtime: process.version, esm: 'passed', commonjs: 'passed', types: 'passed', audit: audit.metadata.vulnerabilities, localPrerequisites: packages.slice(0, 3) }));
} finally { rmSync(fixture, { recursive: true, force: true }); }
