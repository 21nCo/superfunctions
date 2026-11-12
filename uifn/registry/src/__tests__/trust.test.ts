import { createHash, createPublicKey, generateKeyPairSync, sign, verify as cryptoVerify, webcrypto, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types } from 'node:util';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_CATALOG_PAYLOAD_JSON } from '../generated/catalog';
import { REGISTRY_SIGNATURE } from '../generated/signature';
import { REGISTRY_TRUST_ROOT_KEY_ID, verifyRegistryCatalogSignature } from '../trust';
import { REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM } from '../trust-root';
import { registryKeyId, registrySigningInput, verifyRegistrySignatureEnvelope } from '../trust-verify';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageRoot, '../..');
const PINNED_KEY_ID = 'a72cc93c0e85e7af79cf582c';
const INVALID = { ok: false, code: 'UIFN_REGISTRY_SIGNATURE_INVALID' } as const;

interface TestKey { privateKey: KeyObject; pem: string; keyId: string }

function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId: registryKeyId(publicKey) };
}

const sha256Hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** A schema-v2 envelope over `catalog`, signed over `message` (the correct domain-separated input by default). */
function envelopeFor(key: TestKey, catalog: string, message: Uint8Array = registrySigningInput(Buffer.from(catalog))) {
  return {
    schemaVersion: 2,
    algorithm: 'Ed25519',
    domain: 'uifn-registry-v2',
    keyId: key.keyId,
    catalogSha256: sha256Hex(catalog),
    signatureBase64: sign(null, message, key.privateKey).toString('base64'),
  };
}

const catalog = REGISTRY_CATALOG_PAYLOAD_JSON;
const root = testKey();

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Sets an unused pad bit of a 64-byte signature's Base64 form; Buffer.from still decodes the same 64 bytes. */
function withAlteredPadBits(signatureBase64: string): string {
  const index = signatureBase64.length - 3;
  const altered = BASE64_ALPHABET[BASE64_ALPHABET.indexOf(signatureBase64[index]!) ^ 1]!;
  return `${signatureBase64.slice(0, index)}${altered}${signatureBase64.slice(index + 1)}`;
}

/** A built-in object carrying the valid envelope's fields, with its prototype reset so only internal slots remain. */
function builtinCarrier(target: object, prototype: object | null): unknown {
  return Object.setPrototypeOf(Object.assign(target, envelopeFor(root, catalog)), prototype);
}

/** Built-ins with internal slots that must not pass as a plain envelope, whatever their prototype. */
const nonPlainBuiltins = (): [string, unknown][] => [
    ['a Date with Object.prototype', builtinCarrier(new Date(), Object.prototype)],
    ['a Date with a null prototype', builtinCarrier(new Date(), null)],
    ['a Map with a null prototype', builtinCarrier(new Map(), null)],
    ['a Set with Object.prototype', builtinCarrier(new Set(), Object.prototype)],
    ['a RegExp with Object.prototype', builtinCarrier(/x/, Object.prototype)],
    ['a boxed number', builtinCarrier(new Number(1), null)],
    ['a boxed string', builtinCarrier(new String(''), Object.prototype)],
    ['a boxed boolean', builtinCarrier(new Boolean(false), null)],
    ['a typed array', builtinCarrier(new Uint8Array(0), null)],
    ['an ArrayBuffer', builtinCarrier(new ArrayBuffer(0), Object.prototype)],
    ['a SharedArrayBuffer', builtinCarrier(new SharedArrayBuffer(0), null)],
    ['a DataView', builtinCarrier(new DataView(new ArrayBuffer(0)), Object.prototype)],
    ['a WeakMap', builtinCarrier(new WeakMap(), null)],
    ['a promise', builtinCarrier(Promise.resolve(), null)],
    ['an error', builtinCarrier(new Error('x'), null)],
    ['a WeakRef', builtinCarrier(new WeakRef({}), null)],
    ['a FinalizationRegistry', builtinCarrier(new FinalizationRegistry(() => undefined), Object.prototype)],
    ['an Intl.Collator', builtinCarrier(new Intl.Collator(), null)],
    ['an Intl.NumberFormat', builtinCarrier(new Intl.NumberFormat(), Object.prototype)],
    ['an Intl.Locale', builtinCarrier(new Intl.Locale('en'), null)],
    ['an array iterator', builtinCarrier([].values(), Object.prototype)],
    ['a string iterator', builtinCarrier(''[Symbol.iterator](), null)],
    ['a RegExp string iterator', builtinCarrier('a'.matchAll(/a/g), null)],
    ['a generator', builtinCarrier((function* generator() { /* empty */ })(), null)],
    ['an async generator', builtinCarrier((async function* generator() { /* empty */ })(), Object.prototype)],
    ['an arguments object', builtinCarrier((function args() { return arguments; })(), null)],
];

