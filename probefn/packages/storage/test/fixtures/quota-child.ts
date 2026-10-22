import { ArtifactStore } from '../../src/artifact-store.js';
const [root, mode, name] = process.argv.slice(2);
const store = new ArtifactStore({ repoRoot: root!, caps: { maxArtifactBytes: 10 } });
try {
  if (mode === 'crash') {
    await store.writeArtifact('.artifacts/runs/run/existing', 'xx');
    await store.writeArtifactStream('.artifacts/runs/run/interrupted', async write => {
      await write('123456');
      process.stdout.write('READY\n');
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
    });
  } else {
    await store.writeArtifact(`.artifacts/runs/run/${name}`, '123456');
    console.log(JSON.stringify({ ok: true }));
  }
} catch (error) { console.log(JSON.stringify({ ok: false, code: (error as {code?: string}).code, message: (error as Error).message, cause: String((error as {cause?: unknown}).cause) })); }
