// Test keys are generated per run: no key material is committed (see AGENTS.md, test fixtures and secret scanning).
import { createWebCryptoSigner, type Es256PrivateJwk, type Es256Signer } from '../index.js';

/** A generated private JWK; the members WebCrypto always exports for a P-256 key are typed as present. */
export type TestPrivateJwk = Es256PrivateJwk & { x: string; y: string; d: string };

export interface GeneratedKey {
  privateJwk: TestPrivateJwk;
  pkcs8: Uint8Array;
  signer: Es256Signer;
}

export async function generateKey(kid?: string): Promise<GeneratedKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as TestPrivateJwk;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const signer = await createWebCryptoSigner(kid === undefined ? { privateJwk } : { privateJwk, kid });
  return { privateJwk, pkcs8, signer };
}

export function toPem(der: Uint8Array): string {
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/(.{64})/g, '$1\n');
  return ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') + `\n${body}\n` + ['-----END', 'PRIVATE KEY-----'].join(' ');
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Replaces one part (0 header, 1 payload, 2 signature) of a compact JWS. */
export function replacePart(jws: string, index: 0 | 1 | 2, part: string): string {
  const parts = jws.split('.');
  parts[index] = part;
  return parts.join('.');
}

/** Every string a value exposes through its message, stack, own properties or JSON form. */
export function exposedText(value: unknown): string {
  if (value instanceof Error) {
    return [value.message, value.stack ?? '', JSON.stringify(value), String((value as { cause?: unknown }).cause ?? '')].join('\n');
  }
  return JSON.stringify(value) ?? String(value);
}

type ResizableArrayBuffer = ArrayBuffer & { resize(byteLength: number): void };
const ResizableArrayBufferConstructor = ArrayBuffer as unknown as new (byteLength: number, options: { maxByteLength: number }) => ResizableArrayBuffer;

/**
 * Buffers whose bytes can no longer be read: an ArrayBuffer and views over it (whole, offset, wider element, DataView)
 * detached by a transfer, then a Uint8Array and a DataView left out of bounds by shrinking their resizable buffer.
 */
export function unusableBuffers(): Array<ArrayBuffer | ArrayBufferView> {
  const detach = <T>(create: (buffer: ArrayBuffer) => T): T => {
    const buffer = new ArrayBuffer(8);
    const value = create(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    return value;
  };
  const shrink = <T>(create: (buffer: ArrayBuffer) => T): T => {
    const buffer = new ResizableArrayBufferConstructor(8, { maxByteLength: 16 });
    const value = create(buffer);
    buffer.resize(2);
    return value;
  };
  return [
    detach((buffer) => buffer),
    detach((buffer) => new Uint8Array(buffer)),
    detach((buffer) => new Uint8Array(buffer, 2, 4)),
    detach((buffer) => new Uint16Array(buffer)),
    detach((buffer) => new DataView(buffer, 1, 4)),
    shrink((buffer) => new Uint8Array(buffer, 4, 4)),
    shrink((buffer) => new DataView(buffer, 4, 4)),
  ];
}

/** Empty views that are still in bounds, which sign as an empty payload. */
export function emptyViews(): ArrayBufferView[] {
  const shrunk = new ResizableArrayBufferConstructor(8, { maxByteLength: 16 });
  const tracking = new Uint8Array(shrunk);
  shrunk.resize(0);
  return [new Uint8Array(0), new Uint8Array(new ArrayBuffer(8), 8, 0), new DataView(new ArrayBuffer(4), 4), tracking];
}
