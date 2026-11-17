import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTesseractCliOCRProvider, meanWordConfidence } from '../src/tesseract-cli.js';

const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '1\t1\t0\t0\t0\t0\t0\t0\t100\t40\t-1\t',
  '5\t1\t1\t1\t1\t1\t0\t0\t40\t20\t90\tHello',
  '5\t1\t1\t1\t1\t2\t50\t0\t40\t20\t70\tworld',
  '5\t1\t1\t1\t1\t3\t90\t0\t10\t20\t95\t ',
].join('\n');

let directory: string;
let image: Uint8Array;

/** A stand-in `tesseract` that records its arguments and writes each requested output. */
async function fakeTesseract(exitCode = 0): Promise<string> {
  const binary = join(directory, `tesseract-${exitCode}`);
  await writeFile(binary, `#!/bin/sh
printf '%s\\n' "$@" > "${directory}/args"
[ ${exitCode} -ne 0 ] && { echo "Failed loading language" >&2; exit ${exitCode}; }
out="$2"; shift 2
for format in "$@"; do
  case "$format" in
    txt) printf '  Hello world\\n\\n' > "$out.txt" ;;
    tsv) cat > "$out.tsv" <<'TSV'
${TSV}
TSV
    ;;
    hocr) printf '<html>hocr</html>' > "$out.hocr" ;;
  esac
done
`);
  await chmod(binary, 0o755);
  return binary;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'filefn-tesseract-test-'));
  image = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer());
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const request = (includeHOCR: boolean) => ({
  input: { fileId: 'f', versionId: 'v', storageKey: 'k.png', mimeType: 'image/png', size: 1, fileName: 'k.png' },
  imageData: image,
  language: 'eng',
  includeHOCR,
});

describe('meanWordConfidence', () => {
  it('averages the confidence of recognized words only', () => {
    expect(meanWordConfidence(TSV)).toBe(80);
    expect(meanWordConfidence(TSV.split('\n')[0])).toBe(0);
  });
});

describe('createTesseractCliOCRProvider', () => {
  it('returns the trimmed text and word confidence, and hOCR only when asked', async () => {
    const provider = createTesseractCliOCRProvider({ binary: await fakeTesseract() });

    const plain = await provider.recognize(request(false));
    const args = (await readFile(join(directory, 'args'), 'utf8')).trim().split('\n');
    const withHocr = await provider.recognize(request(true));

    expect(plain).toEqual({ text: 'Hello world', confidence: 80, hocr: null });
    expect(args.slice(2)).toEqual(['-l', 'eng', '--psm', '6', '-c', 'preserve_interword_spaces=1', 'txt', 'tsv']);
    expect(withHocr.hocr).toBe('<html>hocr</html>');
  });

  it('rejects with the command error and removes its working directory', async () => {
    const provider = createTesseractCliOCRProvider({ binary: await fakeTesseract(1) });

    await expect(provider.recognize(request(false))).rejects.toThrow('tesseract failed: Failed loading language');
    const workDirectory = (await readFile(join(directory, 'args'), 'utf8')).split('\n')[0].replace(/\/input\.png$/, '');
    await expect(readdir(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
