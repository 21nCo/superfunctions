import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../typescript/", import.meta.url));
await mkdir(join(root, ".conduct"), { recursive: true });
const directory = await mkdtemp(join(root, ".conduct/sqlite-"));
try {
  const worker = join(directory, "worker.mjs");
  await writeFile(
    worker,
    `import Database from 'better-sqlite3';import {drizzle} from 'drizzle-orm/better-sqlite3';import {sqliteTable,text,integer} from 'drizzle-orm/sqlite-core';import {drizzleAdapter} from '@superfunctions/db/adapters/drizzle';import {TestStorage,getArtifactId} from '../../dist/index.js';
const sqlite=new Database(process.argv[3]);sqlite.exec('CREATE TABLE IF NOT EXISTS testfn_runs (id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS testfn_artifacts (id TEXT PRIMARY KEY,runId TEXT NOT NULL,data TEXT NOT NULL)');
const schema={testfn_runs:sqliteTable('testfn_runs',{id:text('id').primaryKey(),timestamp:integer('timestamp').notNull(),data:text('data').notNull()}),testfn_artifacts:sqliteTable('testfn_artifacts',{id:text('id').primaryKey(),runId:text('runId').notNull(),data:text('data').notNull()})};
const adapter=drizzleAdapter({db:drizzle(sqlite,{schema}),dialect:'sqlite'});const storage=new TestStorage({type:'db',adapter,retentionDays:1});await storage.open();try{if(process.argv[2]==='write'){await storage.saveRun({id:'persisted',timestamp:Date.now(),environment:{platform:'acceptance'},summary:{total:1,passed:1,failed:0,skipped:0,duration:4},results:[{id:'same',status:'passed',duration:4,artifacts:[{type:'log',path:'log.txt',buffer:Buffer.from('durable')}]}]});console.log(JSON.stringify({rows:sqlite.prepare('SELECT count(*) AS n FROM testfn_runs').get().n}));}else{const run=await storage.getRun('persisted');const artifact=await storage.getArtifact(getArtifactId('persisted','same','log'));console.log(JSON.stringify({id:run?.id,count:(await storage.getTestHistory('same',10)).length,artifact:artifact?.buffer?.toString()}));}}finally{await storage.close();if(sqlite.open)sqlite.close();}`,
  );
  const execute = (mode) => {
    const result = spawnSync(
      process.execPath,
      [worker, mode, join(directory, "test.sqlite")],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(execute("write").rows, 1);
  assert.deepEqual(execute("read"), {
    id: "persisted",
    count: 1,
    artifact: "durable",
  });
  console.log(
    "SQLite: independent processes persisted runs, history and binary artifacts with shared schema ownership",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
