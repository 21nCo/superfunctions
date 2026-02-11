import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUploadSessionRoutes } from '../upload-sessions/routes.js';
import { createUploadSessionService } from '../upload-sessions/service.js';
import { FileFnError } from '../errors.js';

describe('Proxy Upload', () => {
  const mockDb = {
    create: vi.fn(),
    findOne: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };

  const mockStorage = {
    capabilities: {
      signedUploadUrls: false,
      proxyStreamingUpload: true,
      multipart: true,
    },
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: 'up_123' }),
    uploadObject: vi.fn(),
    openUploadStream: vi.fn(),
    openDownloadStream: vi.fn(),
    deleteObject: vi.fn(),
  };

  const mockPolicies = {
    get: vi.fn().mockReturnValue({ maxSizeBytes: 1000, contentTypes: ['text/plain'] }),
  };

  const mockEvents = {
    emit: vi.fn(),
  };

  const service = createUploadSessionService({
    db: mockDb as any,
    storage: mockStorage as any,
    policies: mockPolicies as any,
    events: mockEvents as any,
  });

  const routes = createUploadSessionRoutes({
    service,
    auth: { required: false },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initSession selects proxy mode when signed URLs are unsupported', async () => {
    mockDb.findOne.mockResolvedValue(null);
    mockDb.create.mockResolvedValue({});

    const req = new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        policy: 'p1',
        fileName: 'test.txt',
        size: 10,
        mimeType: 'text/plain'
      }),
    });

    const res = await routes.initSession(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.uploadMode).toBe('proxy');
  });

  it('signPart returns proxy URL for proxy mode', async () => {
    mockDb.findOne.mockResolvedValue({
      uploadSessionId: 'sess_1',
      status: 'pending',
      uploadMode: 'proxy',
      totalParts: 1,
      storageKey: 'key',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });

    const req = new Request('http://localhost/upload/sess_1/parts/1/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentLength: 5 }),
    });

    const res = await routes.signPart(req, 'sess_1', 1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.url).toContain('/upload/sess_1/parts/1'); // Internal proxy URL
    // Should NOT include query params for signature
  });
});