import { describe, it, expect } from 'vitest';
import {
  getCaptureStreams,
  createMockCaptureProvider,
} from '../src/capture.js';

describe('capture', () => {
  it('getCaptureStreams returns streams from provider', async () => {
    const provider = createMockCaptureProvider();
    const streams = await getCaptureStreams(provider);
    expect(streams.video).toBeDefined();
    expect(streams.audio).toBeDefined();
    expect(streams.video).toHaveProperty('getTracks');
    expect(streams.audio).toHaveProperty('getTracks');
  });

  it('createMockCaptureProvider returns mock sources', async () => {
    const provider = createMockCaptureProvider();
    const sources = await provider.getSources({ types: ['screen', 'window'] });
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe('mock-source');
    expect(sources[0]!.name).toBe('Mock Screen');
  });
});
