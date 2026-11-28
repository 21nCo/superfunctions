import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFileFnClient, generateFileId, type UploadProgress } from '../index.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function createMockBlob(size: number): Blob {
  const data = new Uint8Array(size).fill(1);
  return new Blob([data], { type: 'application/octet-stream' });
}

describe('createFileFnClient', () => {
  it('should create a client with uploadFile method', () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    expect(client.uploadFile).toBeDefined();
    expect(typeof client.uploadFile).toBe('function');
  });

  it('should create a client with resumeUpload method', () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    expect(client.resumeUpload).toBeDefined();
    expect(typeof client.resumeUpload).toBe('function');
  });

  it('should export generateFileId()', () => {
    const first = generateFileId();
    const second = generateFileId();

    expect(first).toMatch(/^file_/);
    expect(second).toMatch(/^file_/);
    expect(first).not.toBe(second);
  });
});

describe('uploadFile', () => {
  it('should complete full upload flow (TV-CLIENT-UPLOAD-001)', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(100);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_001',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 5 * 1024 * 1024,
        totalParts: 1,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({
        url: 'https://storage.test/upload/part1',
        headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"abc123"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({
        fileId: 'file_00000001',
        versionId: 'ver_0001',
      }));

    const handle = client.uploadFile({
      policy: 'user-avatar',
      file,
      fileName: 'avatar.png',
      fileId: 'file_00000001',
    });

    const result = await handle.done();

    expect(result).toEqual({ fileId: 'file_00000001', versionId: 'ver_0001' });
    expect(mockFetch).toHaveBeenCalledTimes(5);

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/files/upload/init');
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.test/files/upload/session_001/parts/1/sign');
    expect(mockFetch.mock.calls[2][0]).toBe('https://storage.test/upload/part1');
    expect(mockFetch.mock.calls[3][0]).toBe('https://api.test/files/upload/session_001/parts/1/complete');
    expect(mockFetch.mock.calls[4][0]).toBe('https://api.test/files/upload/session_001/complete');
  });

  it('should upload multiple parts for large files', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(15 * 1024 * 1024);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_002',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 5 * 1024 * 1024,
        totalParts: 3,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag1"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part2', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag2"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part3', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag3"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_00000002', versionId: 'ver_0002' }));

    const handle = client.uploadFile({ policy: 'attachments', file, fileId: 'file_00000002' });
    const result = await handle.done();

    expect(result).toEqual({ fileId: 'file_00000002', versionId: 'ver_0002' });
    expect(mockFetch).toHaveBeenCalledTimes(11);
  });

  it('should fire progress callbacks (TV-CLIENT-HOOKS-001)', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(200);
    const progressEvents: UploadProgress[] = [];

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_003',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 100,
        totalParts: 2,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag1"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part2', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag2"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_00000003', versionId: 'ver_0003' }));

    const handle = client.uploadFile({ policy: 'test', file, fileId: 'file_00000003' });
    handle.onProgress((progress) => progressEvents.push({ ...progress }));

    await handle.done();

    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]).toEqual({
      bytesUploaded: 100,
      bytesTotal: 200,
      partsCompleted: 1,
      totalParts: 2,
    });
    expect(progressEvents[1]).toEqual({
      bytesUploaded: 200,
      bytesTotal: 200,
      partsCompleted: 2,
      totalParts: 2,
    });
  });

  it('should abort and stop progress (TV-CLIENT-HOOKS-NEG-001)', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(300);
    const progressEvents: UploadProgress[] = [];
    let rejectUpload!: (reason?: unknown) => void;
    const pendingUpload = new Promise((_, reject) => {
      rejectUpload = reject;
    });
    pendingUpload.catch(() => {});

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_004',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 100,
        totalParts: 3,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag1"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockImplementationOnce(() => pendingUpload);

    const handle = client.uploadFile({ policy: 'test', file, fileId: 'file_abort001' });
    handle.onProgress((progress) => progressEvents.push({ ...progress }));
    const donePromise = handle.done();
    const rejectedUpload = expect(donePromise).rejects.toThrow('Aborted');
    handle.abort();
    rejectUpload(new DOMException('Aborted', 'AbortError'));

    await rejectedUpload;
    expect(progressEvents.length).toBeLessThanOrEqual(1);
  });

  it('should include auth headers when provided', async () => {
    const client = createFileFnClient({
      baseUrl: 'https://api.test/files',
      getAuthHeaders: () => ({ Authorization: 'Bearer token123' }),
    });
    const file = createMockBlob(50);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_005',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 5 * 1024 * 1024,
        totalParts: 1,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_00000005', versionId: 'ver_0005' }));

    await client.uploadFile({ policy: 'test', file, fileId: 'file_00000005' }).done();

    const initCall = mockFetch.mock.calls[0];
    expect(initCall[1].headers.Authorization).toBe('Bearer token123');
  });

  it('exposes upload session metadata as soon as init succeeds', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(50);
    let releaseSign!: () => void;
    const signBlocked = new Promise((resolve) => {
      releaseSign = () => resolve(undefined);
    });

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_early',
        uploadSessionToken: 'upls_early',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 5 * 1024 * 1024,
        totalParts: 1,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockImplementationOnce(async () => {
        await signBlocked;
        return createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' });
      })
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_early001', versionId: 'ver_early' }));

    const handle = client.uploadFile({ policy: 'test', file, fileId: 'file_early001' });
    const donePromise = handle.done();
    await vi.waitFor(() => {
      expect(handle.uploadSessionId).toBe('session_early');
      expect(handle.uploadSessionToken).toBe('upls_early');
      expect(handle.fileId).toBe('file_early001');
    });

    releaseSign();
    await expect(donePromise).resolves.toEqual({ fileId: 'file_early001', versionId: 'ver_early' });
  });
});

