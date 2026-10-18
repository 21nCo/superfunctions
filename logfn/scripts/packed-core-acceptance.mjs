import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'logfn-packed-'));
const run = (cmd, args, cwd = temporary) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, 'logfn/typescript')));
  assert.ok(pack.files.every(file => file.path === 'package.json' || file.path.startsWith('dist/') || /^(README|LICENSE)/.test(file.path)));
  assert.ok(pack.files.every(file => !file.path.includes('.test.')));
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, pack.filename)]);
  writeFileSync(join(temporary, 'consumer.mts'), `import { createLogger, sinkHttp, type HttpSink } from '@logfn/core';
const sink: HttpSink = sinkHttp({ url: 'https://example.test', offlineBuffer: 'indexeddb', offlineKey: 'tenant' });
const logger = createLogger({ name: 'consumer', sinks: [sink], onError(error, context) { console.log(error.message, context.sink); } });
void logger.flush(); void sink.close();`);
  writeFileSync(join(temporary, 'consumer.cts'), `async function use(){const {createLogger}=await import('@logfn/core');return createLogger({name:'consumer',sinks:[()=>{}]});}void use;`);
  for (const mode of ['Node16', 'NodeNext']) {
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts']);
  }
  writeFileSync(join(temporary, 'smoke.mjs'), `import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createLogger,sinkHttp,redactSecFn} from '@logfn/core';
const received=[]; const server=createServer(async(req,res)=>{let body='';for await(const chunk of req) body+=chunk;received.push(JSON.parse(body));res.writeHead(202).end();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{const sink=sinkHttp({url:'http://127.0.0.1:'+server.address().port});const logger=createLogger({name:'packed',pipeline:[redactSecFn()],sinks:[sink]});const ctx={email:'private@example.com'};ctx.self=ctx;logger.info('packed',ctx);await logger.flush();await sink.close();assert.equal(received.length,1);assert.equal(received[0].events[0].ctx.email,'[redacted]');assert.match(JSON.stringify(received),/circular/);console.log('packed HTTP/redaction/shutdown',process.version);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}`);
  writeFileSync(join(temporary, 'smoke.cjs'), `import('@logfn/core').then(({createLogger})=>{const logger=createLogger({name:'cjs-dynamic',sinks:[()=>{}]});logger.info('ok');return logger.flush();}).catch(error=>{console.error(error);process.exitCode=1;});`);
  for (const version of ['18.17.0', '20.19.0', '22']) {
    console.log(run('npm', ['exec', '--yes', `--package=node@${version}`, '--', 'node', 'smoke.mjs']).trim());
    run('npm', ['exec', '--yes', `--package=node@${version}`, '--', 'node', 'smoke.cjs']);
  }
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: temporary, encoding: 'utf8' });
  const report = JSON.parse(audit.stdout); assert.equal(report.metadata.vulnerabilities.total, 0);
  console.log(JSON.stringify({ ok: true, declarations: ['Node16', 'NodeNext'], productionVulnerabilities: report.metadata.vulnerabilities }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
