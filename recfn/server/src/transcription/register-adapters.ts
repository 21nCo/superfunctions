import type { AsrRegistry } from './registry.js';

export interface CloudAsrConfig {
  deepgramApiKey?: string;
  assemblyAiApiKey?: string;
  googleSttApiKey?: string;
}

/**
 * Register cloud ASR adapters (Deepgram, AssemblyAI, Google STT) in the registry.
 * Only registers adapters for which API keys are provided.
 */
export async function registerCloudAdapters(
  registry: AsrRegistry,
  config: CloudAsrConfig,
): Promise<void> {
  if (config.deepgramApiKey) {
    const { DeepgramAdapter } = await import('@recfn/deepgram');
    registry.register(new DeepgramAdapter({ apiKey: config.deepgramApiKey }));
  }
  if (config.assemblyAiApiKey) {
    const { AssemblyAIAdapter } = await import('@recfn/assemblyai');
    registry.register(new AssemblyAIAdapter({ apiKey: config.assemblyAiApiKey }));
  }
  if (config.googleSttApiKey) {
    const { GoogleSttAdapter } = await import('@recfn/google-stt');
    registry.register(new GoogleSttAdapter({ apiKey: config.googleSttApiKey }));
  }
}
