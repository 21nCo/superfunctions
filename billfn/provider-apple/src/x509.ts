/**
 * The X.509 subset the App Store chain needs, read from DER with no Node APIs: names, validity, the EC public key,
 * the signature and the extensions. Malformed or non-minimal DER, and any key or signature that is not ECDSA, is rejected.
 */
import { bytesEqual, toArrayBuffer } from './encoding.js';

interface DerNode {
  tag: number;
  /** The whole element: tag, length and content. */
  raw: Uint8Array;
  content: Uint8Array;
}

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_SEQUENCE = 0x30;
const TAG_VERSION = 0xa0;
const TAG_EXTENSIONS = 0xa3;

const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const NAMED_CURVES: Record<string, { name: 'P-256' | 'P-384' | 'P-521'; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 }
};
const ECDSA_SIGNATURE_HASHES: Record<string, 'SHA-256' | 'SHA-384' | 'SHA-512'> = {
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512'
};

export class X509ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X509ParseError';
  }
}

export interface X509Certificate {
  raw: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** The DER SubjectPublicKeyInfo, which WebCrypto imports as `spki`. */
  publicKeyInfo: Uint8Array;
  namedCurve: 'P-256' | 'P-384' | 'P-521';
  isCertificateAuthority: boolean;
  extensionOids: Set<string>;
  tbs: Uint8Array;
  signatureHash: 'SHA-256' | 'SHA-384' | 'SHA-512';
  /** The DER ECDSA-Sig-Value the issuer signed the TBS bytes with. */
  signature: Uint8Array;
}

function readNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) {
    throw new X509ParseError('DER element is truncated');
  }
  const tag = bytes[offset];
  if ((tag & 0x1f) === 0x1f) {
    throw new X509ParseError('DER high-tag-number form is not supported');
  }
  let length = bytes[offset + 1];
  let headerLength = 2;
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || offset + 2 + lengthBytes > bytes.length) {
      throw new X509ParseError('DER length is invalid');
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[offset + 2 + index];
    }
    if (length < 0x80 || (lengthBytes > 1 && bytes[offset + 2] === 0)) {
      throw new X509ParseError('DER length is not minimally encoded');
    }
    headerLength += lengthBytes;
  }
  const end = offset + headerLength + length;
  if (end > bytes.length) {
    throw new X509ParseError('DER element is truncated');
  }
  return {
    tag,
    raw: bytes.subarray(offset, end),
    content: bytes.subarray(offset + headerLength, end)
  };
}

function readSingle(bytes: Uint8Array, tag: number): DerNode {
  const node = readNode(bytes, 0);
  if (node.tag !== tag || node.raw.length !== bytes.length) {
    throw new X509ParseError(`Expected a single DER element with tag ${tag}`);
  }
  return node;
}

function readChildren(node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const child = readNode(node.content, offset);
    children.push(child);
    offset += child.raw.length;
  }
  return children;
}

function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (!node || node.tag !== tag) {
    throw new X509ParseError(`Certificate ${what} is missing or malformed`);
  }
  return node;
}

function readOid(node: DerNode): string {
  const bytes = expectTag(node, TAG_OID, 'object identifier').content;
  if (bytes.length === 0 || (bytes[bytes.length - 1] & 0x80) !== 0) {
    throw new X509ParseError('Object identifier is malformed');
  }
  const arcs: number[] = [];
  let value = 0;
  for (const byte of bytes) {
    if (value === 0 && byte === 0x80) {
      throw new X509ParseError('Object identifier is not minimally encoded');
    }
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) {
      throw new X509ParseError('Object identifier arc is too large');
    }
    if ((byte & 0x80) === 0) {
      if (arcs.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        arcs.push(first, value - first * 40);
      } else {
        arcs.push(value);
      }
      value = 0;
    }
  }
  return arcs.join('.');
}

function readTime(node: DerNode | undefined): Date {
  if (!node || (node.tag !== TAG_UTC_TIME && node.tag !== TAG_GENERALIZED_TIME)) {
    throw new X509ParseError('Certificate validity time is malformed');
  }
  const text = new TextDecoder().decode(node.content);
  const match = node.tag === TAG_UTC_TIME
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!match) {
    throw new X509ParseError('Certificate validity time is malformed');
  }
  let year = Number(match[1]);
  if (node.tag === TAG_UTC_TIME) {
    // RFC 5280 4.1.2.5.1: two-digit years 50-99 are 19xx and 00-49 are 20xx.
    year += year >= 50 ? 1900 : 2000;
  }
  const [month, day, hour, minute, second] = match.slice(2).map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(time);
  if (Number.isNaN(time) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new X509ParseError('Certificate validity time is not a real date');
  }
  return date;
}

function readAlgorithm(node: DerNode | undefined, what: string): { oid: string; parameters?: DerNode } {
  const children = readChildren(expectTag(node, TAG_SEQUENCE, what));
  if (children.length === 0 || children.length > 2) {
    throw new X509ParseError(`Certificate ${what} is malformed`);
  }
  return { oid: readOid(children[0]), parameters: children[1] };
}

function readExtensions(node: DerNode | undefined) {
  const extensionOids = new Set<string>();
  let isCertificateAuthority = false;
  if (!node) {
    return { extensionOids, isCertificateAuthority };
  }
  const [list, ...rest] = readChildren(node);
  if (rest.length > 0) {
    throw new X509ParseError('Certificate extensions are malformed');
  }
  for (const extension of readChildren(expectTag(list, TAG_SEQUENCE, 'extensions'))) {
    const fields = readChildren(expectTag(extension, TAG_SEQUENCE, 'extension'));
    const oid = readOid(fields[0]);
    const hasCritical = fields[1]?.tag === TAG_BOOLEAN;
    const value = expectTag(fields[hasCritical ? 2 : 1], TAG_OCTET_STRING, 'extension value');
    if (fields.length !== (hasCritical ? 3 : 2) || extensionOids.has(oid)) {
      throw new X509ParseError('Certificate extension is malformed or repeated');
    }
    extensionOids.add(oid);
    if (oid === OID_BASIC_CONSTRAINTS) {
      const constraints = readChildren(readSingle(value.content, TAG_SEQUENCE));
      isCertificateAuthority = constraints[0]?.tag === TAG_BOOLEAN && constraints[0].content[0] === 0xff;
    }
  }
  return { extensionOids, isCertificateAuthority };
}

