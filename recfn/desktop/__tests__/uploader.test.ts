import { describe, it, expect, vi } from 'vitest';
import { uploadRecording } from '../src/uploader.js';
import { RecFn } from 'recfn-client';

describe('uploader', () => {
  it('uploadRecording delegates to client.recordings.upload', async () => {
    const mockUpload = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        id: 'rec_123',
        botId: 'bot_1',
        format: 'webm',
        duration: 10,
        storageRef: 'recordings/ns/rec_123.webm',
        size: 1024,
        createdAt: '2024-01-01T00:00:00Z',
      },
    });

    const client = {
      recordings: { upload: mockUpload },
    } as unknown as RecFn;

    const result = await uploadRecording(
      client,
      new Uint8Array([1, 2, 3]),
      { botId: 'bot_1' },
    );

    expect(mockUpload).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ botId: 'bot_1' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('rec_123');
    }
  });
});
