export type {
  Processor,
  ProcessorInput,
  ProcessorOutputArtifact,
  ProcessorResult,
  ProcessingConfig,
  ProcessingJobInput,
  ProcessingJobResult,
  ThumbnailConfig,
  ThumbnailSize,
  CompressionConfig,
} from './types.js';

export {
  createThumbnailProcessor,
  THUMBNAIL_SUPPORTED_MIME_TYPES,
} from './processors/thumbnail.js';

export {
  createCompressionProcessor,
  COMPRESSION_SUPPORTED_MIME_TYPES,
} from './processors/compression.js';

export interface ProcessingPipeline {
  name: string;
  process(data: Uint8Array): Promise<Uint8Array>;
}

export function createPipeline(steps: ProcessingPipeline[]): ProcessingPipeline {
  return {
    name: 'composite',
    async process(data: Uint8Array): Promise<Uint8Array> {
      let result = data;
      for (const step of steps) {
        result = await step.process(result);
      }
      return result;
    },
  };
}

export function supportsProcessor(processor: { supportedMimeTypes: string[] }, mimeType: string): boolean {
  if (processor.supportedMimeTypes.includes('*/*')) {
    return true;
  }
  return processor.supportedMimeTypes.includes(mimeType);
}
