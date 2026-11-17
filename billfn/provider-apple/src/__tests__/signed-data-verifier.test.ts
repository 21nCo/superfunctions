import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APPLE_ROOT_CA_G3, APPLE_ROOT_CA_G3_SHA256 } from '../apple-root-ca.js';
import {
  createAppleSignedDataVerifier,
  createAppleSignedDataVerifierForRoot,
  verifyAppleCertificateChainToPinnedRoot,
  type AppleSignedDataVerificationFailure
} from '../signed-data-verifier.js';
import {
  APPLE_REAL_CHAIN_EFFECTIVE_DATE,
  APPLE_REAL_INTERMEDIATE,
  APPLE_REAL_ROOT,
  APPLE_REAL_SIGNING_CERTIFICATE,
  APPLE_SAMPLE_SIGNED_TRANSACTION,
  APPLE_SAMPLE_TEST_CA,
  APPLE_SAMPLE_TEST_NOTIFICATION,
  APPLE_SAMPLE_WRONG_BUNDLE_NOTIFICATION
} from './fixtures/apple-published-samples.js';
import {
  APPLE_INTERMEDIATE_OID,
  APPLE_LEAF_OID,
  generateAppleChain,
  generateCertificate,
  sampleSubscribedNotification,
  sha256Hex,
  signJws,
  type GeneratedChain
} from './fixtures/generated-chain.js';

const DAY = 24 * 60 * 60 * 1000;

function sampleRootOf(jws: string): string {
  return (JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString()) as { x5c: string[] }).x5c[2];
}

function verifierFor(chain: Pick<GeneratedChain, 'root'>, bundleId = 'com.example', now?: () => Date) {
  return createAppleSignedDataVerifierForRoot({ bundleId, rootCertificate: chain.root.base64, now });
}

async function expectFailure(promise: Promise<unknown>, reason: AppleSignedDataVerificationFailure) {
  await expect(promise).rejects.toMatchObject({ name: 'AppleSignedDataVerificationError', reason });
}

describe('bundled Apple Root CA - G3', () => {
  it('is Apple Root CA - G3 and matches its pinned SHA-256', () => {
    const der = Buffer.from(APPLE_ROOT_CA_G3, 'base64');
    expect(sha256Hex(der)).toBe(APPLE_ROOT_CA_G3_SHA256);
    // Apple's published fingerprint, written out independently of the pin constant.
    expect(APPLE_ROOT_CA_G3_SHA256).toBe('63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179');
    expect(new X509Certificate(der).subject).toContain('CN=Apple Root CA - G3');
    expect(APPLE_ROOT_CA_G3).toBe(APPLE_REAL_ROOT);
  });
});

describe("Apple's published samples", () => {
  it('verifies the production App Store chain to the pinned root while its leaf is valid', async () => {
    const chain = [APPLE_REAL_SIGNING_CERTIFICATE, APPLE_REAL_INTERMEDIATE, APPLE_REAL_ROOT];
    await expect(verifyAppleCertificateChainToPinnedRoot(chain, APPLE_REAL_CHAIN_EFFECTIVE_DATE)).resolves.toMatchObject({
      type: 'public',
      algorithm: { name: 'ECDSA', namedCurve: 'P-256' }
    });
  });

  it('rejects the production App Store chain once its leaf has expired', async () => {
    const chain = [APPLE_REAL_SIGNING_CERTIFICATE, APPLE_REAL_INTERMEDIATE, APPLE_REAL_ROOT];
    const afterLeafExpiry = new Date(new X509Certificate(Buffer.from(APPLE_REAL_SIGNING_CERTIFICATE, 'base64')).validTo).getTime() + 1000;
    await expectFailure(verifyAppleCertificateChainToPinnedRoot(chain, new Date(afterLeafExpiry)), 'certificate_expired');
  });

  it('rejects the production leaf presented as its own intermediate', async () => {
    const chain = [APPLE_REAL_SIGNING_CERTIFICATE, APPLE_REAL_SIGNING_CERTIFICATE, APPLE_REAL_ROOT];
    await expectFailure(verifyAppleCertificateChainToPinnedRoot(chain, APPLE_REAL_CHAIN_EFFECTIVE_DATE), 'invalid_chain');
  });

  it('verifies the sample TEST notification and reports its Sandbox environment', async () => {
    const verifier = createAppleSignedDataVerifierForRoot({
      bundleId: 'com.example',
      rootCertificate: sampleRootOf(APPLE_SAMPLE_TEST_NOTIFICATION)
    });
    await expect(verifier.verifyNotification(APPLE_SAMPLE_TEST_NOTIFICATION)).resolves.toEqual({
      environment: 'sandbox',
      payload: expect.objectContaining({ notificationType: 'TEST', notificationUUID: '9ad56bd2-0bc6-42e0-af24-fd996d87a1e6' })
    });
  });

  it('verifies the sample signed transaction', async () => {
    const verifier = createAppleSignedDataVerifierForRoot({
      bundleId: 'com.example',
      rootCertificate: sampleRootOf(APPLE_SAMPLE_SIGNED_TRANSACTION)
    });
    await expect(verifier.verifyTransaction(APPLE_SAMPLE_SIGNED_TRANSACTION)).resolves.toEqual({
      environment: 'sandbox',
      payload: expect.objectContaining({ bundleId: 'com.example' })
    });
  });

  it("rejects the sample notification for another bundle ID, as Apple's library does", async () => {
    const verifier = createAppleSignedDataVerifierForRoot({ bundleId: 'com.example', rootCertificate: APPLE_SAMPLE_TEST_CA });
    await expectFailure(verifier.verifyNotification(APPLE_SAMPLE_WRONG_BUNDLE_NOTIFICATION), 'bundle_id_mismatch');
  });

  it('rejects the sample notification against the pinned Apple root, since its test chain ends elsewhere', async () => {
    const verifier = createAppleSignedDataVerifier({ bundleId: 'com.example' });
    await expectFailure(verifier.verifyNotification(APPLE_SAMPLE_TEST_NOTIFICATION), 'untrusted_root');
  });
});

