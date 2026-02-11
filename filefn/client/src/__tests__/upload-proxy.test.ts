import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UploadManager } from '../upload-manager.js';
import { createHttpClient } from '../client.js';

describe('Client Proxy Upload', () => {
  const mockFetch = vi.fn();
  global.fetch = mockFetch;

  const config = { baseUrl: 'http://localhost' };
  const httpClient = createHttpClient(config);
  const manager = new UploadManager(httpClient);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads via proxy when server returns proxy mode', async () => {
    // 1. Init returns proxy mode
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          uploadSessionId: 'sess_1',
          uploadMode: 'proxy',
          chunkSizeBytes: 100,
          totalParts: 1
        }
      })
    });

    // 2. Sign part returns proxy URL
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          url: '/upload/sess_1/parts/1',
          headers: { 'content-type': 'text/plain' }
        }
      })
    });

    // 3. Upload part (PUT to proxy URL) returns JSON success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        ok: true,
        data: { etag: 'etag_1', recorded: true }
      })
    });

    // 4. Complete session
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: { fileId: 'f1', versionId: 'v1' }
      })
    });

    const file = new Blob(['hello'], { type: 'text/plain' });
    const handle = manager.createHandle({
      policy: 'p1',
      file: file as any,
      fileName: 'test.txt'
    }, () => manager.startUpload({
      policy: 'p1',
      file: file as any,
      fileName: 'test.txt'
    }));

    const result = await handle.done();

    expect(result).toEqual({ fileId: 'f1', versionId: 'v1' });

    // Verify calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
    
    // Check PUT call
    const putCall = mockFetch.mock.calls[2];
    expect(putCall[0]).toBe('http://localhost/upload/sess_1/parts/1'); // Resolved against base
    expect(putCall[1].method).toBe('PUT');
  });
});