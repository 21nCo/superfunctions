#!/usr/bin/env node

// Signs the uifn registry catalog with an AWS KMS Ed25519 key (signature envelope schema v2).
//
// The KMS key signs the 49-byte domain-separated digest UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes)
// with pure Ed25519 (ED25519_SHA_512, message type RAW). The signature is verified locally against the
// public key returned by GetPublicKey before anything is written. No private key is ever handled here.
//
// Configuration comes only from the environment:
//   UIFN_REGISTRY_KMS_KEY_ID        KMS key id, ARN or alias of the signing key
//   UIFN_REGISTRY_KMS_REGION        AWS region of the key
//   UIFN_REGISTRY_EXPECTED_KEY_ID   expected registry key id (first 24 hex of SHA-256 over the SPKI DER)
// AWS credentials are taken from the standard AWS environment (in CI: GitHub OIDC role credentials).
//
// Usage: node <path-to>/sign-uifn-registry-kms.mjs, run from the root of the checkout to sign. The script takes
// no arguments: it signs the checkout in the current directory, so a trusted copy of this script can sign another
// checkout without running that checkout's code.

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const REGISTRY_V2_DOMAIN = 'uifn-registry-v2';
export const REGISTRY_V2_SIGNING_ALGORITHM = 'ED25519_SHA_512';
export const REGISTRY_V2_MESSAGE_TYPE = 'RAW';
export const REGISTRY_CATALOG_PATH = 'uifn/registry/generated/catalog.json';
export const REGISTRY_SIGNATURE_JSON_PATH = 'uifn/registry/generated/catalog-signature.json';
export const REGISTRY_SIGNATURE_TS_PATH = 'uifn/registry/src/generated/signature.ts';

const DOMAIN_PREFIX = Buffer.from(`${REGISTRY_V2_DOMAIN}\0`, 'utf8');
const KEY_ID_PATTERN = /^[0-9a-f]{24}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ED25519_SIGNATURE_BYTES = 64;

const sha256 = (value) => createHash('sha256').update(value).digest();

export class RegistrySigningError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RegistrySigningError';
    this.code = code;
  }
}

/** Schema-v2 signing input: UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes), 49 bytes. */
export function registryV2SigningInput(catalogBytes) {
  return Buffer.concat([DOMAIN_PREFIX, sha256(catalogBytes)]);
}

/** Registry key id: first 24 hex characters of SHA-256 over the SPKI DER public key. */
export function registryKeyId(spkiDer) {
  return sha256(spkiDer).toString('hex').slice(0, 24);
}

/** Returns a binary KMS response field as a Buffer, refusing anything else. */
function toBytes(value, field) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new RegistrySigningError('UIFN_REGISTRY_KMS_RESPONSE_INVALID', `KMS response field ${field} is missing or not binary.`);
}

/** Decodes a base64 KMS CLI response field, refusing anything that is not strict base64. */
function decodeBase64(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_RESPONSE_INVALID', `KMS response field ${field} is not base64.`);
  }
  return Buffer.from(value, 'base64');
}

/**
 * Minimal KMS client backed by the AWS CLI v2, shaped like the AWS SDK SignCommand and GetPublicKeyCommand
 * so tests (or an SDK client) can stand in for it. Arguments are passed without a shell.
 */
