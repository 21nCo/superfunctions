export interface ProcessorInput {
  fileId: string;
  versionId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  fileName: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessorOutputArtifact {
  kind: string;
  data: Uint8Array;
  mimeType: string;
  storageKey: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessorResult {
  success: boolean;
  artifacts: ProcessorOutputArtifact[];
  error?: string;
}

export interface Processor {
  name: string;
  supportedMimeTypes: string[];
  process(input: ProcessorInput, getData: () => Promise<Uint8Array>): Promise<ProcessorResult>;
}

export interface ProcessingConfig {
  processors: Processor[];
  enabled?: boolean;
}

export interface ProcessingJobInput {
  fileId: string;
  versionId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  fileName: string;
  tenantId?: string;
}

export interface ProcessingJobResult {
  fileId: string;
  versionId: string;
  success: boolean;
  artifactsCreated: number;
  errors?: string[];
}

export interface ThumbnailConfig {
  sizes?: ThumbnailSize[];
  quality?: number;
  format?: 'jpeg' | 'png' | 'webp';
}

export interface ThumbnailSize {
  name: string;
  width: number;
  height: number;
}

export interface CompressionConfig {
  algorithm?: 'gzip' | 'deflate';
  level?: number;
}
