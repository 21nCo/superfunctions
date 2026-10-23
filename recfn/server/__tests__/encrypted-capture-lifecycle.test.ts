import { expect, it } from 'vitest';
import { captureToFile } from '../src/recording/capture.js';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

it('keeps native FFmpeg output encrypted on disk while exposing valid bounded upload bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recfn-encrypted-output-'));
  const plaintext = Buffer.alloc(16000 * 2, 'private meeting audio payload ');
  const artifact = await captureToFile(new ReadableStream({ start(c) { c.enqueue({ data: plaintext, timestamp: 0, encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }); c.close(); } }), { recordingFormat: 'audio_only', temporaryDirectory: root });
  try {
    const directories = await readdir(root); expect(directories).toHaveLength(1);
    const directory = join(root, directories[0]); expect(await readdir(directory)).toEqual(['recording.enc']);
    const ciphertext = await readFile(join(directory, 'recording.enc'));
    expect(ciphertext.includes(plaintext.subarray(0, 128))).toBe(false);
    const decoded = Buffer.from(await new Response(artifact.openStream()).arrayBuffer());
    expect(decoded.subarray(0, 4).toString()).toBe('RIFF');
    expect(decoded.subarray(decoded.length - plaintext.length)).toEqual(plaintext);
    expect(artifact.size).toBe(decoded.length); expect(artifact.duration).toBe(1000);
    expect(ciphertext.length).toBe(decoded.length + Math.ceil(decoded.length / 65536) * 28);
  } finally { await artifact.dispose(); expect(await readdir(root)).toEqual([]); await rm(root, { recursive: true, force: true }); }
});

it('leaves only ciphertext after a real worker SIGKILL and closes its encoder pipes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recfn-encrypted-crash-'));
  const wrapper = join(root, 'ffmpeg-owned');
  // The wrapper records its own PID before exec, so cleanup never guesses another process.
  await writeFile(wrapper, `#!/bin/sh\necho $$ > '${join(root, 'encoder.pid')}'\nexec ffmpeg "$@"\n`, { mode: 0o700 });
  const source = `import {captureToFile} from ${JSON.stringify(resolve('dist/recording/capture.js'))};
import {readdir,stat} from 'node:fs/promises'; import {join} from 'node:path';
const root=${JSON.stringify(root)};
void captureToFile(new ReadableStream({start(c){c.enqueue({data:new Uint8Array(2*1024*1024).fill(42),timestamp:0,encoding:'pcm_s16le',sampleRate:16000,channels:1});}}),{recordingFormat:'audio_only',temporaryDirectory:root,ffmpegPath:${JSON.stringify(wrapper)}}).catch(error=>{console.error(error);process.exitCode=1;});
let sent=false;const timer=setInterval(async()=>{if(sent)return;const directory=(await readdir(root)).find(name=>name.startsWith('recfn-media-'));if(directory){const filename=join(root,directory,'recording.enc');const info=await stat(filename).catch(()=>null);if(info&&info.size>=65564&&!sent){sent=true;clearInterval(timer);console.log(JSON.stringify({filename}));}}},20);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stdout = '', stderr = ''; let encoder: number | undefined;
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return true; } };
  try {
    await expect.poll(() => { if (child.exitCode !== null) throw new Error(stderr); return stdout.includes('\n'); }, { timeout: 5000 }).toBe(true);
    const { filename } = JSON.parse(stdout.trim());
    encoder = Number(await readFile(join(root, 'encoder.pid'), 'utf8'));
    child.kill('SIGKILL'); await exited;
    await expect.poll(() => gone(encoder!), { timeout: 5000 }).toBe(true);
    const encrypted = await readFile(filename);
    expect(encrypted.length).toBeGreaterThanOrEqual(65564);
    expect(encrypted.includes(Buffer.alloc(128, 42))).toBe(false);
    expect(await readdir(join(filename, '..'))).toEqual(['recording.enc']);
    // No key sidecar exists; crash remnants require operator cleanup, not automatic replay.
    expect((await readdir(root)).sort()).toEqual(['encoder.pid', 'ffmpeg-owned', filename.split('/').at(-2)].sort());
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    encoder ??= Number(await readFile(join(root, 'encoder.pid'), 'utf8').catch(() => '0'));
    if (encoder && !gone(encoder)) { process.kill(encoder, 'SIGKILL'); await expect.poll(() => gone(encoder!), { timeout: 3000 }).toBe(true); }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