/** Envelopes the schema-v2 verifier must reject as malformed. */
const malformedEnvelopes = (): [string, unknown][] => [
    ['null', null],
    ['undefined', undefined],
    ['a string', JSON.stringify(envelopeFor(root, catalog))],
    ['an array', [envelopeFor(root, catalog)]],
    ['a class instance', Object.assign(new (class Envelope {})(), envelopeFor(root, catalog))],
    ['no schemaVersion', (({ schemaVersion: _, ...rest }) => rest)(envelopeFor(root, catalog))],
    ['a missing signature', (({ signatureBase64: _, ...rest }) => rest)(envelopeFor(root, catalog))],
    ['an extra field', { ...envelopeFor(root, catalog), note: 'x' }],
    ['an extra symbol field', { ...envelopeFor(root, catalog), [Symbol('x')]: 1 }],
    ['an upper-case key id', { ...envelopeFor(root, catalog), keyId: root.keyId.toUpperCase() }],
    ['a short key id', { ...envelopeFor(root, catalog), keyId: root.keyId.slice(0, 23) }],
    ['an upper-case digest', { ...envelopeFor(root, catalog), catalogSha256: sha256Hex(catalog).toUpperCase() }],
    ['a numeric digest', { ...envelopeFor(root, catalog), catalogSha256: 7 }],
    ['non-base64 signature', { ...envelopeFor(root, catalog), signatureBase64: '!!!!' }],
    ['unpadded signature', { ...envelopeFor(root, catalog), signatureBase64: envelopeFor(root, catalog).signatureBase64.replace(/=+$/, '') }],
    ['a 63-byte signature', { ...envelopeFor(root, catalog), signatureBase64: Buffer.alloc(63).toString('base64') }],
    ['an empty signature', { ...envelopeFor(root, catalog), signatureBase64: '' }],
    ['noncanonical signature pad bits', { ...envelopeFor(root, catalog), signatureBase64: withAlteredPadBits(envelopeFor(root, catalog).signatureBase64) }],
    ['an 89-character signature', { ...envelopeFor(root, catalog), signatureBase64: `${envelopeFor(root, catalog).signatureBase64}A` }],
    ['an object-valued algorithm', { ...envelopeFor(root, catalog), algorithm: { toString: () => 'Ed25519' } }],
    ['a boxed-string key id', { ...envelopeFor(root, catalog), keyId: Object(root.keyId) }],
    ['an 8 MiB signature', { ...envelopeFor(root, catalog), signatureBase64: 'A'.repeat(8 * 1024 * 1024) }],
    ...nonPlainBuiltins(),
];