describe('generated chains', () => {
  const chain = generateAppleChain();

  it('verifies a notification and reports production and sandbox environments', async () => {
    const verifier = verifierFor(chain);
    const production = await verifier.verifyNotification(signJws(sampleSubscribedNotification(chain), chain));
    expect(production.environment).toBe('production');
    expect(production.payload).toMatchObject({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY' });
    const sandbox = await verifier.verifyNotification(
      signJws(sampleSubscribedNotification(chain, { environment: 'Sandbox' }), chain)
    );
    expect(sandbox.environment).toBe('sandbox');
  });

  it('reads the app of a summary notification from its summary', async () => {
    const summary = { notificationType: 'RENEWAL_EXTENSION', subtype: 'SUMMARY', summary: { bundleId: 'com.example', environment: 'Sandbox' } };
    await expect(verifierFor(chain).verifyNotification(signJws(summary, chain))).resolves.toMatchObject({ environment: 'sandbox' });
  });

  const envelopeNotifications = {
    appData: (scope: Record<string, unknown>) => ({ notificationType: 'RESCIND_CONSENT', appData: { appAppleId: 1234567890, ...scope } }),
    unclaimInfo: (scope: Record<string, unknown>) => ({
      notificationType: 'UNCLAIM_SEATS',
      unclaimInfo: { appAppleId: 1234567890, originalTransactionId: '12345', unclaimSeatIds: ['seat-1'], ...scope }
    })
  };

  it.each(Object.entries(envelopeNotifications))(
    'reads the app and environment of a notification from its %s envelope',
    async (_envelope, notification) => {
      const verifier = verifierFor(chain);
      await expect(
        verifier.verifyNotification(signJws(notification({ bundleId: 'com.example', environment: 'Production' }), chain))
      ).resolves.toMatchObject({ environment: 'production' });
      await expect(
        verifier.verifyNotification(signJws(notification({ bundleId: 'com.example', environment: 'Sandbox' }), chain))
      ).resolves.toMatchObject({ environment: 'sandbox' });
      await expectFailure(
        verifier.verifyNotification(signJws(notification({ bundleId: 'com.example.other', environment: 'Production' }), chain)),
        'bundle_id_mismatch'
      );
      for (const environment of ['Xcode', 'constructor', undefined]) {
        await expectFailure(
          verifier.verifyNotification(signJws(notification({ bundleId: 'com.example', environment }), chain)),
          'environment_unsupported'
        );
      }
    }
  );

  it('derives the environment of an external purchase token notification from its externalPurchaseId', async () => {
    const tokenNotification = (externalPurchaseId: string) => ({
      notificationType: 'EXTERNAL_PURCHASE_TOKEN',
      subtype: 'UNREPORTED',
      externalPurchaseToken: { externalPurchaseId, tokenCreationDate: 1698148900000, appAppleId: 55555, bundleId: 'com.example' }
    });
    const verifier = verifierFor(chain);
    await expect(verifier.verifyNotification(signJws(tokenNotification('SANDBOX_test-external-purchase'), chain))).resolves.toMatchObject({
      environment: 'sandbox'
    });
    await expect(verifier.verifyNotification(signJws(tokenNotification('test-external-purchase'), chain))).resolves.toMatchObject({
      environment: 'production'
    });
  });

  it('rejects a chain that does not end at the trusted root', async () => {
    const other = generateAppleChain();
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(other), other)), 'untrusted_root');
  });

  it('rejects an intermediate that names the trusted root but was signed by another key', async () => {
    const impostor = generateCertificate({ commonName: chain.root.commonName, curve: 'P-384', ca: true });
    const forged = generateAppleChain({ trustedRoot: chain.root, intermediate: { signingKey: impostor.privateKey } });
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(forged), forged)), 'invalid_chain');
  });

  it('rejects an intermediate that is not a certificate authority', async () => {
    const forged = generateAppleChain({ trustedRoot: chain.root, intermediate: { ca: false } });
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(forged), forged)), 'invalid_chain');
  });

  it("rejects a leaf without Apple's receipt signing OID", async () => {
    const forged = generateAppleChain({ trustedRoot: chain.root, leaf: { oids: [APPLE_INTERMEDIATE_OID] } });
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(forged), forged)), 'missing_apple_oid');
  });

  it("rejects an intermediate without Apple's WWDR OID", async () => {
    const forged = generateAppleChain({ trustedRoot: chain.root, intermediate: { oids: [APPLE_LEAF_OID] } });
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(forged), forged)), 'missing_apple_oid');
  });

  it('rejects a payload changed after signing', async () => {
    const [header, , signature] = signJws(sampleSubscribedNotification(chain), chain).split('.');
    const tampered = Buffer.from(JSON.stringify(sampleSubscribedNotification(chain, { environment: 'Sandbox' }))).toString('base64url');
    await expectFailure(verifierFor(chain).verifyNotification(`${header}.${tampered}.${signature}`), 'signature_invalid');
  });

  it('rejects a signature by a key other than the leaf certificate', async () => {
    const other = generateAppleChain({ trustedRoot: chain.root });
    const signed = signJws(sampleSubscribedNotification(chain), { x5c: chain.x5c, leaf: other.leaf });
    await expectFailure(verifierFor(chain).verifyNotification(signed), 'signature_invalid');
  });

  it('rejects an expired leaf certificate and one not valid yet', async () => {
    const expired = generateAppleChain({
      trustedRoot: chain.root,
      leaf: { notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) }
    });
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(expired), expired)), 'certificate_expired');
    const valid = signJws(sampleSubscribedNotification(chain), chain);
    await expectFailure(verifierFor(chain, 'com.example', () => new Date(Date.now() - 2 * DAY)).verifyNotification(valid), 'certificate_expired');
  });

  it('rejects an expired intermediate certificate', async () => {
    const expired = generateAppleChain({
      trustedRoot: chain.root,
      intermediate: { notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) }
    });
    await expectFailure(verifierFor(chain).verifyNotification(signJws(sampleSubscribedNotification(expired), expired)), 'certificate_expired');
  });

  it('rejects a notification and a transaction for another bundle ID', async () => {
    const verifier = verifierFor(chain);
    await expectFailure(
      verifier.verifyNotification(signJws(sampleSubscribedNotification(chain, { bundleId: 'com.example.other' }), chain)),
      'bundle_id_mismatch'
    );
    await expectFailure(
      verifier.verifyTransaction(signJws({ bundleId: 'com.example.other', environment: 'Production', transactionId: '1' }, chain)),
      'bundle_id_mismatch'
    );
    await expectFailure(verifier.verifyNotification(signJws({ notificationType: 'TEST' }, chain)), 'bundle_id_mismatch');
  });

  it('rejects an environment other than Production or Sandbox', async () => {
    const xcode = signJws(sampleSubscribedNotification(chain, { environment: 'Xcode' }), chain);
    await expectFailure(verifierFor(chain).verifyNotification(xcode), 'environment_unsupported');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'rejects the inherited object key %s as an environment',
    async (environment) => {
      const verifier = verifierFor(chain);
      await expectFailure(
        verifier.verifyNotification(signJws(sampleSubscribedNotification(chain, { environment }), chain)),
        'environment_unsupported'
      );
      await expectFailure(
        verifier.verifyTransaction(signJws({ bundleId: 'com.example', environment, transactionId: '1' }, chain)),
        'environment_unsupported'
      );
    }
  );

  it('rejects any algorithm but ES256 and a chain that is not three certificates', async () => {
    const payload = sampleSubscribedNotification(chain);
    await expectFailure(verifierFor(chain).verifyNotification(signJws(payload, chain, { alg: 'none' })), 'unsupported_algorithm');
    await expectFailure(verifierFor(chain).verifyNotification(signJws(payload, chain, { x5c: chain.x5c.slice(0, 2) })), 'malformed');
    await expectFailure(verifierFor(chain).verifyNotification(signJws(payload, chain, { x5c: undefined })), 'malformed');
  });

  it('rejects malformed JWS and certificates without throwing anything else', async () => {
    const verifier = verifierFor(chain);
    await expectFailure(verifier.verifyNotification('not-a-jws'), 'malformed');
    await expectFailure(verifier.verifyNotification('e30.e30.%%%'), 'malformed');
    const truncated = [chain.x5c[0].slice(0, 40), chain.x5c[1], chain.x5c[2]];
    await expectFailure(verifier.verifyNotification(signJws(sampleSubscribedNotification(chain), chain, { x5c: truncated })), 'malformed');
  });
});
