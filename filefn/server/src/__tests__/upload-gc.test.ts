import { describe, it, expect, vi } from 'vitest';
import { createUploadSessionService } from '../upload-sessions/service.js';

describe('Garbage Collection', () => {
  const mockDb = {
    findMany: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  };
  const mockStorage = {
    capabilities: { multipart: true },
    abortMultipartUpload: vi.fn(),
  };

  const service = createUploadSessionService({
    db: mockDb as any,
    storage: mockStorage as any,
    policies: {} as any,
    events: {} as any,
  });

  it('cleans up expired sessions', async () => {
    mockDb.findMany.mockResolvedValue([
      { uploadSessionId: 's1', storageKey: 'k1', storageUploadId: 'uid1', status: 'pending' },
      { uploadSessionId: 's2', storageKey: 'k2', storageUploadId: null, status: 'in_progress' }
    ]);

    const result = await service.cleanupExpiredSessions();
    
    expect(result.deletedSessions).toBe(2);
    // Should abort s1
    expect(mockStorage.abortMultipartUpload).toHaveBeenCalledWith({ key: 'k1', uploadId: 'uid1' });
    // Should delete both
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });
});