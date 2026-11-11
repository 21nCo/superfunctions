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
// Usage: node scripts/sign-uifn-registry-kms.mjs [--root <checkout>]
// --root selects the checkout whose catalog is signed (default: this script's repository), so a trusted
// copy of this script can sign another checkout without running that checkout's code.

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function toBytes(value, field) {
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new RegistrySigningError('UIFN_REGISTRY_KMS_RESPONSE_INVALID', `KMS response field ${field} is missing or not binary.`);
}

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
      const detail = result.error ? result.error.message : String(result.stderr ?? '').trim().split('\n').slice(-3).join(' ');
      throw new RegistrySigningError('UIFN_REGISTRY_KMS_CALL_FAILED', `aws kms ${args[0]} failed: ${detail || `exit ${result.status}`}`);
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

const defaultFileSystem = { linkSync, renameSync, rmSync, writeFileSync };

/**
 * Replaces every target or none of them. Each new file is staged next to its target, each existing target is
 * hard-linked to a backup, and each staged file is renamed over its target. If any step fails, the targets
 * already replaced are restored from their backups (or removed when they did not exist), staged files are
 * removed, and a backup is left in place only if its original could not be restored (the error names it).
 * `fileSystem` is injectable so tests can force a failure at any step.
 */
export function writeFilesAtomically(files, fileSystem = defaultFileSystem) {
  const fsOps = { ...defaultFileSystem, ...fileSystem };
  const suffix = `kms-sign-${process.pid}`;
  const staged = [];
  const backups = [];
  const published = [];
  try {
    for (const [target, contents] of files) {
      const temporary = `${target}.${suffix}.tmp`;
      fsOps.writeFileSync(temporary, contents, { flag: 'wx' });
      staged.push([temporary, target]);
    }
    for (const [, target] of staged) {
      const backup = `${target}.${suffix}.bak`;
      try {
        fsOps.linkSync(target, backup);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      backups.push([target, backup]);
    }
    for (const [temporary, target] of staged) {
      fsOps.renameSync(temporary, target);
      published.push(target);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const target of published.reverse()) {
      const entry = backups.find(([original]) => original === target);
      try {
        if (entry === undefined) {
          fsOps.rmSync(target, { force: true });
        } else {
          fsOps.renameSync(entry[1], target);
          backups.splice(backups.indexOf(entry), 1);
        }
      } catch (rollbackError) {
        rollbackFailures.push(`${path.basename(target)} (${rollbackError.message}${entry ? `; original kept at ${entry[1]}` : ''})`);
        if (entry) backups.splice(backups.indexOf(entry), 1);
      }
    }
    let detail;
    if (published.length === 0) detail = 'no signature file was changed';
    else if (rollbackFailures.length === 0) detail = 'every replaced signature file was restored';
    else detail = `restoring failed for ${rollbackFailures.join(', ')}`;
    throw new RegistrySigningError('UIFN_REGISTRY_WRITE_FAILED', `Writing the signature files failed (${error.message}); ${detail}.`, { cause: error });
  } finally {
    // Staged files are always removed; a backup is kept only if its original could not be restored.
    for (const [temporary] of staged) rmSync(temporary, { force: true });
    for (const [, backup] of backups) rmSync(backup, { force: true });
  }
}

/**
 * Signs the committed catalog with KMS and writes the schema-v2 envelope files.
 * Nothing is written unless every check passes and the signature verifies locally.
 */
export async function signRegistryCatalogWithKms({ root = repositoryRoot, kms, kmsKeyId, expectedKeyId, fileSystem }) {
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

export async function main({ argv = process.argv.slice(2), env = process.env, kms } = {}) {
  const { values } = parseArgs({ args: argv, options: { root: { type: 'string' } }, strict: true, allowPositionals: false });
  const client = kms ?? createAwsCliKmsClient({ region: env.UIFN_REGISTRY_KMS_REGION });
  const { envelope, files } = await signRegistryCatalogWithKms({
    root: values.root === undefined ? repositoryRoot : path.resolve(values.root),
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
  main().then(
    (summary) => console.log(JSON.stringify(summary, null, 2)),
    (error) => {
      console.error(JSON.stringify({ ok: false, code: error.code ?? 'UIFN_REGISTRY_KMS_SIGN_FAILED', message: error.message }, null, 2));
      process.exitCode = 1;
    },
  );
}
