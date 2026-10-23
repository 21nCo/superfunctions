import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';
import { createJiti } from 'jiti';
const [root, mode] = process.argv.slice(2);
const originalOpen = fsp.open;
const hold = () => {
  fs.writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (mode === 'uncommitted' && sql === 'COMMIT' && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='event_append_intents'").get() && this.prepare('SELECT 1 FROM event_append_intents').get()) hold();
  return originalExec.call(this, sql);
};
fsp.open = async (...args) => {
  if (mode === 'race' && /console(?:-\d+)?\.ndjson$/.test(String(args[0])) && (Number(args[1]) & fs.constants.O_APPEND)) await fsp.appendFile(args[0], '{\"external\":true}\n');
  const handle = await originalOpen(...args);
  if (/console(?:-\d+)?\.ndjson$/.test(String(args[0]))) {
    const write = handle.writeFile.bind(handle);
    const sync = handle.sync.bind(handle);
    let wrote = false;
    handle.writeFile = async data => {
      if (mode === 'before') hold();
      if (mode === 'partial') {
        // Split inside the UTF-8 emoji; recovery must compare bytes, not decode a prefix.
        const bytes = Buffer.from(data);
        const offset = bytes.indexOf(Buffer.from('😀'));
        await write(bytes.subarray(0, offset + 2)); await sync(); hold();
      }
      await write(data); wrote = true;
    };
    handle.sync = async () => { await sync(); if (wrote && mode === 'after') hold(); };
  }
  return handle;
};
syncBuiltinESMExports();
const { ArtifactStore } = await createJiti(import.meta.url).import('../../src/artifact-store.ts');
const store = new ArtifactStore({ repoRoot: root });
try {
  await store.createEventSink('run', 'console', 'events').append({ message: '😀 durable', token: 'PRIVATE_SECRET_MUST_NOT_PERSIST' });
} catch (error) {
  if (mode !== 'race') throw error;
  console.log(JSON.stringify({ code: error.code })); process.exit(0);
}
throw new Error('Crash injection was not reached');
