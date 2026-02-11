import { EventEmitter } from 'events';

export interface FileFnEvent {
  type: string;
  timestamp: string;
  requestId?: string;
}

export interface UploadStartedEvent extends FileFnEvent {
  type: 'upload.started';
  uploadSessionId: string;
  fileName: string;
  size: number;
  mimeType: string;
  policy: string;
  principalId?: string;
  tenantId?: string;
}

export interface PartRecordedEvent extends FileFnEvent {
  type: 'part.recorded';
  uploadSessionId: string;
  partNumber: number;
  size: number;
}

export interface FileUploadedEvent extends FileFnEvent {
  type: 'file:uploaded';
  fileId: string;
  versionId: string;
  fileName: string;
  size: number;
  mimeType: string;
  ownerId: string;
  tenantId?: string;
}

export interface FileDeletedEvent extends FileFnEvent {
  type: 'file:deleted';
  fileId: string;
  ownerId: string;
  tenantId?: string;
}

export interface ProcessingStartedEvent extends FileFnEvent {
  type: 'processing.started';
  fileId: string;
  versionId: string;
}

export interface ProcessingCompletedEvent extends FileFnEvent {
  type: 'processing.completed';
  fileId: string;
  versionId: string;
  artifactsCreated: number;
}

export interface ProcessingFailedEvent extends FileFnEvent {
  type: 'processing.failed';
  fileId: string;
  versionId: string;
  error?: string;
}

export type FileFnEventTypes = {
  'upload.started': UploadStartedEvent;
  'part.recorded': PartRecordedEvent;
  'file:uploaded': FileUploadedEvent;
  'file:deleted': FileDeletedEvent;
  'processing.started': ProcessingStartedEvent;
  'processing.completed': ProcessingCompletedEvent;
  'processing.failed': ProcessingFailedEvent;
};

export class FileFnEventEmitter extends EventEmitter {
  emit<K extends keyof FileFnEventTypes>(event: K, payload: FileFnEventTypes[K]): boolean {
    return super.emit(event, payload);
  }

  on<K extends keyof FileFnEventTypes>(event: K, listener: (payload: FileFnEventTypes[K]) => void): this {
    return super.on(event, listener);
  }
}

export function createUploadStartedEvent(
  data: Omit<UploadStartedEvent, 'type' | 'timestamp' | 'requestId'>,
  requestId?: string
): UploadStartedEvent {
  return {
    type: 'upload.started',
    timestamp: new Date().toISOString(),
    requestId,
    ...data,
  };
}

export function createPartRecordedEvent(
  data: Omit<PartRecordedEvent, 'type' | 'timestamp' | 'requestId'>,
  requestId?: string
): PartRecordedEvent {
  return {
    type: 'part.recorded',
    timestamp: new Date().toISOString(),
    requestId,
    ...data,
  };
}

export function createFileUploadedEvent(
  data: Omit<FileUploadedEvent, 'type' | 'timestamp' | 'requestId'>,
  requestId?: string
): FileUploadedEvent {
  return {
    type: 'file:uploaded',
    timestamp: new Date().toISOString(),
    requestId,
    ...data,
  };
}

export function createFileDeletedEvent(
  data: Omit<FileDeletedEvent, 'type' | 'timestamp' | 'requestId'>,
  requestId?: string
): FileDeletedEvent {
  return {
    type: 'file:deleted',
    timestamp: new Date().toISOString(),
    requestId,
    ...data,
  };
}

export function createEventEmitter(): FileFnEventEmitter {
  return new FileFnEventEmitter();
}

export type FileFnEventType = keyof FileFnEventTypes;
