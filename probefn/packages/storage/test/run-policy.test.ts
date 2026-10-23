import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifact-store.js';

it('retains explicit run limits above defaults across ordinary writers without permitting later increases', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'probefn-run-policy-'));
  try {
    const caps={maxArtifactBytes:4*1024**3,maxEventsPerSink:100000,maxAccountingDatabaseBytes:32*1024**2};
    const configured=new ArtifactStore({repoRoot:root,caps});
    await configured.initializeRunPolicy('configured');
    await configured.writeArtifact('.artifacts/runs/configured/events/console.ndjson',Array.from({length:50000},(_,sequence)=>JSON.stringify({sequence})).join('\n')+'\n');
    const reopened=new ArtifactStore({repoRoot:root});
    const append=await reopened.createEventSink('configured','console','events').append({sequence:50000});
    expect(append.sinkIndex).toBe(1);expect(append.eventCount).toBe(50001);expect(append.warning).toBeUndefined();
    await new ArtifactStore({repoRoot:root,caps:{maxArtifactBytes:8*1024**3,maxEventsPerSink:200000,maxAccountingDatabaseBytes:64*1024**2}}).initializeRunPolicy('configured');
    const database=new DatabaseSync(path.join(root,'.artifacts/.quota.sqlite'));
    expect(database.prepare('SELECT cap,max_events FROM run_caps WHERE run_id=?').get('configured')).toMatchObject({cap:caps.maxArtifactBytes,max_events:caps.maxEventsPerSink});
    expect(database.prepare('SELECT max_bytes FROM accounting_limits').get()!.max_bytes).toBe(caps.maxAccountingDatabaseBytes);
    database.close();
  } finally {await rm(root,{recursive:true,force:true});}
});
