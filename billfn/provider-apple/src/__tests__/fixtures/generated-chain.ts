/**
 * Generates App Store-shaped certificate chains and signs JWS with them, with node:crypto and a small DER writer that
 * is independent of the verifier's reader. A chain mirrors Apple's: a P-384 root and intermediate signing with SHA-384,
 * and a P-256 leaf that signs the ES256 JWS.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
const DAY = 24 * 60 * 60 * 1000;

function length(size: number): number[] {
  if (size < 0x80) {
    return [size];
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest & 0xff);
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const content = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag, ...length(content.length)]), content]);
}

const sequence = (...contents: Buffer[]) => tlv(0x30, ...contents);

function oid(value: string): Buffer {
  const [first, second, ...rest] = value.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let remaining = Math.floor(arc / 128); remaining > 0; remaining = Math.floor(remaining / 128)) {
      groups.unshift((remaining & 0x7f) | 0x80);
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const year = date.getUTCFullYear();
  return year >= 1950 && year < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const name = (commonName: string) =>
  sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));

function extension(id: string, value: Buffer, critical = false): Buffer {
  return sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

export interface GeneratedCertificate {
  der: Buffer;
  base64: string;
  commonName: string;
  privateKey: KeyObject;
}

export interface CertificateSpec {
  commonName: string;
  curve: 'P-256' | 'P-384';
  issuer?: GeneratedCertificate;
  /** Signs with this issuer key instead of the issuer certificate's own, keeping its name. */
  signingKey?: KeyObject;
  ca?: boolean;
  oids?: string[];
  notBefore?: Date;
  notAfter?: Date;
}

export function generateCertificate(spec: CertificateSpec): GeneratedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: spec.curve });
  const signingKey = spec.signingKey ?? spec.issuer?.privateKey ?? privateKey;
  const hash = (signingKey.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? 'sha256' : 'sha384') as 'sha256' | 'sha384';
  const algorithm = sequence(oid(hash === 'sha256' ? '1.2.840.10045.4.3.2' : '1.2.840.10045.4.3.3'));
  const extensions = [
    extension('2.5.29.19', spec.ca ? sequence(tlv(0x01, Buffer.from([0xff]))) : sequence(), true),
    ...(spec.oids ?? []).map((id) => extension(id, tlv(0x05, Buffer.alloc(0))))
  ];
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([0x01, ...Array.from(createHash('sha256').update(spec.commonName).digest().subarray(0, 8))])),
    algorithm,
    name(spec.issuer?.commonName ?? spec.commonName),
    sequence(time(spec.notBefore ?? new Date(Date.now() - DAY)), time(spec.notAfter ?? new Date(Date.now() + 365 * DAY))),
    name(spec.commonName),
    publicKey.export({ format: 'der', type: 'spki' }),
    tlv(0xa3, sequence(...extensions))
  );
  const signature = sign(hash, tbs, { key: signingKey, dsaEncoding: 'der' });
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
  return { der, base64: der.toString('base64'), commonName: spec.commonName, privateKey };
}

export interface GeneratedChain {
  root: GeneratedCertificate;
  intermediate: GeneratedCertificate;
  leaf: GeneratedCertificate;
  x5c: string[];
}

/** An App Store-shaped chain; each override replaces one certificate's spec fields. */
export function generateAppleChain(overrides: {
  root?: Partial<CertificateSpec>;
  intermediate?: Partial<CertificateSpec>;
  leaf?: Partial<CertificateSpec>;
  trustedRoot?: GeneratedCertificate;
} = {}): GeneratedChain {
  const root = overrides.trustedRoot ?? generateCertificate({ commonName: 'Generated Root CA - G3', curve: 'P-384', ca: true, ...overrides.root });
  const intermediate = generateCertificate({
    commonName: 'Generated WWDR CA - G6',
    curve: 'P-384',
    issuer: root,
    ca: true,
    oids: [APPLE_INTERMEDIATE_OID],
    ...overrides.intermediate
  });
  const leaf = generateCertificate({
    commonName: 'Generated App Store Receipt Signing',
    curve: 'P-256',
    issuer: intermediate,
    oids: [APPLE_LEAF_OID],
    ...overrides.leaf
  });
  return { root, intermediate, leaf, x5c: [leaf.base64, intermediate.base64, root.base64] };
}

/** Signs a payload as an ES256 compact JWS carrying the chain in x5c. */
export function signJws(
  payload: Record<string, unknown>,
  chain: Pick<GeneratedChain, 'x5c' | 'leaf'>,
  header: Record<string, unknown> = {}
): string {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: chain.x5c, ...header })).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: chain.leaf.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function sha256Hex(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex');
}

/** A SUBSCRIBED/INITIAL_BUY notification shaped like Apple's published sample (signedNotification.json). */
export function sampleSubscribedNotification(
  chain: Pick<GeneratedChain, 'x5c' | 'leaf'>,
  overrides: { bundleId?: string; environment?: string } = {}
): Record<string, unknown> {
  const bundleId = overrides.bundleId ?? 'com.example';
  const environment = overrides.environment ?? 'Production';
  return {
    notificationType: 'SUBSCRIBED',
    subtype: 'INITIAL_BUY',
    notificationUUID: '002e14d5-51f5-4503-b5a8-c3a1af68eb20',
    data: {
      environment,
      appAppleId: 41234,
      bundleId,
      bundleVersion: '1.2.3',
      signedTransactionInfo: signJws(
        {
          transactionId: '23456',
          originalTransactionId: '12345',
          bundleId,
          productId: 'com.example.product',
          purchaseDate: 1698148800000,
          expiresDate: 1700827200000,
          type: 'Auto-Renewable Subscription',
          environment
        },
        chain
      ),
      signedRenewalInfo: signJws({ autoRenewStatus: 1, originalTransactionId: '12345', environment }, chain),
      status: 1
    },
    version: '2.0',
    signedDate: 1698148900000
  };
}
