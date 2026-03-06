/**
 * Desktop capture — system audio + screen.
 * Uses Electron desktopCapturer when available, or getDisplayMedia in browser context.
 * For tests, use a mock CaptureProvider.
 */

export interface CaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl?: string;
}

export interface CaptureStreams {
  video: MediaStream;
  audio?: MediaStream;
}

export interface CaptureProvider {
  getSources(options: { types: ('screen' | 'window')[] }): Promise<CaptureSource[]>;
  getStream(sourceId: string, options?: { audio?: boolean }): Promise<CaptureStreams>;
}

/**
 * Get capture streams using the provided provider.
 * In Electron: pass desktopCapturer-based provider.
 * In tests: pass mock provider.
 */
export async function getCaptureStreams(
  provider: CaptureProvider,
  options?: { audio?: boolean; sourceId?: string },
): Promise<CaptureStreams> {
  const sources = await provider.getSources({ types: ['screen', 'window'] });
  const sourceId =
    options?.sourceId ?? sources[0]?.id;
  if (!sourceId) {
    throw new Error('No capture source available');
  }
  return provider.getStream(sourceId, { audio: options?.audio ?? true });
}

/**
 * Create a mock capture provider for testing.
 */
export function createMockCaptureProvider(streams?: CaptureStreams): CaptureProvider {
  const defaultStreams: CaptureStreams = {
    video: new MediaStream(),
    audio: new MediaStream(),
  };
  const s = streams ?? defaultStreams;

  return {
    async getSources() {
      return [{ id: 'mock-source', name: 'Mock Screen' }];
    },
    async getStream() {
      return s;
    },
  };
}
