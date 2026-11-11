import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REGISTRY_CATALOG_PATH,
  REGISTRY_SIGNATURE_JSON_PATH,
  REGISTRY_SIGNATURE_TS_PATH,
  createAwsCliKmsClient,
  registryKeyId,
  registryV2SigningInput,
  signRegistryCatalogWithKms,
  writeFilesAtomically,
} from './sign-uifn-registry-kms.mjs';

const scriptPath = fileURLToPath(new URL('./sign-uifn-registry-kms.mjs', import.meta.url));
const scriptUrl = pathToFileURL(scriptPath).href;
const KMS_KEY_ARN = 'arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000';
const CATALOG = '{\n  "schemaVersion": 2,\n  "artifacts": []\n}\n';
const V1_JSON = '{\n  "schemaVersion": 1\n}\n';
const V1_TS = '/* v1 */\nexport const REGISTRY_SIGNATURE = { "schemaVersion": 1 } as const;\n';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const relative of [REGISTRY_CATALOG_PATH, REGISTRY_SIGNATURE_TS_PATH]) mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, REGISTRY_CATALOG_PATH), CATALOG);
  writeFileSync(path.join(root, REGISTRY_SIGNATURE_JSON_PATH), V1_JSON);
  writeFileSync(path.join(root, REGISTRY_SIGNATURE_TS_PATH), V1_TS);
  return root;
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey, spki, keyId: createHash('sha256').update(spki).digest('hex').slice(0, 24) };
}

function mockKms(keys, overrides = {}) {
  const calls = [];
  return {
    calls,
    async getPublicKey(input) {
      calls.push(['GetPublicKey', input]);
      return { KeyId: KMS_KEY_ARN, KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY', PublicKey: keys.spki, ...overrides.publicKey };
    },
    async sign(input) {
      calls.push(['Sign', input]);
      const signer = overrides.signWith ?? keys.privateKey;
      return { KeyId: KMS_KEY_ARN, SigningAlgorithm: input.SigningAlgorithm, Signature: sign(null, Buffer.from(input.Message), signer), ...overrides.sign };
    },
  };
}

function assertUnchanged(root) {
  assert.equal(readFileSync(path.join(root, REGISTRY_SIGNATURE_JSON_PATH), 'utf8'), V1_JSON);
  assert.equal(readFileSync(path.join(root, REGISTRY_SIGNATURE_TS_PATH), 'utf8'), V1_TS);
  for (const relative of [REGISTRY_SIGNATURE_JSON_PATH, REGISTRY_SIGNATURE_TS_PATH]) {
    const directory = path.dirname(path.join(root, relative));
    assert.deepEqual(readdirSync(directory).filter((name) => name.includes('.kms-sign')), []);
  }
}

/** A directory with two original files, removed after the test. */
function pair(t, first = V1_JSON, second = V1_TS) {
  const directory = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-write-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [path.join(directory, 'first.json'), path.join(directory, 'second.ts')];
  writeFileSync(files[0], first);
  writeFileSync(files[1], second);
  return { directory, files };
}

/** Real fs operations, except that the nth rename of a newly staged file over its target fails. */
function failingPublishRename(failAt) {
  const created = new Set();
  let publishes = 0;
  return {
    openSync(file, flags) {
      if (file.endsWith('.kms-sign.tmp')) created.add(file);
      return openSync(file, flags);
    },
    renameSync(from, to) {
      if (created.delete(from)) {
        publishes += 1;
        if (publishes === failAt) throw Object.assign(new Error(`EIO: injected rename failure ${publishes}`), { code: 'EIO' });
      }
      renameSync(from, to);
    },
  };
}

const journalOf = (first) => `${first}.kms-sign.journal`;

/** Real fs operations, except that every lookup of `file` fails with EIO (fs.existsSync then reports it missing). */
function failingLookup(file) {
  return {
    existsSync: (candidate) => candidate !== file && existsSync(candidate),
    lstatSync(candidate, options) {
      if (candidate === file) throw Object.assign(new Error(`EIO: injected lookup failure ${path.basename(file)}`), { code: 'EIO' });
      return lstatSync(candidate, options);
    },
  };
}

const failingStaging = {
  openSync(file, flags) {
    if (file.endsWith('.kms-sign.tmp')) throw new Error('EIO: injected staging failure');
    return openSync(file, flags);
  },
};

test('signing input is exactly UTF8("uifn-registry-v2\\0") followed by SHA-256 of the catalog bytes', () => {
  const input = registryV2SigningInput(Buffer.from(CATALOG));
  assert.equal(input.length, 49);
  assert.equal(input.subarray(0, 17).toString('hex'), '7569666e2d72656769737472792d763200');
  assert.equal(input.subarray(17).toString('hex'), createHash('sha256').update(CATALOG).digest('hex'));
});

test('signs the digest input with RAW / ED25519_SHA_512 and writes a verifiable v2 envelope', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys);
  const { envelope, files } = await signRegistryCatalogWithKms({ root, kms, kmsKeyId: 'alias/uifn-registry', expectedKeyId: keys.keyId });

  const signCalls = kms.calls.filter(([name]) => name === 'Sign');
  assert.equal(signCalls.length, 1);
  const [, request] = signCalls[0];
  assert.equal(request.KeyId, 'alias/uifn-registry');
  assert.equal(request.MessageType, 'RAW');
  assert.equal(request.SigningAlgorithm, 'ED25519_SHA_512');
  assert.deepEqual(Buffer.from(request.Message), registryV2SigningInput(Buffer.from(CATALOG)));
  assert.deepEqual(kms.calls.find(([name]) => name === 'GetPublicKey')[1], { KeyId: 'alias/uifn-registry' });

  const catalogSha256 = createHash('sha256').update(CATALOG).digest('hex');
  const written = JSON.parse(readFileSync(path.join(root, REGISTRY_SIGNATURE_JSON_PATH), 'utf8'));
  assert.deepEqual(written, envelope);
  assert.deepEqual(Object.keys(written), ['schemaVersion', 'algorithm', 'domain', 'keyId', 'catalogSha256', 'signatureBase64']);
  assert.equal(written.schemaVersion, 2);
  assert.equal(written.algorithm, 'Ed25519');
  assert.equal(written.domain, 'uifn-registry-v2');
  assert.equal(written.keyId, keys.keyId);
  assert.equal(written.keyId, registryKeyId(keys.spki));
  assert.equal(written.catalogSha256, catalogSha256);

  // Offline verification with only the public key: the domain-separated digest verifies, the raw catalog (v1) does not.
  const signature = Buffer.from(written.signatureBase64, 'base64');
  const offlineInput = Buffer.concat([Buffer.from('uifn-registry-v2\0', 'utf8'), Buffer.from(catalogSha256, 'hex')]);
  assert.equal(verify(null, offlineInput, keys.publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(CATALOG), keys.publicKey, signature), false);

  const ts = readFileSync(path.join(root, REGISTRY_SIGNATURE_TS_PATH), 'utf8');
  assert.equal(ts, `/* Generated detached registry signature. */\nexport const REGISTRY_SIGNATURE = ${JSON.stringify(envelope, null, 2)} as const;\n`);
  assert.deepEqual(files, [REGISTRY_SIGNATURE_JSON_PATH, REGISTRY_SIGNATURE_TS_PATH]);
  assert.deepEqual(readdirSync(path.dirname(path.join(root, REGISTRY_SIGNATURE_JSON_PATH))).filter((name) => name.endsWith('.tmp')), []);
});