describe('schema-v2 registry signature verification', () => {
  it('accepts a schema-v2 envelope signed over UTF8("uifn-registry-v2\\0") || SHA-256(catalog)', () => {
    const input = registrySigningInput(Buffer.from(catalog));
    expect(input).toHaveLength(49);
    expect(input.subarray(0, 17).toString('utf8')).toBe('uifn-registry-v2\0');
    expect(input.subarray(17).toString('hex')).toBe(sha256Hex(catalog));
    expect(verifyRegistrySignatureEnvelope(catalog, envelopeFor(root, catalog), root.pem)).toEqual({
      ok: true,
      keyId: root.keyId,
      catalogSha256: sha256Hex(catalog),
    });
  });

  describe('payload tampering', () => {
    it('rejects a changed catalog whose digest no longer matches the envelope', () => {
      expect(verifyRegistrySignatureEnvelope(`${catalog} `, envelopeFor(root, catalog), root.pem))
        .toMatchObject({ ...INVALID, reason: 'digest-mismatch', catalogSha256: sha256Hex(`${catalog} `) });
    });

    it('rejects a changed catalog even when the envelope digest is updated to match it', () => {
      const tampered = catalog.replace('"schemaVersion": 2', '"schemaVersion": 3');
      expect(tampered).not.toBe(catalog);
      const envelope = { ...envelopeFor(root, catalog), catalogSha256: sha256Hex(tampered) };
      expect(verifyRegistrySignatureEnvelope(tampered, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'signature-invalid' });
    });
  });

  describe('digest tampering', () => {
    it('rejects an envelope digest that differs from the recomputed catalog digest', () => {
      const envelope = { ...envelopeFor(root, catalog), catalogSha256: 'f'.repeat(64) };
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'digest-mismatch' });
    });

    it('never verifies against the envelope digest: a valid signature over another catalog does not transfer', () => {
      const signedCatalog = '{"other":"catalog"}';
      // The signature and digest are genuinely valid for signedCatalog; the presented catalog is different.
      const envelope = envelopeFor(root, signedCatalog);
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'digest-mismatch' });
    });

    it('rejects a signature over the bare digest or the complete catalog bytes (no domain separation)', () => {
      const bareDigest = createHash('sha256').update(catalog).digest();
      for (const message of [bareDigest, Buffer.from(catalog)]) {
        expect(verifyRegistrySignatureEnvelope(catalog, envelopeFor(root, catalog, message), root.pem))
          .toMatchObject({ ...INVALID, reason: 'signature-invalid' });
      }
    });
  });

  describe('wrong domain', () => {
    it('rejects an envelope that names another domain', () => {
      for (const domain of ['uifn-registry-v1', 'uifn-registry-v2\0', 'UIFN-REGISTRY-V2', '', undefined]) {
        const envelope = { ...envelopeFor(root, catalog), domain };
        expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem), String(domain)).toMatchObject({ ...INVALID, reason: 'domain-mismatch' });
      }
    });

    it('rejects a signature made under another domain prefix even when the envelope names the right one', () => {
      const digest = createHash('sha256').update(catalog).digest();
      for (const prefix of ['uifn-registry-v1\0', 'uifn-registry-v2', 'uifn-registry-v3\0']) {
        const message = Buffer.concat([Buffer.from(prefix, 'utf8'), digest]);
        expect(verifyRegistrySignatureEnvelope(catalog, envelopeFor(root, catalog, message), root.pem), prefix)
          .toMatchObject({ ...INVALID, reason: 'signature-invalid' });
      }
    });
  });

  describe('wrong key', () => {
    it('rejects a self-consistent envelope from a replacement key', () => {
      const other = testKey();
      expect(verifyRegistrySignatureEnvelope(catalog, envelopeFor(other, catalog), root.pem))
        .toMatchObject({ ...INVALID, reason: 'key-mismatch', keyId: root.keyId });
    });

    it('rejects a replacement-key signature that claims the trusted key id', () => {
      const other = testKey();
      const envelope = { ...envelopeFor(other, catalog), keyId: root.keyId };
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'signature-invalid' });
    });

    it('rejects every signature when the trust root is not an Ed25519 public key', () => {
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const ecPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      for (const pem of [ecPem, 'not a key']) {
        expect(verifyRegistrySignatureEnvelope(catalog, envelopeFor(root, catalog), pem)).toMatchObject({ ...INVALID, reason: 'trust-root-invalid' });
      }
    });
  });

  describe('wrong algorithm', () => {
    it('rejects any algorithm other than Ed25519', () => {
      for (const algorithm of ['ed25519', 'ED25519_SHA_512', 'ECDSA_SHA_256', 'Ed448', undefined]) {
        const envelope = { ...envelopeFor(root, catalog), algorithm };
        expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem), String(algorithm)).toMatchObject({ ...INVALID, reason: 'algorithm-unsupported' });
      }
    });
  });

  describe('legacy (schema v1) envelopes', () => {
    it('rejects a v1 envelope even when its signature over the raw catalog is valid for the trust root', () => {
      const v1 = {
        schemaVersion: 1,
        algorithm: 'Ed25519',
        keyId: root.keyId,
        catalogSha256: sha256Hex(catalog),
        signatureBase64: sign(null, Buffer.from(catalog), root.privateKey).toString('base64'),
      };
      expect(verifyRegistrySignatureEnvelope(catalog, v1, root.pem)).toMatchObject({ ...INVALID, reason: 'schema-unsupported' });
      // Adding a v2 domain does not upgrade a v1 envelope.
      expect(verifyRegistrySignatureEnvelope(catalog, { ...v1, domain: 'uifn-registry-v2' }, root.pem))
        .toMatchObject({ ...INVALID, reason: 'schema-unsupported' });
    });

    it('rejects the last published v1 signature of this catalog under the pinned KMS root', () => {
      const publishedV1 = {
        schemaVersion: 1,
        algorithm: 'Ed25519',
        keyId: 'af26384964522699ef39dd80',
        catalogSha256: '7ae7efc26b69564ece5b488bc1cbec398106ef43cbe18026e066962602b135d5',
        signatureBase64: 'GTzK/LpBeBu9N6GMXxYPpyVaiRIonyRS/a1mPgBF1bTCLb0KeOPJTS8azphqbBDAuv1OWLoXykp47sbPLn88AQ==',
      };
      expect(verifyRegistryCatalogSignature(catalog, publishedV1)).toMatchObject({ ...INVALID, reason: 'schema-unsupported', keyId: PINNED_KEY_ID });
    });

    it('rejects other schema versions', () => {
      for (const schemaVersion of [0, 3, '2', 2.5, null]) {
        const envelope = { ...envelopeFor(root, catalog), schemaVersion };
        expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem), String(schemaVersion)).toMatchObject({ ...INVALID, reason: 'schema-unsupported' });
      }
    });
  });

  describe('malformed envelopes', () => {
    const valid = () => envelopeFor(root, catalog);

    it.each(malformedEnvelopes())('rejects %s', (_label, envelope) => {
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'envelope-malformed', keyId: root.keyId });
    });

    it('never invokes accessor properties', () => {
      let invoked = false;
      const envelope = valid();
      Object.defineProperty(envelope, 'signatureBase64', { enumerable: true, get() { invoked = true; return valid().signatureBase64; } });
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      expect(invoked).toBe(false);
    });

    it('never invokes accessors under symbol keys, including the ones node:crypto brand checks read', async () => {
      const { publicKey } = generateKeyPairSync('ed25519');
      const cryptoKey = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const symbols = [...Object.getOwnPropertySymbols(publicKey), ...Object.getOwnPropertySymbols(cryptoKey.publicKey), Symbol('x')];
      const phase16 = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs')).href);
      for (const symbol of symbols) {
        let invoked = 0;
        const envelope = Object.defineProperty(valid(), symbol, { enumerable: true, get() { invoked += 1; return 1; } });
        expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem), String(symbol)).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
        expect(phase16.verifyRegistrySignatureFile(catalog, envelope, root.pem), String(symbol)).toMatchObject({ valid: false, reason: 'envelope-malformed' });
        expect(invoked, String(symbol)).toBe(0);
      }
    });

    it('never walks the contents of a Map, Set or error carrier', async () => {
      const phase16 = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs')).href);
      let invoked = 0;
      const hidden = { get x() { invoked += 1; return 1; } };
      const carriers: [string, unknown][] = [
        ['Map', builtinCarrier(new Map([['hidden', hidden]]), null)],
        ['Set', builtinCarrier(new Set([hidden]), Object.prototype)],
        ['error', builtinCarrier(Object.assign(new Error('x'), { cause: hidden }), null)],
      ];
      for (const [label, carrier] of carriers) {
        expect(verifyRegistrySignatureEnvelope(catalog, carrier, root.pem), label).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
        expect(phase16.verifyRegistrySignatureFile(catalog, carrier, root.pem), label).toMatchObject({ valid: false, reason: 'envelope-malformed' });
      }
      expect(invoked).toBe(0);
    });

    it('rejects binary carriers without cloning or copying their backing store', async () => {
      const phase16 = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs')).href);
      const size = 64 * 1024 * 1024;
      const carriers: [string, object][] = [
        ['a 64 MiB ArrayBuffer', builtinCarrier(new ArrayBuffer(size), Object.prototype) as object],
        ['a zero-length view over a 64 MiB buffer', builtinCarrier(new Uint8Array(new ArrayBuffer(size), 0, 0), null) as object],
      ];
      const clone = vi.spyOn(globalThis, 'structuredClone');
      try {
        for (const [label, carrier] of carriers) {
          const before = process.memoryUsage().arrayBuffers;
          expect(verifyRegistrySignatureEnvelope(catalog, carrier, root.pem), label).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
          expect(phase16.verifyRegistrySignatureFile(catalog, carrier, root.pem), label).toMatchObject({ valid: false, reason: 'envelope-malformed' });
          expect(process.memoryUsage().arrayBuffers - before, label).toBeLessThan(size / 8);
          expect(clone.mock.calls.some(([value]) => value === carrier), label).toBe(false);
        }
      } finally {
        clone.mockRestore();
      }
    });

    it('accepts a same-realm envelope when the core runs in another realm with the host structuredClone', () => {
      // Evaluates the shared core as a script in a vm context; node:crypto and node:util come from the host.
      const source = readFileSync(path.join(packageRoot, 'src/trust-verify-core.mjs'), 'utf8')
        .replace(/^import \{([^}]*)\} from 'node:[a-z]+';$/gm, 'const {$1} = host;')
        .replace(/^export /gm, '');
      expect(source).not.toMatch(/^import /m);
      const context = vm.createContext({ Buffer, structuredClone });
      const load = vm.runInContext(`(host) => { ${source}\n return verifyRegistrySignatureEnvelope; }`, context) as
        (host: object) => typeof verifyRegistrySignatureEnvelope;
      const realmVerify = load({ createHash, createPublicKey, verify: cryptoVerify, types });
      const fields = envelopeFor(root, catalog);
      const inRealm = vm.runInContext('(fields) => [{ ...fields }, Object.assign(Object.create(null), fields)]', context) as (f: object) => object[];
      for (const envelope of inRealm(fields)) {
        expect(realmVerify(catalog, envelope, root.pem)).toEqual({ ok: true, keyId: root.keyId, catalogSha256: sha256Hex(catalog) });
      }
      const realmCarriers = vm.runInContext(`(fields) => [new Date(), new ArrayBuffer(8), new Map(), /x/]
        .map((target) => Object.setPrototypeOf(Object.assign(target, fields), Object.prototype))`, context) as (f: object) => object[];
      for (const carrier of [...realmCarriers(fields), fields, builtinCarrier(new Date(), Object.prototype) as object]) {
        expect(realmVerify(catalog, carrier, root.pem)).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      }
    });

    it('never runs code reachable from an object-valued field', () => {
      let invoked = 0;
      const field = { get value() { invoked += 1; return 'x'; }, toString() { invoked += 1; return 'Ed25519'; } };
      for (const name of ['algorithm', 'domain', 'keyId', 'catalogSha256', 'signatureBase64']) {
        expect(verifyRegistrySignatureEnvelope(catalog, { ...valid(), [name]: field }, root.pem), name).toMatchObject({ ...INVALID });
      }
      expect(invoked).toBe(0);
    });

    it('rejects a proxy without running any of its traps', () => {
      const traps: string[] = [];
      const recording = <T extends object>(target: T) => new Proxy(target, new Proxy({}, {
        get: (_handler, trap: string) => (...args: unknown[]) => {
          traps.push(trap);
          return (Reflect as unknown as Record<string, (...a: unknown[]) => unknown>)[trap]!(...args);
        },
      }));
      // Even a proxy over a valid envelope is rejected, before inspection.
      expect(verifyRegistrySignatureEnvelope(catalog, valid(), root.pem)).toMatchObject({ ok: true });
      expect(verifyRegistrySignatureEnvelope(catalog, recording(valid()), root.pem)).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      expect(verifyRegistryCatalogSignature(REGISTRY_CATALOG_PAYLOAD_JSON, recording({ ...REGISTRY_SIGNATURE })))
        .toMatchObject({ ...INVALID, reason: 'envelope-malformed', keyId: PINNED_KEY_ID });
      expect(verifyRegistrySignatureEnvelope(catalog, recording(Object.assign(Object.create(null), valid())), root.pem))
        .toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      // A proxy further up the prototype chain is never reached either.
      const proxyPrototype = Object.create(recording({}), Object.getOwnPropertyDescriptors(valid()));
      expect(verifyRegistrySignatureEnvelope(catalog, proxyPrototype, root.pem)).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      expect(traps).toEqual([]);
    });

    it('accepts the canonical signature whose pad-bit variant is rejected', () => {
      const envelope = valid();
      const altered = withAlteredPadBits(envelope.signatureBase64);
      expect(altered).not.toBe(envelope.signatureBase64);
      expect(Buffer.from(altered, 'base64')).toEqual(Buffer.from(envelope.signatureBase64, 'base64'));
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ok: true });
      expect(verifyRegistrySignatureEnvelope(catalog, { ...envelope, signatureBase64: altered }, root.pem))
        .toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
    });

    it('rejects a signature that is not exactly 88 characters before any pattern match or decoding, without throwing', () => {
      const signatureBase64 = valid().signatureBase64;
      expect(signatureBase64).toHaveLength(88);
      for (const candidate of [signatureBase64.slice(0, 87), `${signatureBase64}=`, 'A'.repeat(8 * 1024 * 1024), 'A'.repeat(32 * 1024 * 1024)]) {
        let result: ReturnType<typeof verifyRegistrySignatureEnvelope> | undefined;
        expect(() => { result = verifyRegistrySignatureEnvelope(catalog, { ...valid(), signatureBase64: candidate }, root.pem); }).not.toThrow();
        expect(result).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      }
    });

    it('fails closed when a proxy trap throws', () => {
      const envelope = new Proxy(valid(), { getOwnPropertyDescriptor() { throw new Error('trap'); } });
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ...INVALID, reason: 'envelope-malformed' });
      const prototypeTrap = new Proxy(valid(), { getPrototypeOf() { throw new Error('trap'); } });
      expect(verifyRegistryCatalogSignature(catalog, prototypeTrap)).toMatchObject({ ...INVALID, reason: 'envelope-malformed', keyId: PINNED_KEY_ID });
    });

    it('accepts a null-prototype envelope with the same fields', () => {
      const envelope = Object.assign(Object.create(null), valid());
      expect(verifyRegistrySignatureEnvelope(catalog, envelope, root.pem)).toMatchObject({ ok: true });
    });
  });
});

