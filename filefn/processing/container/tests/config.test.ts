import { describe, expect, it } from 'vitest';
import { readContainerConfig } from '../src/config.js';

const base = {
  FILEFN_R2_ACCOUNT_ID: 'acct123',
  FILEFN_R2_BUCKET: 'files-eu',
  FILEFN_R2_ACCESS_KEY_ID: 'key',
  FILEFN_R2_SECRET_ACCESS_KEY: 'secret',
  FILEFN_DATABASE: './db.js',
  FILEFN_CONTAINER_TOKEN: 'test-container-token',
};

describe('readContainerConfig', () => {
  it('reads an R2 account configuration with defaults', () => {
    expect(readContainerConfig(base)).toEqual({
      port: 8080,
      token: 'test-container-token',
      storage: { accountId: 'acct123', bucket: 'files-eu', accessKeyId: 'key', secretAccessKey: 'secret' },
      database: './db.js',
      namespace: undefined,
      processors: ['thumbnail', 'pdf-preview', 'ocr'],
      maxRetries: undefined,
      maxConcurrentJobs: 2,
      maxJobWaitMs: 60_000,
      maxBodyBytes: 262_144,
      ocrLanguage: 'eng',
    });
  });

  it('reads optional settings', () => {
    const config = readContainerConfig({
      ...base,
      FILEFN_R2_ACCOUNT_ID: undefined,
      FILEFN_R2_ENDPOINT: 'http://127.0.0.1:9000',
      FILEFN_R2_REGION: 'us-east-1',
      PORT: '9090',
      FILEFN_CONTAINER_TOKEN: 'shared',
      FILEFN_NAMESPACE: 'nucleum',
      FILEFN_PROCESSORS: ' pdf-preview , thumbnail,thumbnail ',
      FILEFN_PROCESSING_MAX_RETRIES: '5',
      FILEFN_CONTAINER_MAX_CONCURRENT_JOBS: '4',
      FILEFN_CONTAINER_JOB_WAIT_MS: '0',
      FILEFN_OCR_LANGUAGE: 'eng+deu',
    });

    expect(config).toMatchObject({
      port: 9090,
      token: 'shared',
      storage: { accountId: 'endpoint', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1' },
      namespace: 'nucleum',
      processors: ['pdf-preview', 'thumbnail'],
      maxRetries: 5,
      maxConcurrentJobs: 4,
      maxJobWaitMs: 0,
      ocrLanguage: 'eng+deu',
    });
  });

  it.each([
    ['FILEFN_R2_ACCOUNT_ID', { FILEFN_R2_ACCOUNT_ID: ' ' }],
    ['FILEFN_R2_BUCKET', { FILEFN_R2_BUCKET: undefined }],
    ['FILEFN_R2_SECRET_ACCESS_KEY', { FILEFN_R2_SECRET_ACCESS_KEY: '' }],
    ['FILEFN_DATABASE', { FILEFN_DATABASE: undefined }],
    ['PORT', { PORT: '65536' }],
    ['PORT', { PORT: '80a' }],
    ['FILEFN_PROCESSING_MAX_RETRIES', { FILEFN_PROCESSING_MAX_RETRIES: '-1' }],
    ['FILEFN_CONTAINER_MAX_CONCURRENT_JOBS', { FILEFN_CONTAINER_MAX_CONCURRENT_JOBS: '0' }],
    ['FILEFN_CONTAINER_JOB_WAIT_MS', { FILEFN_CONTAINER_JOB_WAIT_MS: '600001' }],
    ['unknown processor "video"', { FILEFN_PROCESSORS: 'thumbnail,video' }],
    ['FILEFN_PROCESSORS must name', { FILEFN_PROCESSORS: ' , ' }],
    ['FILEFN_R2_JURISDICTION', { FILEFN_R2_JURISDICTION: 'us' }],
    ['FILEFN_OCR_LANGUAGE', { FILEFN_OCR_LANGUAGE: '-l eng' }],
  ])('rejects an invalid %s', (key, override) => {
    expect(() => readContainerConfig({ ...base, ...override })).toThrow(
      expect.objectContaining({ message: expect.stringMatching(new RegExp(`^FILEFN_CONTAINER_CONFIG_INVALID: .*${key}`)) }),
    );
  });

  it('refuses to start without a token unless unauthenticated jobs are allowed explicitly (FILE-30 F-17)', () => {
    const { FILEFN_CONTAINER_TOKEN: _token, ...noToken } = base;
    expect(() => readContainerConfig(noToken)).toThrow(/FILEFN_CONTAINER_TOKEN is required/);
    expect(() => readContainerConfig({ ...noToken, FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED: 'false' })).toThrow(/FILEFN_CONTAINER_TOKEN is required/);
    expect(() => readContainerConfig({ ...noToken, FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED: 'yes' })).toThrow(/must be true or false/);
    expect(readContainerConfig({ ...noToken, FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED: 'true' }).token).toBeUndefined();
    // A blank value is refused like any other non-boolean, even with a token.
    expect(() => readContainerConfig({ ...base, FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED: '' })).toThrow(/must be true or false/);
    expect(() => readContainerConfig({ ...base, FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED: '  ' })).toThrow(/must be true or false/);
  });
});