test('refuses and writes nothing when the KMS signature does not verify against the KMS public key', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys, { signWith: keyPair().privateKey });
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }),
    { code: 'UIFN_REGISTRY_KMS_SIGNATURE_INVALID' },
  );
  assertUnchanged(root);
});

test('refuses and writes nothing when KMS returns a signature over different bytes', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys, { sign: { Signature: sign(null, Buffer.from(CATALOG), keys.privateKey) } });
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }),
    { code: 'UIFN_REGISTRY_KMS_SIGNATURE_INVALID' },
  );
  assertUnchanged(root);
});

test('refuses before signing and writes nothing when the KMS key id differs from the expected key id', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys);
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keyPair().keyId }),
    { code: 'UIFN_REGISTRY_KMS_KEY_MISMATCH' },
  );
  assert.deepEqual(kms.calls.map(([name]) => name), ['GetPublicKey']);
  assertUnchanged(root);
});

test('refuses and writes nothing when Sign used a different KMS key than GetPublicKey', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys, { sign: { KeyId: `${KMS_KEY_ARN.slice(0, -1)}1` } });
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }),
    { code: 'UIFN_REGISTRY_KMS_KEY_MISMATCH' },
  );
  assertUnchanged(root);
});

test('refuses and writes nothing when KMS reports another signing algorithm', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys, { sign: { SigningAlgorithm: 'ED25519_PH_SHA_512' } });
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }),
    { code: 'UIFN_REGISTRY_KMS_RESPONSE_INVALID' },
  );
  assertUnchanged(root);
});

test('refuses a non-Ed25519 KMS key before signing', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const ecSpki = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' });
  const kms = mockKms(keys, { publicKey: { PublicKey: ecSpki } });
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: registryKeyId(ecSpki) }),
    { code: 'UIFN_REGISTRY_KMS_KEY_INVALID' },
  );
  assert.deepEqual(kms.calls.map(([name]) => name), ['GetPublicKey']);
  assertUnchanged(root);
});

test('refuses and writes nothing when KMS omits the key spec, key id or signing algorithm', async (t) => {
  const keys = keyPair();
  for (const [overrides, code] of [
    [{ publicKey: { KeySpec: undefined } }, 'UIFN_REGISTRY_KMS_KEY_INVALID'],
    [{ publicKey: { KeySpec: 'RSA_2048' } }, 'UIFN_REGISTRY_KMS_KEY_INVALID'],
    [{ sign: { SigningAlgorithm: undefined } }, 'UIFN_REGISTRY_KMS_RESPONSE_INVALID'],
    [{ sign: { KeyId: undefined } }, 'UIFN_REGISTRY_KMS_KEY_MISMATCH'],
  ]) {
    const root = fixture(t);
    await assert.rejects(
      signRegistryCatalogWithKms({ root, kms: mockKms(keys, overrides), kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }),
      { code },
    );
    assertUnchanged(root);
  }
});