describe('pinned KMS trust root', () => {
  it('pins the KMS Ed25519 public key with key id a72cc93c0e85e7af79cf582c in source, PEM file and README', () => {
    const publicKey = createPublicKey(REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM);
    expect(publicKey.asymmetricKeyType).toBe('ed25519');
    expect(registryKeyId(publicKey)).toBe(PINNED_KEY_ID);
    expect(REGISTRY_TRUST_ROOT_KEY_ID).toBe(PINNED_KEY_ID);
    expect(readFileSync(path.join(packageRoot, 'trust/registry-ed25519-public.pem'), 'utf8')).toBe(REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM);
    expect(readFileSync(path.join(packageRoot, 'README.md'), 'utf8')).toContain(`\`${PINNED_KEY_ID}\``);
  });

  it('reports the pinned key id for every verification result', () => {
    expect(verifyRegistryCatalogSignature(catalog, null)).toMatchObject({ ...INVALID, keyId: PINNED_KEY_ID, catalogSha256: sha256Hex(catalog) });
  });

  it('keeps no local private-key signer in the repository', () => {
    expect(() => readFileSync(path.join(repoRoot, 'scripts/sign-uifn-registry.mjs'))).toThrow(/ENOENT/);
  });
});

describe('KMS signer interoperability', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('accepts exactly the envelope that the KMS release signer writes', async () => {
    const signer = await import(pathToFileURL(path.join(repoRoot, 'scripts/sign-uifn-registry-kms.mjs')).href);
    const checkout = mkdtempSync(path.join(tmpdir(), 'uifn-registry-trust-'));
    directories.push(checkout);
    mkdirSync(path.join(checkout, 'uifn/registry/generated'), { recursive: true });
    mkdirSync(path.join(checkout, 'uifn/registry/src/generated'), { recursive: true });
    writeFileSync(path.join(checkout, signer.REGISTRY_CATALOG_PATH), catalog);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const kmsKeyArn = 'arn:aws:kms:us-east-1:000000000000:key/test';
    const kms = {
      async getPublicKey() {
        return { KeyId: kmsKeyArn, KeySpec: 'ECC_NIST_EDWARDS25519', PublicKey: publicKey.export({ type: 'spki', format: 'der' }) };
      },
      async sign(input: { Message: Uint8Array; SigningAlgorithm: string }) {
        return { KeyId: kmsKeyArn, SigningAlgorithm: input.SigningAlgorithm, Signature: sign(null, Buffer.from(input.Message), privateKey) };
      },
    };
    const { envelope } = await signer.signRegistryCatalogWithKms({ root: checkout, kms, kmsKeyId: 'alias/test', expectedKeyId: registryKeyId(publicKey) });
    const written = JSON.parse(readFileSync(path.join(checkout, signer.REGISTRY_SIGNATURE_JSON_PATH), 'utf8'));
    expect(written).toEqual(envelope);
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyRegistrySignatureEnvelope(catalog, written, pem)).toMatchObject({ ok: true, keyId: registryKeyId(publicKey) });
    expect(Buffer.from(signer.registryV2SigningInput(Buffer.from(catalog)))).toEqual(registrySigningInput(Buffer.from(catalog)));
  });
});

