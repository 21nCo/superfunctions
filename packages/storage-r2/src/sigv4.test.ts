import { describe, expect, it } from 'vitest';
import { compareOrdinal, encodeS3Key, presignUrl, sha256Hex, signRequest, toAmzDate } from './sigv4.js';

/**
 * Published AWS vectors:
 * - S3 "Signature Calculations for the Authorization Header" and "Query String
 *   Authentication" examples (sig-v4-header-based-auth / sigv4-query-string-auth):
 *   examplebucket, AKIAIOSFODNN7EXAMPLE, 2013-05-24T00:00:00Z, us-east-1.
 */
const S3_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const S3_SCOPE = { region: 'us-east-1', service: 's3' };
const S3_NOW = new Date('2013-05-24T00:00:00Z');
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function signatureOf(authorization: string | undefined): string | undefined {
  return authorization?.match(/Signature=([0-9a-f]{64})$/)?.[1];
}

describe('SigV4 signer against published AWS vectors', () => {
  it('S3 example: GET Object with a Range header', async () => {
    const headers = await signRequest(
      S3_CREDENTIALS,
      S3_SCOPE,
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' } },
      S3_NOW
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA);
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('S3 example: PUT Object with a signed payload and an encoded key', async () => {
    const body = 'Welcome to Amazon S3.';
    const payloadHash = await sha256Hex(body);
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const headers = await signRequest(
      S3_CREDENTIALS,
      S3_SCOPE,
      {
        method: 'PUT',
        url: `https://examplebucket.s3.amazonaws.com/${encodeS3Key('test$file.text')}`,
        headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
        payloadHash,
      },
      S3_NOW
    );
    expect(headers.authorization).toContain(
      'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class'
    );
    expect(signatureOf(headers.authorization)).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'
    );
  });

  it('S3 example: GET Bucket lifecycle (empty-valued subresource)', async () => {
    const headers = await signRequest(
      S3_CREDENTIALS,
      S3_SCOPE,
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle' },
      S3_NOW
    );
    expect(signatureOf(headers.authorization)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'
    );
  });

  it('S3 example: GET Bucket with sorted query parameters', async () => {
    const headers = await signRequest(
      S3_CREDENTIALS,
      S3_SCOPE,
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J' },
      S3_NOW
    );
    expect(signatureOf(headers.authorization)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'
    );
  });

  it('S3 example: presigned GET URL', async () => {
    const url = await presignUrl(
      S3_CREDENTIALS,
      S3_SCOPE,
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', expiresInSeconds: 86400 },
      S3_NOW
    );
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });
});

describe('SigV4 helpers', () => {
  it('encodes keys segment by segment with RFC 3986 rules', () => {
    expect(encodeS3Key("a b/c+d/e!'()*/ü~._-")).toBe('a%20b/c%2Bd/e%21%27%28%29%2A/%C3%BC~._-');
  });

  it('formats SigV4 timestamps', () => {
    expect(toAmzDate(new Date('2015-08-30T12:36:00.123Z'))).toBe('20150830T123600Z');
  });

  it('presigns extra headers and keeps query values RFC 3986 encoded', async () => {
    const url = new URL(
      await presignUrl(
        S3_CREDENTIALS,
        S3_SCOPE,
        {
          method: 'GET',
          url: 'https://examplebucket.s3.amazonaws.com/test.txt?response-content-type=text%2Fplain%3B%20charset%3Dutf-8',
          headers: { 'Content-Type': 'text/plain' },
          expiresInSeconds: 60,
        },
        S3_NOW
      )
    );
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.search).toContain('response-content-type=text%2Fplain%3B%20charset%3Dutf-8');
    expect(url.search).not.toContain('+');
  });

  it('orders canonical names by code unit, not by locale', async () => {
    expect(['uploadId', 'X-Amz-Date', 'partNumber', 'X-Amz-Algorithm'].sort(compareOrdinal)).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Date',
      'partNumber',
      'uploadId',
    ]);
    // A presigned multipart part URL carries the query exactly as signed: the
    // uppercase X-Amz-* parameters sort before partNumber and uploadId.
    const url = await presignUrl(
      S3_CREDENTIALS,
      S3_SCOPE,
      {
        method: 'PUT',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt?uploadId=abc&partNumber=2',
        headers: { 'X-Amz-Meta-Tag': 'a', 'Content-Length': '5' },
        expiresInSeconds: 60,
      },
      S3_NOW
    );
    const names = [...new URL(url).searchParams.keys()];
    expect(names.slice(0, -1)).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'partNumber',
      'uploadId',
    ]);
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-meta-tag');
  });
});
