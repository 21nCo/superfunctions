import { describe, expect, it } from 'vitest';
import { computeStoragePath } from '../policies.js';

describe('policy storage paths', () => {
  it('TV-POLICY-001: sanitizes user-controlled path segments before joining', () => {
    const path = computeStoragePath(
      { name: 'user-avatar' },
      {
        tenantId: '../tenant',
        principalId: 'user/123',
        fileId: 'file\\id',
        versionId: 'ver/001',
        fileName: '../../avatar.png',
      },
    );

    expect(path).toBe('%2E%2E%2Ftenant/user%2F123/file%5Cid/ver%2F001-%2E%2E%2F..%2Favatar.png');
    expect(path.split('/')).not.toContain('..');
    expect(path).not.toContain('\\');
  });
});