describe('resumeUpload', () => {
  it('should resume upload from status and skip completed parts', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(300);
    const progressEvents: UploadProgress[] = [];

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        fileId: 'file_resume001',
        status: 'in_progress',
        recordedParts: [1, 2],
        totalParts: 3,
        chunkSizeBytes: 100,
        fileSize: 300,
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part3', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag3"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_resume001', versionId: 'ver_resume' }));

    const handle = client.resumeUpload('session_resume', file, {
      uploadSessionToken: 'upls_resume',
    });
    handle.onProgress((progress) => progressEvents.push({ ...progress }));

    expect(handle.uploadSessionId).toBe('session_resume');
    expect(handle.uploadSessionToken).toBe('upls_resume');
    expect(handle.fileId).toBeUndefined();

    const result = await handle.done();

    expect(result).toEqual({ fileId: 'file_resume001', versionId: 'ver_resume' });
    expect(handle.fileId).toBe('file_resume001');
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/files/upload/session_resume/status');
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.test/files/upload/session_resume/parts/3/sign');

    expect(progressEvents[0]).toEqual({
      bytesUploaded: 200,
      bytesTotal: 300,
      partsCompleted: 2,
      totalParts: 3,
    });
    expect(progressEvents[progressEvents.length - 1]).toEqual({
      bytesUploaded: 300,
      bytesTotal: 300,
      partsCompleted: 3,
      totalParts: 3,
    });
  });

  it('should preserve a caller-supplied fileId while resuming', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(100);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        status: 'in_progress',
        recordedParts: [],
        totalParts: 1,
        chunkSizeBytes: 100,
        fileSize: 100,
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag1"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_known001', versionId: 'ver_known' }));

    const handle = client.resumeUpload('session_known', file, { fileId: 'file_known001' });
    expect(handle.fileId).toBe('file_known001');

    const result = await handle.done();
    expect(result.fileId).toBe('file_known001');
    expect(handle.fileId).toBe('file_known001');
  });
});

