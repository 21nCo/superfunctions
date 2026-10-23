import { vi } from 'vitest';

if (typeof MediaStream === 'undefined') {
  (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream = vi
    .fn()
    .mockImplementation(() => ({
      id: 'mock-stream',
      active: true,
      getTracks: () => [],
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
      getAudioTracks: () => [],
      getVideoTracks: () => [],
      clone: vi.fn(),
    })) as unknown as typeof MediaStream;
}
