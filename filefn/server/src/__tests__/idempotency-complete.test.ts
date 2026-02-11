import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUploadSessionRoutes } from '../upload-sessions/routes.js';
import { createUploadSessionService } from '../upload-sessions/service.js';
import { FileFnError } from '../errors.js';

describe('Idempotency & Completion', () => {
  const mockDb = {
    create: vi.fn(),
    findOne: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  };

  const mockStorage = {
    capabilities: { multipart: true, signedUploadUrls: true },
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: 'up_123' }),
    completeMultipartUpload: vi.fn(),
    statObject: vi.fn(),
  };

  const mockPolicies = {
    get: vi.fn().mockReturnValue({ maxSizeBytes: 1000 }),
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

  const routes = createUploadSessionRoutes({ service, auth: { required: false } });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TV-IDEMPOTENCY-NEG-001
  it('rejects init with same idempotency key but different payload', async () => {
    mockDb.findOne.mockResolvedValue({
      uploadSessionId: 'sess_1',
      idempotencyKey: 'key_1',
      idempotencyPayloadHash: 'hash_original',
    });

    const req = new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'x-idempotency-key': 'key_1' },
      body: JSON.stringify({ policy: 'p', fileName: 'diff', size: 1, mimeType: 'text/plain' })
    });

    // We expect service logic to produce a different hash and fail
    // Assuming 'hash_original' is different from current payload hash
    await expect(routes.initSession(req)).resolves.toMatchObject({ status: 409 });
  });

  // TV-UPLOAD-PART-COMPLETE-IDEMP-NEG-001
  it('rejects part completion with different etag', async () => {
    mockDb.findOne.mockResolvedValue({
      uploadSessionId: 'sess_1',
      status: 'in_progress',
      totalParts: 1,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });
    
    // Simulate existing part with different etag
    mockDb.upsert.mockRejectedValue(new Error('Constraint failed or handled logic')); 
    // Actually, service logic should check existing part first or handle upsert conflict
    // But let's see how we implement it. We likely need to findOne part before upsert or handle upsert result.
    
    // For this test, we mock findOne for the part check we will add
    mockDb.findMany.mockResolvedValueOnce([{ partNumber: 1, etag: 'etag_original' }]);

    const req = new Request('http://localhost/upload/sess_1/parts/1/complete', {
      method: 'POST',
      body: JSON.stringify({ etag: 'etag_new', size: 10 })
    });

    await expect(routes.completePart(req, 'sess_1', 1)).resolves.toMatchObject({ status: 409 });
  });

  // TV-UPLOAD-COMPLETE-IDEMP-001
  it('returns stable result on repeated completion', async () => {
    mockDb.findOne.mockResolvedValue({
      uploadSessionId: 'sess_1',
      status: 'completed',
      fileId: 'f1',
      completionVersionId: 'v1'
    });

    const req = new Request('http://localhost/upload/sess_1/complete', { method: 'POST' });
    const res = await routes.completeSession(req, 'sess_1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ fileId: 'f1', versionId: 'v1' });
  });
});