describe('retry behavior', () => {
  it('should retry on 500 errors', async () => {
    const client = createFileFnClient({
      baseUrl: 'https://api.test/files',
      retryOptions: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 },
    });
    const file = createMockBlob(50);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({ error: 'Server Error' }, 500))
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_retry',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 5 * 1024 * 1024,
        totalParts: 1,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/part1', headers: {}, expiresAt: '2025-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_retry001', versionId: 'ver_retry' }));

    const result = await client.uploadFile({ policy: 'test', file, fileId: 'file_retry001' }).done();

    expect(result).toEqual({ fileId: 'file_retry001', versionId: 'ver_retry' });
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it('TV-CLIENT-001 negative: should reject when the server completes with a different fileId', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(100);

    mockFetch
      .mockResolvedValueOnce(createMockResponse({
        uploadSessionId: 'session_mismatch',
        uploadMode: 'multipart-signed-url',
        chunkSizeBytes: 100,
        totalParts: 1,
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({
        url: 'https://storage.test/upload/part1',
        headers: {},
        expiresAt: '2025-01-01T00:00:00Z',
      }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag1"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_other001', versionId: 'ver_other' }));

    const handle = client.uploadFile({
      policy: 'test',
      file,
      fileId: 'file_expected',
    });

    await expect(handle.done()).rejects.toMatchObject({
      code: 'FILEFN_CLIENT_FILE_ID_MISMATCH',
      details: {
        expectedFileId: 'file_expected',
        actualFileId: 'file_other001',
      },
    });
  });

  it('should not retry on 4xx client errors', async () => {
    const client = createFileFnClient({
      baseUrl: 'https://api.test/files',
      retryOptions: { maxRetries: 2, baseDelayMs: 10 },
    });
    const file = createMockBlob(50);

    mockFetch.mockResolvedValue(createMockResponse({ error: 'Bad Request' }, 400));

    await expect(client.uploadFile({ policy: 'test', file }).done()).rejects.toThrow('HTTP 400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should exhaust retries and throw', async () => {
    const client = createFileFnClient({
      baseUrl: 'https://api.test/files',
      retryOptions: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 20 },
    });
    const file = createMockBlob(50);

    mockFetch.mockResolvedValue(createMockResponse({ error: 'Server Error' }, 500));

    await expect(client.uploadFile({ policy: 'test', file }).done()).rejects.toThrow('HTTP 500');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('error handling', () => {
  it('should propagate policy errors', async () => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    const file = createMockBlob(50);

    mockFetch.mockResolvedValue(createMockResponse({
      error: 'POLICY_NOT_FOUND',
      message: 'Policy "invalid" not found',
    }, 404));

    await expect(client.uploadFile({ policy: 'invalid', file }).done()).rejects.toThrow('HTTP 404');
  });
});

describe('replayed session end', () => {
  it.each([
    ['a numeric session ID', 42],
    ['a session ID that is a dot segment', '..'],
  ])('keeps an expired answer with %s ambiguous instead of confirming the end', async (_label, uploadSessionId) => {
    const { UPLOAD_SESSION_ENDED_ERROR } = await import('../upload-manager.js');
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true, data: { uploadSessionId, status: 'expired', totalParts: 1, chunkSizeBytes: 100 } }));
    const error = await client.uploadFile({ policy: 'p', file: createMockBlob(10), fileId: generateFileId() }).done().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).not.toBe(UPLOAD_SESSION_ENDED_ERROR);
  });

  it('confirms the end of a well-formed expired session', async () => {
    const { UPLOAD_SESSION_ENDED_ERROR } = await import('../upload-manager.js');
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true, data: { uploadSessionId: 'ups_1', status: 'expired', totalParts: 1, chunkSizeBytes: 100 } }));
    const error = await client.uploadFile({ policy: 'p', file: createMockBlob(10), fileId: generateFileId() }).done().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(UPLOAD_SESSION_ENDED_ERROR);
  });
});

describe('round 15: the online upload accepts what the server sends', () => {
  it.each([
    ['a legacy { data } envelope without ok', 'session_003', (data: Record<string, unknown>) => ({ data })],
    ['a server-generated session ID with ":" and "."', 'sess:2026.a', (data: Record<string, unknown>) => ({ ok: true, data })],
    // URL parsing leaves these unchanged, so they reached the router as they are before 0.5 too.
    ['a server-generated session ID with a literal "%"', 'sess%41x', (data: Record<string, unknown>) => ({ ok: true, data })],
    ['a server-generated session ID with "|^[]"', 'v|1^[2]', (data: Record<string, unknown>) => ({ ok: true, data })],
  ])('completes an upload whose init answers with %s', async (_label, uploadSessionId, wrap) => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    mockFetch
      .mockResolvedValueOnce(createMockResponse(wrap({ uploadSessionId, chunkSizeBytes: 100, totalParts: 1 })))
      .mockResolvedValueOnce(createMockResponse({ url: 'https://storage.test/upload/part1' }))
      .mockResolvedValueOnce(createMockResponse({}, 200, { ETag: '"etag-1"' }))
      .mockResolvedValueOnce(createMockResponse({ recorded: true }))
      .mockResolvedValueOnce(createMockResponse({ fileId: 'file_00000003', versionId: 'ver.2026:1' }));
    const result = await client.uploadFile({ policy: 'p', file: createMockBlob(10), fileId: 'file_00000003' }).done();
    expect(result).toEqual({ fileId: 'file_00000003', versionId: 'ver.2026:1' });
    // The server router matches the raw segment and never decodes it.
    expect(mockFetch.mock.calls[1][0]).toBe(`https://api.test/files/upload/${uploadSessionId}/parts/1/sign`);
    expect(mockFetch.mock.calls[4][0]).toBe(`https://api.test/files/upload/${uploadSessionId}/complete`);
  });

  it.each([
    ['a path separator', 'sess/1'],
    ['an escaped dot segment', '%2e'],
    ['an escaped double-dot segment', '.%2E'],
    ['a backslash', 'sess\\1'],
    ['a query delimiter', 'sess?1'],
    ['whitespace', 'sess 1'],
    ['a non-ASCII character', 'sess\u00e91'],
  ])('refuses a session ID with %s, which cannot reach the server as one raw segment', async (_label, uploadSessionId) => {
    const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
    mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true, data: { uploadSessionId, chunkSizeBytes: 100, totalParts: 1 } }));
    const error = await client.uploadFile({ policy: 'p', file: createMockBlob(10), fileId: generateFileId() }).done().catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('FILEFN_UPLOAD_RESULT_INVALID');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