test('refuses and writes nothing when a KMS call fails', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys);
  kms.sign = async () => { throw new Error('AccessDeniedException'); };
  await assert.rejects(signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }), /AccessDeniedException/);
  assertUnchanged(root);
});

test('restores both original signature files when publishing the second file fails after the first was replaced', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms: mockKms(keys), kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId, fileSystem: failingPublishRename(2) }),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected rename failure 2.*every replaced signature file was restored/ },
  );
  assertUnchanged(root);
});

test('writes nothing when publishing the first file fails', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms: mockKms(keys), kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId, fileSystem: failingPublishRename(1) }),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /no signature file was changed/ },
  );
  assertUnchanged(root);
});

test('removes a newly created first file when the second publish fails and leaves no staged files', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-write-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const created = path.join(directory, 'created.json');
  const existing = path.join(directory, 'existing.ts');
  writeFileSync(existing, V1_TS);
  assert.throws(
    () => writeFilesAtomically([[created, 'new'], [existing, 'new']], failingPublishRename(2)),
    { code: 'UIFN_REGISTRY_WRITE_FAILED' },
  );
  assert.deepEqual(readdirSync(directory), ['existing.ts']);
  assert.equal(readFileSync(existing, 'utf8'), V1_TS);
});

test('keeps the journal and backup and names them when an original cannot be restored; the next run recovers', (t) => {
  const { directory, files: [first, second] } = pair(t);
  const fileSystem = {
    ...failingPublishRename(2),
    linkSync(from, to) {
      if (from.endsWith('.bak')) throw new Error('EIO: injected restore failure');
      linkSync(from, to);
    },
  };
  assert.throws(
    () => writeFilesAtomically([[first, 'new'], [second, 'new']], fileSystem),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected rename failure 2.*recovery failed \(.*first\.json: EIO: injected restore failure.*first\.json\.kms-sign\.journal and any backups are kept/ },
  );
  assert.equal(readFileSync(first, 'utf8'), 'new');
  assert.equal(readFileSync(`${first}.kms-sign.bak`, 'utf8'), V1_JSON);
  assert.equal(readFileSync(`${second}.kms-sign.bak`, 'utf8'), V1_TS);
  assert.ok(existsSync(journalOf(first)));
  writeFilesAtomically([[first, 'signed'], [second, 'signed']]);
  assert.equal(readFileSync(first, 'utf8'), 'signed');
  assert.equal(readFileSync(second, 'utf8'), 'signed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('reports the publish and every cleanup failure, attempts each removal, and the next run settles the pair', (t) => {
  const { directory, files: [first, second] } = pair(t);
  const attempted = [];
  const fileSystem = {
    ...failingPublishRename(2),
    rmSync(target, options) {
      if (/\.kms-sign\.(tmp|bak)$/.test(target) && existsSync(target)) {
        attempted.push(path.basename(target));
        throw new Error('EIO: injected cleanup failure');
      }
      rmSync(target, options);
    },
  };
  assert.throws(
    () => writeFilesAtomically([[first, 'new'], [second, 'new']], fileSystem),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected rename failure 2.*recovery failed \(.*first\.json\.kms-sign\.bak: EIO: injected cleanup failure.*second\.ts\.kms-sign\.tmp: EIO: injected cleanup failure.*kms-sign\.journal and any backups are kept/ },
  );
  assert.deepEqual(attempted.sort(), ['first.json.kms-sign.bak', 'second.ts.kms-sign.bak', 'second.ts.kms-sign.tmp']);
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  writeFilesAtomically([[first, 'signed'], [second, 'signed']]);
  assert.equal(readFileSync(first, 'utf8'), 'signed');
  assert.equal(readFileSync(second, 'utf8'), 'signed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('recovers the originals after a run was killed between the two renames', (t) => {
  const { directory, files: [first, second] } = pair(t);
  const child = `import { renameSync } from 'node:fs';
import { writeFilesAtomically } from ${JSON.stringify(scriptUrl)};
writeFilesAtomically([[${JSON.stringify(first)}, 'killed'], [${JSON.stringify(second)}, 'killed']], {
  renameSync(from, to) { renameSync(from, to); if (from.endsWith('.kms-sign.tmp')) process.kill(process.pid, 'SIGKILL'); },
});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(readFileSync(first, 'utf8'), 'killed');
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  // The next run recovers the true originals first, so its own rollback leaves the original pair, not a mixed one.
  assert.throws(() => writeFilesAtomically([[first, 'next'], [second, 'next']], failingPublishRename(2)), { message: /every replaced signature file was restored/ });
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
  writeFilesAtomically([[first, 'signed'], [second, 'signed']]);
  assert.equal(readFileSync(first, 'utf8'), 'signed');
  assert.equal(readFileSync(second, 'utf8'), 'signed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('refuses while another live run holds the journal and changes nothing', (t) => {
  const { directory, files: [first, second] } = pair(t);
  const journal = JSON.stringify({ pid: process.ppid, targets: [{ target: first, existed: true }, { target: second, existed: true }], published: false });
  writeFileSync(journalOf(first), journal);
  writeFileSync(`${first}.kms-sign.bak`, 'other run');
  assert.throws(() => writeFilesAtomically([[first, 'new'], [second, 'new']]), { code: 'UIFN_REGISTRY_WRITE_IN_PROGRESS' });
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(journalOf(first), 'utf8'), journal);
  assert.equal(readFileSync(`${first}.kms-sign.bak`, 'utf8'), 'other run');
  assert.equal(readdirSync(directory).length, 4);
});

test('refuses a journal it cannot trust or read and changes nothing', (t) => {
  const { directory, files: [first, second] } = pair(t);
  const victim = path.join(directory, 'victim.txt');
  writeFileSync(victim, 'keep');
  const foreign = JSON.stringify({ pid: 2 ** 22 + 1, targets: [{ target: victim, existed: false }, { target: second, existed: true }], published: false });
  const unphased = JSON.stringify({ pid: 2 ** 22 + 1, targets: [{ target: first, existed: true }, { target: second, existed: true }] });
  const cases = [
    [foreign, {}, /does not describe these signature files/],
    [unphased, {}, /does not describe these signature files/],
    ['', {}, /Unexpected end of JSON input/],
    [JSON.stringify({ pid: 2 ** 22 + 1, targets: [{ target: first, existed: true }, { target: second, existed: true }], published: false }),
      { readFileSync() { throw new Error('EIO: injected read failure'); } }, /EIO: injected read failure/],
  ];
  for (const [contents, fileSystem, message] of cases) {
    writeFileSync(journalOf(first), contents);
    assert.throws(() => writeFilesAtomically([[first, 'new'], [second, 'new']], fileSystem), { code: 'UIFN_REGISTRY_WRITE_FAILED', message });
    assert.equal(readFileSync(journalOf(first), 'utf8'), contents);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    assert.equal(readFileSync(first, 'utf8'), V1_JSON);
    assert.equal(readFileSync(second, 'utf8'), V1_TS);
  }
  rmSync(journalOf(first));
  symlinkSync(victim, journalOf(first));
  assert.throws(() => writeFilesAtomically([[first, 'new'], [second, 'new']]), { message: /not a regular file/ });
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
});

/** Runs writeFilesAtomically in a child process that is killed when `killWhen(operation, path)` first holds. */
function killedRun(files, killWhen) {
  const child = `import * as fs from 'node:fs';
import { writeFilesAtomically } from ${JSON.stringify(scriptUrl)};
const killWhen = ${killWhen};
const wrap = (name) => (...args) => { const result = fs[name](...args); if (killWhen(name, String(args[0]))) process.kill(process.pid, 'SIGKILL'); return result; };
writeFilesAtomically(${JSON.stringify(files)}, { linkSync: wrap('linkSync'), renameSync: wrap('renameSync'), rmSync: wrap('rmSync') });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}

test('completes in one run after a killed first-ever signing created only the first file', (t) => {
  const { directory, files: [first, second] } = pair(t);
  rmSync(first);
  rmSync(second);
  killedRun([[first, 'killed'], [second, 'killed']], "(name, file) => name === 'renameSync' && file.endsWith('.kms-sign.tmp')");
  assert.deepEqual(readdirSync(directory).filter((name) => !name.includes('.kms-sign')), ['first.json']);
  writeFilesAtomically([[first, 'signed'], [second, 'signed']]);
  assert.equal(readFileSync(first, 'utf8'), 'signed');
  assert.equal(readFileSync(second, 'utf8'), 'signed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('keeps the new pair when a run is killed after it released a backup', (t) => {
  const { directory, files: [first, second] } = pair(t);
  // The first removal of that path is the sweep before staging; the second releases the backup after publishing.
  killedRun([[first, 'killed'], [second, 'killed']], "((count = 0) => (name, file) => name === 'rmSync' && file.endsWith('first.json.kms-sign.bak') && ++count === 2)()");
  assert.ok(existsSync(journalOf(first)));
  // Recovery must not restore the one remaining backup: that would mix the pair.
  assert.throws(() => writeFilesAtomically([[first, 'later'], [second, 'later']], failingPublishRename(2)), { message: /every replaced signature file was restored/ });
  assert.equal(readFileSync(first, 'utf8'), 'killed');
  assert.equal(readFileSync(second, 'utf8'), 'killed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('recovers a claim left by a run killed before it touched anything, including the journal temp file', (t) => {
  const { directory, files: [first, second] } = pair(t);
  killedRun([[first, 'killed'], [second, 'killed']], "(name, file) => name === 'linkSync' && /\\.journal\\.\\d+\\.tmp$/.test(file)");
  assert.equal(readdirSync(directory).filter((name) => /\.journal\.\d+\.tmp$/.test(name)).length, 1);
  writeFilesAtomically([[first, 'signed'], [second, 'signed']]);
  assert.equal(readFileSync(second, 'utf8'), 'signed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('reads target existence only while holding the journal, so a rollback keeps a pair another run completed meanwhile', (t) => {
  for (const missing of [[0, 1], [0], [1]]) {
    const { files } = pair(t);
    for (const index of missing) rmSync(files[index]);
    const fileSystem = {
      ...failingPublishRename(2),
      linkSync(from, to) {
        // Another run finishes signing both files just before this run claims the journal.
        if (to.endsWith('.kms-sign.journal')) for (const file of files) writeFileSync(file, 'other run');
        linkSync(from, to);
      },
    };
    assert.throws(() => writeFilesAtomically([[files[0], 'new'], [files[1], 'new']], fileSystem), { message: /every replaced signature file was restored/ });
    assert.deepEqual(files.map((file) => readFileSync(file, 'utf8')), ['other run', 'other run'], `missing ${missing}`);
  }
});

test('the workflow compares every module the catalog generator loads', (t) => {
  const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-closure-')), 'resolved.txt');
  t.after(() => rmSync(path.dirname(log), { recursive: true, force: true }));
  const hooks = `import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, next) { const result = await next(specifier, context); appendFileSync(${JSON.stringify(log)}, result.url + '\\n'); return result; }`;
  const hooksUrl = 'data:text/javascript,' + encodeURIComponent(hooks);
  // module.register needs Node 18.19+; on older supported versions (engines: >=18.17) the same hooks load with --experimental-loader.
  const register = `import { register } from 'node:module'; register(${JSON.stringify(hooksUrl)});`;
  const loader = typeof nodeModule.register === 'function' ? ['--import', `data:text/javascript,${encodeURIComponent(register)}`] : ['--experimental-loader', hooksUrl];
  const generated = spawnSync(process.execPath, [...loader, 'scripts/generate-uifn-registry.mjs', '--check'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const urls = [...new Set(readFileSync(log, 'utf8').trim().split('\n'))];
  const scriptsUrl = pathToFileURL(path.dirname(scriptPath) + path.sep).href;
  assert.deepEqual(urls.filter((url) => !url.startsWith('node:') && !url.startsWith(scriptsUrl)), [], 'the generator loads only builtins and scripts/ modules');
  const loaded = urls.filter((url) => url.startsWith(scriptsUrl)).map((url) => url.slice(scriptsUrl.length)).sort();
  const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/uifn-registry-sign.yml'), 'utf8');
  const compared = workflow.match(/for file in ([^;]+); do/)[1].trim().split(/\s+/).sort();
  assert.deepEqual(compared, loaded);
});

/** The body of a `run: |` step of the signing workflow. */
function workflowStepScript(name) {
  const lines = readFileSync(path.join(path.dirname(scriptPath), '../.github/workflows/uifn-registry-sign.yml'), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  assert.ok(start >= 0 && !lines.slice(start + 1, run).some((line) => line.trim().startsWith('- name:')), `step ${name} has a run block`);
  const indent = lines[run + 1].match(/^ */)[0];
  const end = lines.findIndex((line, index) => index > run && line.trim() !== '' && !line.startsWith(indent));
  return lines.slice(run + 1, end).map((line) => line.slice(indent.length)).join('\n');
}

test('the workflow commit step commits any nonempty subset of the two signature files and nothing else', (t) => {
  const script = workflowStepScript('Commit and push the signature files');
  const work = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-commit-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(work, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  // Never let an inherited repository location (for example from a git hook) point the destructive commands below elsewhere.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) delete env[name];
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = test\n\temail = test@example.invalid\n');
  spawnSync('git', ['init', '--bare', '-q', path.join(work, 'remote.git')], { env });
  mkdirSync(repo);
  git('init', '-q');
  for (const relative of [REGISTRY_SIGNATURE_JSON_PATH, REGISTRY_SIGNATURE_TS_PATH]) {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    writeFileSync(path.join(repo, relative), 'v1\n');
  }
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', path.join(work, 'remote.git'));
  const base = git('rev-parse', 'HEAD');
  const cases = [
    [[REGISTRY_SIGNATURE_JSON_PATH], 0, [REGISTRY_SIGNATURE_JSON_PATH]],
    [[REGISTRY_SIGNATURE_TS_PATH], 0, [REGISTRY_SIGNATURE_TS_PATH]],
    [[REGISTRY_SIGNATURE_JSON_PATH, REGISTRY_SIGNATURE_TS_PATH], 0, [REGISTRY_SIGNATURE_JSON_PATH, REGISTRY_SIGNATURE_TS_PATH]],
    [[], 0, []],
    [['other.txt'], 1, []],
    [[REGISTRY_SIGNATURE_JSON_PATH, 'other.txt'], 1, []],
    [[REGISTRY_SIGNATURE_TS_PATH, `${REGISTRY_SIGNATURE_JSON_PATH}.kms-sign.bak`], 1, []],
  ];
  for (const [index, [changes, status, committed]] of cases.entries()) {
    git('reset', '-q', '--hard', base);
    git('clean', '-qfdx');
    for (const relative of changes) writeFileSync(path.join(repo, relative), 'v2\n');
    const output = path.join(work, `output-${index}`);
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', script], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, SIGN_REF: `case-${index}`, EXPECTED_SHA: base, EXPECTED_KEY_ID: '0'.repeat(24), GITHUB_OUTPUT: output, GITHUB_SERVER_URL: 'https://github.invalid', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1' },
    });
    assert.equal(result.status, status, `changes ${changes}: ${result.stdout}${result.stderr}`);
    const head = git('rev-parse', 'HEAD');
    if (committed.length === 0) {
      assert.equal(head, base, `changes ${changes} made no commit`);
      continue;
    }
    assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [...committed].sort());
    assert.equal(git('--git-dir', path.join(work, 'remote.git'), 'rev-parse', `refs/heads/case-${index}`), head);
    assert.equal(readFileSync(output, 'utf8'), `commit=${head}\n`);
  }
});

test('never restores a stale backup as an original, even when the run is interrupted or the sweep fails', (t) => {
  for (const missing of [[], [0], [1]]) {
    const { files } = pair(t, 'current', 'current');
    for (const index of missing) rmSync(files[index]);
    const present = files.filter((file) => existsSync(file));
    for (const file of files) writeFileSync(`${file}.kms-sign.bak`, 'stale');
    // Killed right after it recorded the transaction; the retry then fails before staging.
    killedRun([[files[0], 'killed'], [files[1], 'killed']], "(name, file) => name === 'renameSync' && file.endsWith('.journal.' + process.pid + '.tmp')");
    assert.throws(() => writeFilesAtomically([[files[0], 'retry'], [files[1], 'retry']], { openSync(file) { if (file.endsWith('.kms-sign.tmp')) throw new Error('EIO: injected staging failure'); return openSync(file, 'wx'); } }),
      { message: /injected staging failure.*no signature file was changed/ });
    assert.deepEqual(present.map((file) => readFileSync(file, 'utf8')), present.map(() => 'current'), `missing ${missing}`);
    assert.deepEqual(files.filter((file) => existsSync(file)), present);
  }
  const { files: [first, second] } = pair(t, 'current', 'current');
  writeFileSync(`${first}.kms-sign.bak`, 'stale');
  const fileSystem = { rmSync(file, options) { if (file.endsWith('.kms-sign.bak')) throw new Error('EIO: injected sweep failure'); rmSync(file, options); } };
  assert.throws(() => writeFilesAtomically([[first, 'new'], [second, 'new']], fileSystem), { message: /injected sweep failure.*no signature file was changed/ });
  assert.equal(readFileSync(first, 'utf8'), 'current');
  assert.equal(existsSync(journalOf(first)), false);
});

test('removes stale sidecars left without a journal and publishes both files', (t) => {
  const { directory, files: [first, second] } = pair(t);
  writeFileSync(`${second}.kms-sign.tmp`, 'stale');
  writeFileSync(`${first}.kms-sign.bak`, 'stale');
  writeFilesAtomically([[first, 'signed'], [second, 'signed']]);
  assert.equal(readFileSync(first, 'utf8'), 'signed');
  assert.equal(readFileSync(second, 'utf8'), 'signed');
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('a failed lookup of a target is never taken as absence: the run refuses and both originals stay', (t) => {
  const { directory, files: [first, second] } = pair(t);
  assert.throws(
    () => writeFilesAtomically([[first, 'new'], [second, 'new']], { ...failingPublishRename(2), ...failingLookup(first) }),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected lookup failure first\.json\).*no signature file was changed/ },
  );
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('a failed backup lookup during recovery keeps the journal and backups; a later run restores the originals', (t) => {
  const { directory, files: [first, second] } = pair(t);
  killedRun([[first, 'killed'], [second, 'killed']], "(name, file) => name === 'renameSync' && file.endsWith('.kms-sign.tmp')");
  const interrupted = readdirSync(directory).sort();
  assert.throws(
    () => writeFilesAtomically([[first, 'next'], [second, 'next']], failingLookup(`${first}.kms-sign.bak`)),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected lookup failure first\.json\.kms-sign\.bak.*is kept so the next run retries/ },
  );
  assert.deepEqual(readdirSync(directory).sort(), interrupted);
  assert.equal(readFileSync(`${first}.kms-sign.bak`, 'utf8'), V1_JSON);
  assert.throws(() => writeFilesAtomically([[first, 'later'], [second, 'later']], failingStaging), { message: /no signature file was changed/ });
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('keeps a completed first-ever pair whose journal was left behind, even when the next run fails', (t) => {
  const leaveJournal = [
    (files) => assert.throws(() => writeFilesAtomically(files, {
      rmSync(file, options) {
        if (file.endsWith('.kms-sign.journal')) throw new Error('EIO: injected journal removal failure');
        rmSync(file, options);
      },
    }), { code: 'UIFN_REGISTRY_WRITE_CLEANUP_FAILED' }),
    // Killed at the first sidecar removal after both renames.
    (files) => killedRun(files, "((renamed = 0) => (name, file) => { if (name === 'renameSync' && file.endsWith('.kms-sign.tmp')) renamed += 1; return renamed === 2 && name === 'rmSync' && file.includes('.kms-sign.') && !file.includes('.journal'); })()"),
  ];
  for (const [index, leave] of leaveJournal.entries()) {
    const { directory, files: [first, second] } = pair(t);
    rmSync(first);
    rmSync(second);
    leave([[first, 'new'], [second, 'new']]);
    assert.ok(existsSync(journalOf(first)), `case ${index} left its journal`);
    assert.throws(() => writeFilesAtomically([[first, 'retry'], [second, 'retry']], failingStaging), { message: /injected staging failure.*no signature file was changed/ });
    assert.deepEqual([readFileSync(first, 'utf8'), readFileSync(second, 'utf8')], ['new', 'new'], `case ${index}`);
    assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
  }
});

test('removes the journal temp file when closing it fails and changes nothing', (t) => {
  const { directory, files: [first, second] } = pair(t);
  const temporaries = new Set();
  const fileSystem = {
    openSync(file, flags) {
      const descriptor = openSync(file, flags);
      if (/\.journal\.\d+\.tmp$/.test(file)) temporaries.add(descriptor);
      return descriptor;
    },
    closeSync(descriptor) {
      closeSync(descriptor);
      if (temporaries.has(descriptor)) throw new Error('EIO: injected close failure');
    },
  };
  assert.throws(
    () => writeFilesAtomically([[first, 'new'], [second, 'new']], fileSystem),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected close failure.*no signature file was changed/ },
  );
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('removes a staged file whose write fails after it was created and leaves both originals unchanged', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  let writes = 0;
  let secondStaged;
  const fileSystem = {
    openSync(file, flags) {
      const descriptor = openSync(file, flags);
      if (file.endsWith(`${REGISTRY_SIGNATURE_TS_PATH}.kms-sign.tmp`)) secondStaged = descriptor;
      return descriptor;
    },
    writeFileSync(descriptor, contents) {
      writes += 1;
      if (descriptor === secondStaged) {
        // The staged file exists and holds partial bytes when the write fails.
        writeFileSync(descriptor, String(contents).slice(0, 4));
        throw Object.assign(new Error('ENOSPC: injected write failure'), { code: 'ENOSPC' });
      }
      writeFileSync(descriptor, contents);
    },
  };
  await assert.rejects(
    signRegistryCatalogWithKms({ root, kms: mockKms(keys), kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId, fileSystem }),
    { code: 'UIFN_REGISTRY_WRITE_FAILED', message: /injected write failure.*no signature file was changed/ },
  );
  assert.ok(secondStaged !== undefined && writes >= 2, 'the second staged file was written after the first');
  assertUnchanged(root);
  assert.equal(existsSync(path.join(root, `${REGISTRY_SIGNATURE_JSON_PATH}.kms-sign.journal`)), false);
});

test('cleans up staged files and backups through the injected file system', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-write-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first.json');
  const second = path.join(directory, 'second.ts');
  writeFileSync(first, V1_JSON);
  writeFileSync(second, V1_TS);
  const removed = [];
  const fileSystem = {
    ...failingPublishRename(2),
    rmSync(target, options) {
      removed.push(path.basename(target));
      rmSync(target, options);
    },
  };
  assert.throws(() => writeFilesAtomically([[first, 'new'], [second, 'new']], fileSystem), { code: 'UIFN_REGISTRY_WRITE_FAILED' });
  assert.ok(removed.some((name) => name.endsWith('.tmp')), `expected an injected cleanup of a staged file, saw ${removed}`);
  assert.equal(readFileSync(first, 'utf8'), V1_JSON);
  assert.equal(readFileSync(second, 'utf8'), V1_TS);
  assert.deepEqual(readdirSync(directory).sort(), ['first.json', 'second.ts']);
});

test('refuses missing or malformed configuration before calling KMS', async (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const kms = mockKms(keys);
  for (const [kmsKeyId, expectedKeyId] of [['', keys.keyId], [KMS_KEY_ARN, undefined], [KMS_KEY_ARN, keys.keyId.toUpperCase()], [KMS_KEY_ARN, keys.keyId.slice(0, 23)]]) {
    await assert.rejects(signRegistryCatalogWithKms({ root, kms, kmsKeyId, expectedKeyId }), { code: 'UIFN_REGISTRY_KMS_CONFIG_MISSING' });
  }
  assert.deepEqual(kms.calls, []);
  assertUnchanged(root);
});

test('AWS CLI client passes RAW / ED25519_SHA_512, the base64 message and the region without a shell', async () => {
  const keys = keyPair();
  const invocations = [];
  const run = (command, args, options) => {
    invocations.push({ command, args, options });
    if (args[1] === 'get-public-key') {
      return { status: 0, stdout: JSON.stringify({ KeyId: KMS_KEY_ARN, KeySpec: 'ECC_NIST_EDWARDS25519', PublicKey: keys.spki.toString('base64') }) };
    }
    const message = Buffer.from(args[args.indexOf('--message') + 1], 'base64');
    return { status: 0, stdout: JSON.stringify({ KeyId: KMS_KEY_ARN, SigningAlgorithm: 'ED25519_SHA_512', Signature: sign(null, message, keys.privateKey).toString('base64') }) };
  };
  const client = createAwsCliKmsClient({ region: 'eu-west-1', run, env: {} });
  const message = registryV2SigningInput(Buffer.from(CATALOG));
  const publicKey = await client.getPublicKey({ KeyId: 'alias/uifn' });
  assert.deepEqual(publicKey.PublicKey, keys.spki);
  const signed = await client.sign({ KeyId: 'alias/uifn', Message: message, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' });
  assert.equal(verify(null, message, keys.publicKey, signed.Signature), true);

  assert.deepEqual(invocations[0].args, ['kms', 'get-public-key', '--key-id', 'alias/uifn', '--region', 'eu-west-1', '--output', 'json']);
  assert.deepEqual(invocations[1].args, [
    'kms', 'sign', '--key-id', 'alias/uifn', '--message', message.toString('base64'), '--cli-binary-format', 'base64',
    '--message-type', 'RAW', '--signing-algorithm', 'ED25519_SHA_512', '--region', 'eu-west-1', '--output', 'json',
  ]);
  for (const { command, options } of invocations) {
    assert.equal(command, 'aws');
    assert.equal(options.shell, false);
    assert.equal(options.env.AWS_PAGER, '');
  }
});

test('AWS CLI client turns a failed or malformed call into an error', async () => {
  const failing = createAwsCliKmsClient({ region: 'us-east-1', run: () => ({ status: 254, stdout: '', stderr: 'An error occurred (AccessDeniedException)' }), env: {} });
  await assert.rejects(failing.getPublicKey({ KeyId: 'k' }), { code: 'UIFN_REGISTRY_KMS_CALL_FAILED', message: /AccessDeniedException/ });
  const malformed = createAwsCliKmsClient({ region: 'us-east-1', run: () => ({ status: 0, stdout: JSON.stringify({ Signature: 'not base64!' }) }), env: {} });
  await assert.rejects(malformed.sign({ KeyId: 'k', Message: Buffer.alloc(49), MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' }), { code: 'UIFN_REGISTRY_KMS_RESPONSE_INVALID' });
  assert.throws(() => createAwsCliKmsClient({ region: '' }), { code: 'UIFN_REGISTRY_KMS_CONFIG_MISSING' });
});

test('CLI exits non-zero without configuration and does not touch the committed signature', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A fake `aws` on PATH proves no KMS call is attempted when the expected key id is missing.
  const marker = path.join(directory, 'aws-called');
  const fakeAws = path.join(directory, 'aws');
  writeFileSync(fakeAws, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(fakeAws, 0o755);
  const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
  const before = readFileSync(path.join(repositoryRoot, REGISTRY_SIGNATURE_JSON_PATH));
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { PATH: `${directory}${path.delimiter}${process.env.PATH}`, UIFN_REGISTRY_KMS_KEY_ID: KMS_KEY_ARN, UIFN_REGISTRY_KMS_REGION: 'us-east-1' },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'UIFN_REGISTRY_KMS_CONFIG_MISSING');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readFileSync(path.join(repositoryRoot, REGISTRY_SIGNATURE_JSON_PATH)), before);
});

test('refuses a symlinked catalog or signature file and writes nothing', async (t) => {
  const keys = keyPair();
  for (const relative of [REGISTRY_CATALOG_PATH, REGISTRY_SIGNATURE_JSON_PATH]) {
    const root = fixture(t);
    const outside = path.join(root, 'outside.json');
    writeFileSync(outside, CATALOG);
    rmSync(path.join(root, relative));
    symlinkSync(outside, path.join(root, relative));
    const kms = mockKms(keys);
    await assert.rejects(
      signRegistryCatalogWithKms({ root, kms, kmsKeyId: KMS_KEY_ARN, expectedKeyId: keys.keyId }),
      { code: 'UIFN_REGISTRY_PATH_INVALID' },
    );
    assert.deepEqual(kms.calls, []);
    assert.equal(readFileSync(outside, 'utf8'), CATALOG);
  }
});

test('CLI signs the checkout in its working directory through the AWS CLI and prints a summary', (t) => {
  const root = fixture(t);
  const keys = keyPair();
  const bin = mkdtempSync(path.join(tmpdir(), 'uifn-registry-kms-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const privateKeyPath = path.join(bin, 'key.pem');
  writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const log = path.join(bin, 'calls.jsonl');
  // Fake AWS CLI: records argv and answers get-public-key / sign like KMS would.
  writeFileSync(path.join(bin, 'aws'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const { createPrivateKey, createPublicKey, sign } = require('node:crypto');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const key = createPrivateKey(readFileSync(${JSON.stringify(privateKeyPath)}));
const arn = ${JSON.stringify(KMS_KEY_ARN)};
if (args[1] === 'get-public-key') {
  process.stdout.write(JSON.stringify({ KeyId: arn, KeySpec: 'ECC_NIST_EDWARDS25519', PublicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') }));
} else {
  const message = Buffer.from(args[args.indexOf('--message') + 1], 'base64');
  process.stdout.write(JSON.stringify({ KeyId: arn, SigningAlgorithm: 'ED25519_SHA_512', Signature: sign(null, message, key).toString('base64') }));
}
`);
  chmodSync(path.join(bin, 'aws'), 0o755);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      UIFN_REGISTRY_KMS_KEY_ID: 'alias/uifn-registry',
      UIFN_REGISTRY_KMS_REGION: 'us-east-1',
      UIFN_REGISTRY_EXPECTED_KEY_ID: keys.keyId,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.keyId, keys.keyId);
  assert.equal(summary.domain, 'uifn-registry-v2');
  const envelope = JSON.parse(readFileSync(path.join(root, REGISTRY_SIGNATURE_JSON_PATH), 'utf8'));
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(verify(null, registryV2SigningInput(Buffer.from(CATALOG)), keys.publicKey, Buffer.from(envelope.signatureBase64, 'base64')), true);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((args) => args[1]), ['get-public-key', 'sign']);
  assert.ok(calls[1].includes('--cli-binary-format'));
});

test('CLI rejects any argument, including a path, before reading configuration', () => {
  for (const args of [['--private-key', 'x'], ['--root', '.']]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  }
});
