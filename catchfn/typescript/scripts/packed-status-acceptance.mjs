// Build Watch browser, DrawFn and CatchFn first. Uses fresh tarball consumers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const reactMajor = process.env.CATCHFN_REACT_MAJOR ?? '18';
if (!['18', '19'].includes(reactMajor)) throw new Error('CATCHFN_REACT_MAJOR must be 18 or 19');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'catchfn-packed-status-'));
const npm = (args, cwd = directory) => execFileSync(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, { cwd, encoding: 'utf8', stdio: 'pipe' });
try {
  const tarballs = ['watchfn/agents/browser', 'drawfn/core', 'catchfn/typescript'].map(path => {
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], join(root, path)));
    return join(directory, pack.filename);
  });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, '@types/node@22', `@types/react@${reactMajor}`, `react@${reactMajor}`, `react-dom@${reactMajor}`]);
  const consumer = `import {BrowserClient, parseBugIssueStatus, type BrowserBugIssueStatus} from '@watchfn/browser';
import {catchFn, type IssueStatusConfig, type BugIntegrationHint} from 'catchfn';
import type {CatchFnReporterButtonProps} from 'catchfn/react';
export const reference={app:'shop',reportId:'one'};
export const browser=new BrowserClient({endpoint:'https://example.test/watch/ingest',projectId:'shop',autoTrack:false});
export const status:Promise<BrowserBugIssueStatus|null>=browser.readBugIssueStatus(reference);
export const polling:IssueStatusConfig={enabled:true,read:(ref,options)=>browser.readBugIssueStatus(ref,options)};
export const hint:BugIntegrationHint={target:'github',project:'acme/bugs'};
export const catcher=catchFn({name:'shop',integration:hint,issueStatus:polling});
export const props:CatchFnReporterButtonProps={catcher};
export const receipt=parseBugIssueStatus({app:'shop',reportId:'one',target:'github',state:'pending',issueId:null,issueUrl:null},reference);
`;
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `consumer.${extension}`), consumer);
  for (const mode of ['Node16', 'NodeNext']) execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--declaration', '--emitDeclarationOnly', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts'], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  const check = `async function check(BrowserClient,catchFn){
    const pending={app:'shop',reportId:'one',target:'github',state:'pending',issueId:null,issueUrl:null};
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(pending)};
    const browser=new BrowserClient({endpoint:'https://example.test/mount/ingest',projectId:'shop',autoTrack:false});
    assert.deepEqual(await browser.readBugIssueStatus({app:'shop',reportId:'one'}),pending);
    const catcher=catchFn({name:'shop',issueStatus:{enabled:true,maxAttempts:1,read:(ref,options)=>browser.readBugIssueStatus(ref,options)}});
    assert.deepEqual(await catcher.pollIssueStatus('one'),pending);assert.equal(calls,2);catcher.stop();await browser.close();
  }`;
  writeFileSync(join(directory, 'runtime.mjs'), `import assert from 'node:assert/strict';import {BrowserClient} from '@watchfn/browser';import {catchFn} from 'catchfn';${check}\nawait check(BrowserClient,catchFn);`);
  writeFileSync(join(directory, 'runtime.cjs'), `const assert=require('node:assert/strict');const {BrowserClient}=require('@watchfn/browser');const {catchFn}=require('catchfn');${check}\ncheck(BrowserClient,catchFn).catch(error=>{console.error(error);process.exitCode=1});`);
  for (const file of ['runtime.mjs', 'runtime.cjs']) execFileSync(process.execPath, [file], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(join(directory, 'react.mjs'), `import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {catchFn} from 'catchfn';import {CatchFnReporterButton} from 'catchfn/react';const catcher=catchFn({name:'react'});try{assert.match(renderToStaticMarkup(React.createElement(CatchFnReporterButton,{catcher})),/Report a bug/);console.log('CatchFn React '+React.version+' SSR passed')}finally{catcher.stop()}`);
  console.log(execFileSync(process.execPath,['react.mjs'],{cwd:directory,encoding:'utf8',stdio:'pipe'}).trim());
  console.log('Fresh Watch browser/CatchFn tarballs: ESM and CJS status reads/polling plus strict Node16/NodeNext public declaration consumers passed');
} catch (error) {
  if (error.stdout) console.error(String(error.stdout)); if (error.stderr) console.error(String(error.stderr)); throw error;
} finally { rmSync(directory, { recursive: true, force: true }); }
