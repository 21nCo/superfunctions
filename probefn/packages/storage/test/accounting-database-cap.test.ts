import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RunQuota } from '../src/run-quota.js';
import { ArtifactStore } from '../src/artifact-store.js';

describe('accounting database pager cap', () => {
  it('bounds real database growth, rolls back FULL, and persists the minimum across reopen', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'probefn-accounting-cap-'));
    const budget=65536+123; // Deliberately not page aligned: round down, never up.
    try {
      const quota=new RunQuota(root,'.artifacts',1024,budget);
      const first=new ArtifactStore({repoRoot:root,caps:{maxArtifactBytes:1024,maxAccountingDatabaseBytes:budget}});
      await first.writeArtifact('.artifacts/runs/retained/evidence.txt','retained evidence');
      let rejected: unknown; let accepted=0; let rejectedId='';
      for(let i=0;i<2000;i++) {
        try { await quota.transaction(`run_${i}_${'x'.repeat(100)}`,'.artifacts/unused',async()=>undefined);accepted++; }
        catch(error){rejected=error;rejectedId=`run_${i}_${'x'.repeat(100)}`;break;}
      }
      expect(accepted).toBeGreaterThan(0);
      expect(rejected).toMatchObject({code:'E_STORAGE_CAP_EXCEEDED',details:{budget:'accounting-database'}});
      const filename=path.join(root,'.artifacts/.quota.sqlite');
      const info=await stat(filename);
      expect(info.size).toBeLessThanOrEqual(budget);
      const database=new DatabaseSync(filename);
      const before=database.prepare('SELECT count(*) AS count FROM run_caps').get()!.count;
      expect(database.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
      expect(database.prepare('SELECT max_bytes FROM accounting_limits').get()!.max_bytes).toBe(budget);
      database.close();
      const reopened=new RunQuota(root,'.artifacts',1024,1024*1024);
      await expect(reopened.transaction(rejectedId,'.artifacts/unused',async()=>undefined)).rejects.toMatchObject({code:'E_STORAGE_CAP_EXCEEDED'});
      const checked=new DatabaseSync(filename);
      expect(checked.prepare('SELECT count(*) AS count FROM run_caps').get()!.count).toBe(before);
      expect(checked.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
      checked.close();
      expect(await readFile(path.join(root,'.artifacts/runs/retained/evidence.txt'),'utf8')).toBe('retained evidence');
      expect((await readdir(path.join(root,'.artifacts'))).filter(name=>/\.sqlite-(journal|wal|shm)$/.test(name))).toEqual([]);
      console.log(JSON.stringify({accountingBudget:budget,databaseBytes:info.size,allocatedBytes:info.blocks*512,acceptedRows:accepted,fullRollback:true}));
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('keeps a persisted lower budget across concurrent independent processes', async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'probefn-accounting-process-'));
    try {
      await new RunQuota(root,'.artifacts',1024,65536).transaction('seed','.artifacts/unused',async()=>undefined);
      const source=fileURLToPath(new URL('../src/run-quota.ts',import.meta.url));
      const worker=path.join(root,'worker.ts');
      await writeFile(worker, `import {RunQuota} from ${JSON.stringify(source)};
const quota=new RunQuota(${JSON.stringify(root)},'.artifacts',1024,Number(process.argv[3]));
async function main(){for(let i=0;i<2000;i++){try{await quota.transaction(process.argv[2]+'_'+i+'_'+ 'x'.repeat(100),'.artifacts/unused',async()=>undefined);}catch(error){if(error.code!=='E_STORAGE_CAP_EXCEEDED')throw error;console.log(JSON.stringify({code:error.code,budget:error.details.maxAccountingDatabaseBytes}));return;}}throw Error('Expected pager pressure');}main().catch(error=>{console.error(error);process.exitCode=1;});`);
      const jiti=path.join(path.dirname(createRequire(import.meta.url).resolve('jiti')),'jiti-cli.mjs');
      const results=await Promise.all([65536,1048576].map((limit,i)=>promisify(execFile)(process.execPath,[jiti,worker,'writer'+i,String(limit)],{timeout:15000})));
      for(const result of results)expect(JSON.parse(result.stdout)).toEqual({code:'E_STORAGE_CAP_EXCEEDED',budget:65536});
      const database=new DatabaseSync(path.join(root,'.artifacts/.quota.sqlite'));
      expect(database.prepare('SELECT max_bytes FROM accounting_limits').get()!.max_bytes).toBe(65536);
      expect(database.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
      database.close();
      expect((await stat(path.join(root,'.artifacts/.quota.sqlite'))).size).toBeLessThanOrEqual(65536);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('opens legacy accounting schema without changing its stored run cap', async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'probefn-accounting-legacy-'));
    try {
      await mkdir(path.join(root,'.artifacts'));
      const filename=path.join(root,'.artifacts/.quota.sqlite');
      const old=new DatabaseSync(filename);
      old.exec("CREATE TABLE run_caps (run_id TEXT PRIMARY KEY, cap INTEGER NOT NULL); INSERT INTO run_caps VALUES ('legacy',17)");old.close();
      await new RunQuota(root,'.artifacts',1024).transaction('legacy','.artifacts/unused',async quota=>{
        expect(()=>quota.reserve(18,'artifact')).toThrow(expect.objectContaining({code:'E_STORAGE_CAP_EXCEEDED'}));
      });
      const checked=new DatabaseSync(filename);
      expect(checked.prepare("SELECT cap FROM run_caps WHERE run_id='legacy'").get()!.cap).toBe(17);
      expect(checked.prepare('SELECT max_bytes FROM accounting_limits').get()!.max_bytes).toBe(16*1024*1024);
      checked.close();
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('validates budget and refuses an existing database above a newly lower limit', async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'probefn-accounting-lower-'));
    try {
      for(const value of [0,65535,Infinity,1.5])expect(()=>new RunQuota(root,'.artifacts',1024,value)).toThrow(TypeError);
      const quota=new RunQuota(root,'.artifacts',1024,131072);
      for(let i=0;i<150;i++)await quota.transaction(`run_${i}_${'x'.repeat(100)}`,'.artifacts/unused',async()=>undefined);
      const filename=path.join(root,'.artifacts/.quota.sqlite');
      expect((await stat(filename)).size).toBeGreaterThan(65536);
      await expect(new RunQuota(root,'.artifacts',1024,65536).transaction('lower','.artifacts/unused',async()=>undefined)).rejects.toMatchObject({code:'E_STORAGE_CAP_EXCEEDED'});
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
