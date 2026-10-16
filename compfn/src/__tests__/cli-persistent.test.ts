import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

it("persists CLI initialization, attestation, checks and export across SQLite processes", () => {
  const dir = mkdtempSync(resolve(".cli-sqlite-"));
  const cli = resolve("cli/dist/index.js");
  const config = join(dir, "config.mjs");
  const invoke = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
  const run = (...args: string[]) => {
    const result = invoke([cli, ...args, "--config", config]);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    writeFileSync(config, `
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter } from '@superfunctions/db/adapters/drizzle';
import { getCompfnSchema } from 'compfn';
import { appendFileSync } from 'node:fs';
const sqlite = new Database(new URL('./state.sqlite', import.meta.url).pathname);
const definitions = getCompfnSchema().schemas;
const schema = Object.fromEntries(definitions.map(table => [table.modelName, sqliteTable(table.modelName,
  Object.fromEntries(Object.entries(table.fields).map(([name, field]) => [name, field.type === 'number' ? integer(name) : field.type === 'json' ? text(name, { mode: 'json' }) : text(name)])))]));
const adapter = drizzleAdapter({ db: drizzle(sqlite, { schema }), dialect: 'sqlite' });
export default {
 database: { ...adapter,
  async initialize() {
    for (const table of definitions) sqlite.exec('CREATE TABLE IF NOT EXISTS "' + table.modelName + '" (' + Object.entries(table.fields).map(([name, field]) => '"' + name + '" ' + (field.type === 'number' ? 'INTEGER' : 'TEXT') + (name === 'id' ? ' PRIMARY KEY' : '')).join(',') + ')');
    appendFileSync(new URL('./lifecycle', import.meta.url), 'init\\n');
  },
  async close() { sqlite.close(); appendFileSync(new URL('./lifecycle', import.meta.url), 'close\\n'); }
 },
 adapters: { policy: { name: 'policy', async runCheck(input) {
   if (input.customConfig.expected !== 'persisted') throw new Error('JSON check configuration lost');
   return { type: 'custom_check', outcome: 'pass', payload: { verified: true } };
 } } }
};
`);
    run("init");
    const seed = join(dir, "seed.mjs");
    writeFileSync(seed, `
import config from './config.mjs';
import { compFn } from 'compfn';
await config.database.initialize();
try {
 const api = compFn({ ...config, logger: { info(){}, debug(){}, warn(){}, error(){} } });
 const control = await api.controls.create({ name:'Persistent', description:'SQLite', category:'security', tags:['stored'] });
 if (!control.ok) throw new Error(JSON.stringify(control));
 const framework = await api.frameworks.create({ name:'Acceptance', requirements:[{ requirementId:'R1', controlIds:[control.result.id] }] });
 const check = await api.checks.create({ name:'Policy', controlId:control.result.id, adapterName:'policy', customConfig:{expected:'persisted'} });
 if (!framework.ok || !check.ok) throw new Error(JSON.stringify({framework,check}));
 console.log(JSON.stringify({control:control.result.id,check:check.result.id}));
} finally { await config.database.close(); }
`);
    const seeded = invoke([seed]);
    expect(seeded.status, seeded.stderr).toBe(0);
    const ids = JSON.parse(seeded.stdout);
    run("attest", "--control-id", ids.control, "--actor-id", "auditor");
    run("run-checks", "--check-id", ids.check);
    const pack = JSON.parse(run("export"));
    expect(pack.controls[0].tags).toEqual(["stored"]);
    expect(pack.frameworks[0].requirements[0].controlIds).toEqual([ids.control]);
    expect(pack.evidence).toHaveLength(2);
    expect(pack.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ type:"manual_attestation", actorId:"auditor", outcome:"pass" }),
      expect.objectContaining({ type:"custom_check", outcome:"pass", payload:{verified:true} }),
    ]));
    const failed = invoke([cli, "attest", "--control-id", "missing", "--actor-id", "auditor", "--config", config]);
    expect(failed.status).toBe(1);
    expect(readFileSync(join(dir, "lifecycle"), "utf8").trim().split("\n")).toEqual(Array.from({length:6}, () => ["init", "close"]).flat());
  } finally { rmSync(dir, { recursive:true, force:true }); }
}, 30000);