export function parseCertificate(der: Uint8Array): X509Certificate {
  const certificate = readSingle(der, TAG_SEQUENCE);
  const [tbsNode, outerAlgorithmNode, signatureNode, ...extra] = readChildren(certificate);
  if (extra.length > 0) {
    throw new X509ParseError('Certificate has trailing elements');
  }
  const tbs = readChildren(expectTag(tbsNode, TAG_SEQUENCE, 'body'));
  let index = 0;
  if (tbs[index]?.tag === TAG_VERSION) {
    index += 1;
  }
  expectTag(tbs[index++], TAG_INTEGER, 'serial number');
  const innerAlgorithm = readAlgorithm(tbs[index++], 'signature algorithm');
  const issuer = expectTag(tbs[index++], TAG_SEQUENCE, 'issuer');
  const validity = readChildren(expectTag(tbs[index++], TAG_SEQUENCE, 'validity'));
  const subject = expectTag(tbs[index++], TAG_SEQUENCE, 'subject');
  const publicKeyInfo = expectTag(tbs[index++], TAG_SEQUENCE, 'public key');
  // Only the optional unique identifiers ([1], [2]) and the extensions ([3]) may follow, in that order.
  const optional = tbs.slice(index);
  if (optional.some((node, position) => ![0x81, 0x82, TAG_EXTENSIONS].includes(node.tag) || (position > 0 && node.tag <= optional[position - 1].tag))) {
    throw new X509ParseError('Certificate body has unexpected trailing fields');
  }
  const extensions = optional.find((node) => node.tag === TAG_EXTENSIONS);

  const outerAlgorithm = readAlgorithm(outerAlgorithmNode, 'signature algorithm');
  const signatureHash = ECDSA_SIGNATURE_HASHES[outerAlgorithm.oid];
  if (!signatureHash || outerAlgorithm.oid !== innerAlgorithm.oid || outerAlgorithm.parameters || innerAlgorithm.parameters) {
    throw new X509ParseError('Certificate is not signed with ECDSA, or its two signature algorithms differ');
  }
  const [keyAlgorithmNode] = readChildren(publicKeyInfo);
  const keyAlgorithm = readAlgorithm(keyAlgorithmNode, 'public key algorithm');
  const curve = keyAlgorithm.parameters?.tag === TAG_OID ? NAMED_CURVES[readOid(keyAlgorithm.parameters)] : undefined;
  if (keyAlgorithm.oid !== OID_EC_PUBLIC_KEY || !curve) {
    throw new X509ParseError('Certificate public key is not a supported EC key');
  }
  const signatureBits = expectTag(signatureNode, TAG_BIT_STRING, 'signature').content;
  if (signatureBits[0] !== 0 || validity.length !== 2) {
    throw new X509ParseError('Certificate signature or validity is malformed');
  }

  return {
    raw: certificate.raw,
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: readTime(validity[0]),
    notAfter: readTime(validity[1]),
    publicKeyInfo: publicKeyInfo.raw,
    namedCurve: curve.name,
    ...readExtensions(extensions),
    tbs: tbsNode.raw,
    signatureHash,
    signature: signatureBits.subarray(1)
  };
}

/** Converts a DER ECDSA-Sig-Value to the fixed-width r||s form WebCrypto verifies. */
export function ecdsaDerToRaw(der: Uint8Array, namedCurve: X509Certificate['namedCurve']): Uint8Array {
  const size = Object.values(NAMED_CURVES).find((curve) => curve.name === namedCurve)!.size;
  const parts = readChildren(readSingle(der, TAG_SEQUENCE));
  if (parts.length !== 2) {
    throw new X509ParseError('ECDSA signature is malformed');
  }
  const raw = new Uint8Array(size * 2);
  parts.forEach((part, position) => {
    let integer = expectTag(part, TAG_INTEGER, 'signature integer').content;
    // r and s are positive: a set high bit on the first byte is a negative DER INTEGER.
    const negative = integer.length === 0 || (integer[0] & 0x80) !== 0;
    while (integer.length > 1 && integer[0] === 0) {
      integer = integer.subarray(1);
    }
    if (negative || integer.length > size) {
      throw new X509ParseError('ECDSA signature integer is out of range');
    }
    raw.set(integer, position * size + size - integer.length);
  });
  return raw;
}

export function importCertificateKey(certificate: X509Certificate): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    toArrayBuffer(certificate.publicKeyInfo),
    { name: 'ECDSA', namedCurve: certificate.namedCurve },
    false,
    ['verify']
  );
}

/** Whether `issuer` signed `certificate`: the names chain and the issuer's key verifies the signature. */
export async function isIssuedBy(certificate: X509Certificate, issuer: X509Certificate): Promise<boolean> {
  if (!bytesEqual(certificate.issuer, issuer.subject)) {
    return false;
  }
  let signature: Uint8Array;
  try {
    signature = ecdsaDerToRaw(certificate.signature, issuer.namedCurve);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: certificate.signatureHash },
    await importCertificateKey(issuer),
    toArrayBuffer(signature),
    toArrayBuffer(certificate.tbs)
  );
}