describe('phase-16 static signature check', () => {
  it('accepts exactly the envelopes the runtime verifier accepts', async () => {
    const phase16 = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs')).href);
    const other = testKey();
    const valid = envelopeFor(root, catalog);
    const cases: [string, unknown][] = [
      ['valid', valid],
      ['null-prototype valid', Object.assign(Object.create(null), valid)],
      ['tampered digest', { ...valid, catalogSha256: sha256Hex(`${catalog} `) }],
      ['wrong key', envelopeFor(other, catalog)],
      ['schema v1', { schemaVersion: 1, algorithm: 'Ed25519', keyId: root.keyId, catalogSha256: sha256Hex(catalog), signatureBase64: valid.signatureBase64 }],
      ['wrong domain', { ...valid, domain: 'uifn-registry-v1' }],
      ['proxy over valid', new Proxy(valid, {})],
      ...malformedEnvelopes(),
    ];
    for (const [label, envelope] of cases) {
      const runtime = verifyRegistrySignatureEnvelope(catalog, envelope, root.pem);
      expect(phase16.verifyRegistrySignatureFile(catalog, envelope, root.pem), label).toEqual(runtime.ok
        ? { valid: true, keyId: root.keyId, catalogSha256: sha256Hex(catalog) }
        : { valid: false, keyId: root.keyId, catalogSha256: sha256Hex(catalog), reason: runtime.reason });
    }
    expect(phase16.verifyRegistrySignatureFile(catalog, REGISTRY_SIGNATURE, REGISTRY_TRUST_ROOT_PUBLIC_KEY_PEM))
      .toEqual({ valid: true, keyId: PINNED_KEY_ID, catalogSha256: sha256Hex(catalog) });
  });

  it('fails closed without throwing for trust roots that are not a parseable Ed25519 key', async () => {
    const phase16 = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs')).href);
    const input = registrySigningInput(Buffer.from(catalog));
    /** A non-Ed25519 root whose envelope carries the root's own derived key id and a 64-byte signature it verifies. */
    const foreignRoot = (label: string, type: 'ec' | 'rsa', options: object, signOptions: object = {}): [string, string, unknown] => {
      const { privateKey, publicKey } = generateKeyPairSync(type as 'ec', options as { namedCurve: string });
      let signature = Buffer.alloc(0);
      for (let attempt = 0; attempt < 512 && signature.length !== 64; attempt += 1) {
        signature = sign(null, input, { key: privateKey, ...signOptions });
      }
      expect(signature, label).toHaveLength(64);
      const envelope = { ...envelopeFor(root, catalog), keyId: registryKeyId(publicKey), signatureBase64: signature.toString('base64') };
      return [label, publicKey.export({ type: 'spki', format: 'pem' }).toString(), envelope];
    };
    const roots: [string, string, unknown][] = [
      ['malformed PEM', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n', envelopeFor(root, catalog)],
      ['empty PEM', '', envelopeFor(root, catalog)],
      foreignRoot('P-224 root', 'ec', { namedCurve: 'P-224' }),
      foreignRoot('P-256 root', 'ec', { namedCurve: 'prime256v1' }, { dsaEncoding: 'ieee-p1363' }),
      foreignRoot('RSA root', 'rsa', { modulusLength: 512 }),
    ];
    for (const [label, pem, envelope] of roots) {
      let runtime: ReturnType<typeof verifyRegistrySignatureEnvelope> | undefined;
      let file: unknown;
      expect(() => { runtime = verifyRegistrySignatureEnvelope(catalog, envelope, pem); }, label).not.toThrow();
      expect(() => { file = phase16.verifyRegistrySignatureFile(catalog, envelope, pem); }, label).not.toThrow();
      expect(runtime, label).toEqual({ ...INVALID, reason: 'trust-root-invalid', keyId: '', catalogSha256: sha256Hex(catalog) });
      expect(file, label).toEqual({ valid: false, keyId: '', catalogSha256: sha256Hex(catalog), reason: 'trust-root-invalid' });
    }
  });

  it('delegates to the runtime verifier instead of carrying its own copy of the signature rules', () => {
    const phase16Source = readFileSync(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs'), 'utf8');
    const runtimeSource = readFileSync(path.join(packageRoot, 'src/trust-verify.ts'), 'utf8');
    for (const source of [phase16Source, runtimeSource]) {
      expect(source).toContain('trust-verify-core.mjs');
      expect(source).not.toMatch(/createPublicKey|uifn-registry-v2|signatureBase64/);
    }
  });

  it('reports UIFN_REGISTRY_SIGNATURE_INVALID from inspectPhase16 instead of throwing on an unusable trust root', async () => {
    const phase16 = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-uifn-phase-16.mjs')).href);
    const pemPath = path.join(packageRoot, 'trust/registry-ed25519-public.pem');
    const pinned = readFileSync(pemPath);
    type Inspection = { failures: { code: string; reason?: string }[]; signature: { valid: boolean; keyId: string } };
    // The unusable root is injected; the tracked PEM is never written.
    const unusableRoots: [string, () => string][] = [
      ['malformed PEM', () => '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n'],
      ['unreadable PEM', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }],
    ];
    for (const [label, readTrustRootPem] of unusableRoots) {
      let inspection: Inspection | undefined;
      expect(() => { inspection = phase16.inspectPhase16({ readTrustRootPem }); }, label).not.toThrow();
      expect(inspection?.signature, label).toMatchObject({ valid: false, keyId: '' });
      expect(inspection?.failures, label).toContainEqual({ code: 'UIFN_REGISTRY_SIGNATURE_INVALID', reason: 'trust-root-invalid' });
    }
    const pinnedInspection: Inspection = phase16.inspectPhase16();
    expect(pinnedInspection.signature).toMatchObject({ valid: true, keyId: PINNED_KEY_ID });
    expect(pinnedInspection.failures.filter((failure) => failure.code === 'UIFN_REGISTRY_SIGNATURE_INVALID')).toEqual([]);
    expect(readFileSync(pemPath).equals(pinned)).toBe(true);
  });
});

describe('bundled catalog signature', () => {
  it('ships the committed catalog bytes and the committed signature envelope', () => {
    expect(readFileSync(path.join(packageRoot, 'generated/catalog.json'), 'utf8')).toBe(catalog);
    expect(JSON.parse(readFileSync(path.join(packageRoot, 'generated/catalog-signature.json'), 'utf8'))).toEqual(REGISTRY_SIGNATURE);
  });

  it('verifies the bundled catalog with the KMS-signed schema-v2 envelope', () => {
    expect(REGISTRY_SIGNATURE).toMatchObject({ schemaVersion: 2, domain: 'uifn-registry-v2', keyId: PINNED_KEY_ID });
    expect(verifyRegistryCatalogSignature()).toEqual({ ok: true, keyId: PINNED_KEY_ID, catalogSha256: sha256Hex(catalog) });
  });
});
