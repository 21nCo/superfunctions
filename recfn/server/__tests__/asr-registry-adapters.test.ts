import { describe, it, expect } from 'vitest';
import { createAsrRegistry, registerCloudAdapters } from '../src/index.js';

describe('registerCloudAdapters', () => {
  it('registers Deepgram when apiKey provided', async () => {
    const registry = createAsrRegistry();
    await registerCloudAdapters(registry, {
      deepgramApiKey: 'test-key',
    });

    expect(registry.has('deepgram')).toBe(true);
    const adapter = registry.get('deepgram');
    expect(adapter?.name).toBe('deepgram');
  });

  it('registers AssemblyAI when apiKey provided', async () => {
    const registry = createAsrRegistry();
    await registerCloudAdapters(registry, {
      assemblyAiApiKey: 'test-key',
    });

    expect(registry.has('assemblyai')).toBe(true);
    expect(registry.get('assemblyai')?.name).toBe('assemblyai');
  });

  it('registers Google STT when apiKey provided', async () => {
    const registry = createAsrRegistry();
    await registerCloudAdapters(registry, {
      googleSttApiKey: 'test-key',
    });

    expect(registry.has('google-stt')).toBe(true);
    expect(registry.get('google-stt')?.name).toBe('google-stt');
  });

  it('registers all when all keys provided', async () => {
    const registry = createAsrRegistry();
    await registerCloudAdapters(registry, {
      deepgramApiKey: 'dg',
      assemblyAiApiKey: 'aa',
      googleSttApiKey: 'gs',
    });

    expect(registry.names()).toContain('deepgram');
    expect(registry.names()).toContain('assemblyai');
    expect(registry.names()).toContain('google-stt');
  });

  it('registers none when no keys provided', async () => {
    const registry = createAsrRegistry();
    await registerCloudAdapters(registry, {});

    expect(registry.names()).not.toContain('deepgram');
    expect(registry.names()).not.toContain('assemblyai');
    expect(registry.names()).not.toContain('google-stt');
  });
});