export function createAwsCliKmsClient({ region, command = 'aws', run = spawnSync, env = process.env } = {}) {
  if (typeof region !== 'string' || region.trim() === '') {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_CONFIG_MISSING', 'A KMS region is required.');
  }
  const invoke = (args) => {
    const result = run(command, ['kms', ...args, '--region', region, '--output', 'json'], {
      encoding: 'utf8',
      env: { ...env, AWS_PAGER: '' },
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' ');
      const detail = result.error?.message ?? (stderr || 'exit ' + result.status);
      throw new RegistrySigningError('UIFN_REGISTRY_KMS_CALL_FAILED', `aws kms ${args[0]} failed: ${detail}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new RegistrySigningError('UIFN_REGISTRY_KMS_RESPONSE_INVALID', `aws kms ${args[0]} returned non-JSON output.`);
    }
  };
  return {
    async getPublicKey({ KeyId }) {
      const response = invoke(['get-public-key', '--key-id', KeyId]);
      return { ...response, PublicKey: decodeBase64(response.PublicKey, 'PublicKey') };
    },
    async sign({ KeyId, Message, MessageType, SigningAlgorithm }) {
      const response = invoke([
        'sign',
        '--key-id', KeyId,
        '--message', Buffer.from(Message).toString('base64'),
        '--cli-binary-format', 'base64',
        '--message-type', MessageType,
        '--signing-algorithm', SigningAlgorithm,
      ]);
      return { ...response, Signature: decodeBase64(response.Signature, 'Signature') };
    },
  };
}

/** Resolves a repository-relative file and refuses symlinks or parents that escape the checkout. */
function checkoutFile(root, relative, { mustExist }) {
  const realRoot = realpathSync(root);
  const target = path.join(realRoot, relative);
  let parent;
  try {
    parent = realpathSync(path.dirname(target));
  } catch {
    throw new RegistrySigningError('UIFN_REGISTRY_PATH_INVALID', `${relative} has no parent directory in the checkout.`);
  }
  if (parent !== path.dirname(target)) {
    throw new RegistrySigningError('UIFN_REGISTRY_PATH_INVALID', `${relative} resolves outside its checkout directory.`);
  }
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    if (mustExist) throw new RegistrySigningError('UIFN_REGISTRY_PATH_INVALID', `${relative} does not exist.`);
    return target;
  }
  if (!stat.isFile()) throw new RegistrySigningError('UIFN_REGISTRY_PATH_INVALID', `${relative} is not a regular file.`);
  return target;
}

const defaultFileSystem = { closeSync, existsSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync };
const SIDECAR = 'kms-sign';

/** Run-independent sidecar paths of a target: its staged replacement and the backup of its original. */
function sidecarsOf(target) {
  return { staged: `${target}.${SIDECAR}.tmp`, backup: `${target}.${SIDECAR}.bak` };
}

/** True when a process with this pid is running (EPERM means it exists but belongs to another user). */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Runs every step even when earlier ones fail and returns the failures instead of throwing. */
function attemptEach(steps) {
  const failures = [];
  for (const [file, step] of steps) {
    try {
      step();
    } catch (error) {
      failures.push({ file, message: error.message });
    }
  }
  return failures;
}

const describeFailures = (failures) => failures.map(({ file, message }) => `${file}: ${message}`).join('; ');
const removal = (file, fsOps) => [file, () => fsOps.rmSync(file, { force: true })];

/** Creates a file exclusively and writes it; a file created here but not fully written is removed again. */
function createExclusive(file, contents, fsOps) {
  const descriptor = fsOps.openSync(file, 'wx');
  try {
    fsOps.writeFileSync(descriptor, contents);
  } catch (error) {
    attemptEach([[file, () => fsOps.closeSync(descriptor)], removal(file, fsOps)]);
    throw error;
  }
  fsOps.closeSync(descriptor);
}

/**
 * Publishes the journal atomically: a private file is fully written, then hard-linked into place. The journal is
 * therefore never observable empty or partial, and link() fails with EEXIST while another journal exists.
 */
function createJournal(journal, record, fsOps) {
  const temporary = `${journal}.${process.pid}.tmp`;
  fsOps.rmSync(temporary, { force: true });
  createExclusive(temporary, JSON.stringify(record), fsOps);
  try {
    fsOps.linkSync(temporary, journal);
  } finally {
    fsOps.rmSync(temporary, { force: true });
  }
}

/** Reads an existing journal, refusing (without changing anything) one that is unreadable or names other files. */
function readJournal(journal, files, fsOps) {
  const refuse = (reason) => new RegistrySigningError('UIFN_REGISTRY_WRITE_FAILED', `Cannot recover from ${journal} (${reason}); nothing was changed. Inspect and remove it by hand.`);
  let record;
  try {
    if (!fsOps.lstatSync(journal).isFile()) throw refuse('not a regular file');
    record = JSON.parse(fsOps.readFileSync(journal, 'utf8'));
  } catch (error) {
    throw error instanceof RegistrySigningError ? error : refuse(error.message);
  }
  const valid = Number.isInteger(record?.pid) && Array.isArray(record.targets) && record.targets.length === files.length
    && record.targets.every((entry, index) => entry?.target === files[index][0] && typeof entry.existed === 'boolean');
  if (!valid) throw refuse('it does not describe these signature files');
  return record;
}

/** Restores one original (unless the target still is it), keeping the backup until the pair is consistent again. */
function restoreTarget({ target, existed }, fsOps) {
  if (!existed) {
    fsOps.rmSync(target, { force: true });
    return;
  }
  const { staged, backup } = sidecarsOf(target);
  const current = fsOps.existsSync(target) ? fsOps.lstatSync(target) : null;
  const original = fsOps.lstatSync(backup);
  if (current?.ino === original.ino && current.dev === original.dev) return;
  fsOps.rmSync(staged, { force: true });
  fsOps.linkSync(backup, staged);
  fsOps.renameSync(staged, target);
}

/**
 * Brings a journaled pair back to a consistent state and removes its sidecars. No target is renamed before every
 * original has a backup, and backups are released only after every rename, so while every backup is present the
 * originals are restored; once one is gone the new pair is complete and stays. Returns every failure; on a
 * restore failure all sidecars are kept for the next attempt. The journal is not touched.
 */
function settleTargets(targets, fsOps) {
  const rollBack = targets.every(({ target, existed }) => !existed || fsOps.existsSync(sidecarsOf(target).backup));
  const failures = rollBack ? attemptEach(targets.map((entry) => [entry.target, () => restoreTarget(entry, fsOps)])) : [];
  if (failures.length > 0) return failures;
  return attemptEach(targets.flatMap(({ target }) => Object.values(sidecarsOf(target)).map((file) => removal(file, fsOps))));
}

/** Recovers the transaction of an interrupted earlier run, refusing while its owner is still running. */
function recoverInterruptedWrite(journal, files, fsOps) {
  const record = readJournal(journal, files, fsOps);
  if (record.pid !== process.pid && isProcessAlive(record.pid)) {
    throw new RegistrySigningError('UIFN_REGISTRY_WRITE_IN_PROGRESS', `Another signing run (pid ${record.pid}) holds ${journal}; wait for it, or remove that file if no run is active.`);
  }
  const failures = settleTargets(record.targets, fsOps);
  if (failures.length === 0) failures.push(...attemptEach([[journal, () => fsOps.rmSync(journal)]]));
  if (failures.length > 0) {
    throw new RegistrySigningError('UIFN_REGISTRY_WRITE_FAILED', `Recovering an interrupted signing run failed (${describeFailures(failures)}); ${journal} is kept so the next run retries.`);
  }
}

/** Takes the journal (the write lock), recovering an interrupted run first; target existence is read after that. */
function acquireJournal(journal, files, fsOps) {
  const record = () => ({ pid: process.pid, targets: files.map(([target]) => ({ target, existed: fsOps.existsSync(target) })) });
  let current = record();
  try {
    createJournal(journal, current, fsOps);
    return current.targets;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  recoverInterruptedWrite(journal, files, fsOps);
  current = record();
  createJournal(journal, current, fsOps);
  return current.targets;
}

/** Stages, backs up and renames every file, counting renames in `progress`. Throws on the first failure. */
function publish(files, targets, fsOps, progress) {
  // Sidecars without a journal are left over from a run that ended with a consistent pair; they hold nothing needed.
  const stale = files.flatMap(([target]) => Object.values(sidecarsOf(target))).filter((file) => fsOps.existsSync(file));
  const sidecarFailures = attemptEach(stale.map((file) => removal(file, fsOps)));
  if (sidecarFailures.length > 0) throw new Error(`stale ${describeFailures(sidecarFailures)}`);
  for (const [target, contents] of files) createExclusive(sidecarsOf(target).staged, contents, fsOps);
  for (const { target, existed } of targets) {
    if (existed) fsOps.linkSync(target, sidecarsOf(target).backup);
  }
  for (const [target] of files) {
    fsOps.renameSync(sidecarsOf(target).staged, target);
    progress.published += 1;
  }
}

/**
 * Replaces every target or none of them, also across an interruption. A journal next to the first target is the
 * write lock and the recovery record: it is published atomically before anything else, records which targets
 * existed, and is removed last, after the backups are released. If a step fails, the pair is settled (see
 * settleTargets); if that fails, the journal and backups are kept and the next run settles them before writing.
 * Every cleanup is attempted and every failure is reported. Not crash-safe against power loss (no fsync).
 * `fileSystem` is injectable for tests.
 */
export function writeFilesAtomically(files, fileSystem = defaultFileSystem) {
  const fsOps = { ...defaultFileSystem, ...fileSystem };
  const journal = `${files[0][0]}.${SIDECAR}.journal`;
  let targets;
  try {
    targets = acquireJournal(journal, files, fsOps);
  } catch (error) {
    if (error instanceof RegistrySigningError) throw error;
    throw new RegistrySigningError('UIFN_REGISTRY_WRITE_FAILED', `Writing the signature files failed (${error.message}); no signature file was changed.`, { cause: error });
  }
  const progress = { published: 0 };
  try {
    publish(files, targets, fsOps, progress);
  } catch (error) {
    const failures = settleTargets(targets, fsOps);
    if (failures.length === 0) failures.push(...attemptEach([[journal, () => fsOps.rmSync(journal)]]));
    let outcome = progress.published === 0 ? 'no signature file was changed' : 'every replaced signature file was restored';
    if (failures.length > 0) {
      outcome = `recovery failed (${describeFailures(failures)}); ${journal} and any backups are kept and the next signing run restores them`;
    }
    throw new RegistrySigningError('UIFN_REGISTRY_WRITE_FAILED', `Writing the signature files failed (${error.message}); ${outcome}.`, { cause: error });
  }
  const failures = attemptEach(targets.map(({ target }) => removal(sidecarsOf(target).backup, fsOps)));
  if (failures.length === 0) failures.push(...attemptEach([[journal, () => fsOps.rmSync(journal)]]));
  if (failures.length > 0) {
    throw new RegistrySigningError('UIFN_REGISTRY_WRITE_CLEANUP_FAILED', `Both signature files were written, but cleanup failed (${describeFailures(failures)}); the next signing run recovers a consistent pair from what is left.`);
  }
}

/**
 * Signs the committed catalog with KMS and writes the schema-v2 envelope files.
 * Nothing is written unless every check passes and the signature verifies locally.
 */
export async function signRegistryCatalogWithKms({ root = process.cwd(), kms, kmsKeyId, expectedKeyId, fileSystem }) {
  if (typeof kmsKeyId !== 'string' || kmsKeyId.trim() === '') {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_CONFIG_MISSING', 'UIFN_REGISTRY_KMS_KEY_ID is required.');
  }
  if (typeof expectedKeyId !== 'string' || !KEY_ID_PATTERN.test(expectedKeyId)) {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_CONFIG_MISSING', 'UIFN_REGISTRY_EXPECTED_KEY_ID must be 24 lowercase hex characters.');
  }
  if (!kms || typeof kms.sign !== 'function' || typeof kms.getPublicKey !== 'function') {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_CONFIG_MISSING', 'A KMS client is required.');
  }

  const catalogBytes = readFileSync(checkoutFile(root, REGISTRY_CATALOG_PATH, { mustExist: true }));
  const signatureJsonPath = checkoutFile(root, REGISTRY_SIGNATURE_JSON_PATH, { mustExist: false });
  const signatureTsPath = checkoutFile(root, REGISTRY_SIGNATURE_TS_PATH, { mustExist: false });
  const catalogSha256 = sha256(catalogBytes).toString('hex');
  const message = registryV2SigningInput(catalogBytes);

  const publicKeyResponse = await kms.getPublicKey({ KeyId: kmsKeyId });
  const spkiDer = toBytes(publicKeyResponse?.PublicKey, 'PublicKey');
  if (publicKeyResponse.KeySpec !== 'ECC_NIST_EDWARDS25519') {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_KEY_INVALID', `KMS key spec ${publicKeyResponse.KeySpec} is not ECC_NIST_EDWARDS25519.`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_KEY_INVALID', 'KMS public key is not a valid SPKI DER key.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_KEY_INVALID', `KMS public key type ${publicKey.asymmetricKeyType} is not Ed25519.`);
  }
  const canonicalSpki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = registryKeyId(canonicalSpki);
  if (keyId !== expectedKeyId) {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_KEY_MISMATCH', `KMS public key id ${keyId} does not match the expected key id ${expectedKeyId}.`);
  }

  const signResponse = await kms.sign({
    KeyId: kmsKeyId,
    Message: message,
    MessageType: REGISTRY_V2_MESSAGE_TYPE,
    SigningAlgorithm: REGISTRY_V2_SIGNING_ALGORITHM,
  });
  if (signResponse?.SigningAlgorithm !== REGISTRY_V2_SIGNING_ALGORITHM) {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_RESPONSE_INVALID', `KMS signed with ${signResponse?.SigningAlgorithm}, not ${REGISTRY_V2_SIGNING_ALGORITHM}.`);
  }
  if (typeof publicKeyResponse.KeyId !== 'string' || signResponse.KeyId !== publicKeyResponse.KeyId) {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_KEY_MISMATCH', 'KMS signed with a different key than the one whose public key was fetched.');
  }
  const signature = toBytes(signResponse?.Signature, 'Signature');
  if (signature.length !== ED25519_SIGNATURE_BYTES || !verify(null, message, publicKey, signature)) {
    throw new RegistrySigningError('UIFN_REGISTRY_KMS_SIGNATURE_INVALID', 'KMS signature does not verify against the KMS public key.');
  }

  const envelope = {
    schemaVersion: 2,
    algorithm: 'Ed25519',
    domain: REGISTRY_V2_DOMAIN,
    keyId,
    catalogSha256,
    signatureBase64: signature.toString('base64'),
  };
  writeFilesAtomically([
    [signatureJsonPath, `${JSON.stringify(envelope, null, 2)}\n`],
    [signatureTsPath, `/* Generated detached registry signature. */\nexport const REGISTRY_SIGNATURE = ${JSON.stringify(envelope, null, 2)} as const;\n`],
  ], fileSystem);
  return { envelope, files: [REGISTRY_SIGNATURE_JSON_PATH, REGISTRY_SIGNATURE_TS_PATH] };
}

/** CLI entry point: signs the checkout in the current directory with the KMS key configured in `env`. */
export async function main({ argv = process.argv.slice(2), env = process.env, kms } = {}) {
  parseArgs({ args: argv, options: {}, strict: true, allowPositionals: false });
  const client = kms ?? createAwsCliKmsClient({ region: env.UIFN_REGISTRY_KMS_REGION });
  const { envelope, files } = await signRegistryCatalogWithKms({
    kms: client,
    kmsKeyId: env.UIFN_REGISTRY_KMS_KEY_ID,
    expectedKeyId: env.UIFN_REGISTRY_EXPECTED_KEY_ID,
  });
  return {
    ok: true,
    schemaVersion: envelope.schemaVersion,
    algorithm: envelope.algorithm,
    domain: envelope.domain,
    keyId: envelope.keyId,
    catalogSha256: envelope.catalogSha256,
    files,
  };
}

const invokedDirectly = process.argv[1] !== undefined
  && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    console.log(JSON.stringify(await main(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code ?? 'UIFN_REGISTRY_KMS_SIGN_FAILED', message: error.message }, null, 2));
    process.exitCode = 1;
  }
}
