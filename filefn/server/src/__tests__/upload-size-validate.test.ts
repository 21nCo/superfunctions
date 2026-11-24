import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUploadSessionRoutes } from '../upload-sessions/routes.js';
import { createUploadSessionService } from '../upload-sessions/service.js';

describe('Completion Size Validation', () => {
  // One upload session row; conditional writes to it apply.
  let row: Record<string, unknown> = {};
  const mockDb = {
    findOne: vi.fn(async ({ model }: { model: string }) => (model === 'uploadSessions' ? { ...row } : null)),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return 1; }),
    deleteMany: vi.fn(async () => 0),
    upsert: vi.fn(),
  };

  const mockStorage = {
    capabilities: { multipart: true },
    completeMultipartUpload: vi.fn(),
    statObject: vi.fn(), // We will use this
    deleteObject: vi.fn(async () => {}),
  };

  const service = createUploadSessionService({
    db: mockDb as any,
    storage: mockStorage as any,
    policies: { get: () => ({}) } as any,
    events: { emit: vi.fn() } as any,
  });

  const routes = createUploadSessionRoutes({ service, auth: { resolveSession: async () => ({ principalId: 'user_1' }) } });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // TV-UPLOAD-COMPLETE-VALIDATE-SIZE-NEG-001
  it('fails completion if storage size does not match session size', async () => {
    row = {
      uploadSessionId: 'sess_1',
      status: 'in_progress',
      uploadMode: 'multipart-signed-url',
      totalParts: 1,
      size: 100, // Expected
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      storageKey: 'key',
      storageUploadId: 'uid',
      ownerId: 'user_1',
      tenantId: null,
      completionVersionId: 'ver_1',
    };
    
    mockDb.findMany.mockResolvedValue([{ partNumber: 1, etag: 'e1' }]);

    // Storage reports different size
    mockStorage.statObject.mockResolvedValue({ size: 99 });

    const req = new Request('http://localhost/upload/sess_1/complete', { method: 'POST' });
    
    const res = await routes.completeSession(req, 'sess_1');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('FILEFN_UPLOAD_SIZE_MISMATCH');
    expect(body.error.details).toEqual({ expected: 100, actual: 99 });
    expect(mockStorage.completeMultipartUpload).toHaveBeenCalled();
    expect(mockStorage.statObject).toHaveBeenCalledWith({ key: 'key', target: 'durable' });
    // FILE-30 F-05: the session is refused and the oversized object deleted.
    expect(row.status).toBe('refused');
    expect(mockStorage.deleteObject).toHaveBeenCalledWith({ key: 'key', target: 'durable' });
  });
});
