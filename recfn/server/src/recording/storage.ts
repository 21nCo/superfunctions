import { ErrorCode, createError, type Recording, type RecordingFormat } from '@recfn/core';
import type { StorageAdapter } from '../integrations/storage.js';
import type { RecFnStore } from '../store/types.js';
import type { Logger } from '../integrations/logfn.js';
import type { CaptureResult, CaptureArtifact } from './capture.js';
import type { WebhookDeliverer } from '../worker/lifecycle.js';
import type { MetricsEmitter } from '../integrations/watchfn.js';
import { uploadObject } from '../integrations/storage.js';
import { buildRecordingReadyPayload } from '../webhooks/events.js';
import { checkRecordingDuration } from '../middleware/limits.js';
import { loadLimitsConfig } from '../config.js';
import {
  emitRecordingsCount,
  emitRecordingUploadLatency,
} from '../observability/metrics.js';

function generateRecordingId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `rec_${ts}${rand}`;
}

function storageKey(
  namespace: string,
  recordingId: string,
  format: RecordingFormat,
): string {
  const ext = format === 'mp4' ? 'mp4' : format === 'wav' ? 'wav' : format;
  return `recordings/${namespace}/${recordingId}.${ext}`;
}

function contentTypeForFormat(format: RecordingFormat): string {
  switch (format) {
    case 'mp4':
      return 'video/mp4';
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/opus';
    case 'webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}

export interface UploadRecordingInput {
  botId: string;
  namespace: string;
  capture: CaptureResult | CaptureArtifact;
  source?: 'bot_finalization' | 'manual_upload';
}

export interface UploadRecordingResult {
  recording: Recording;
}

async function uploadRecordingInner(
  input: UploadRecordingInput,
  deps: {
    storage: StorageAdapter;
    store: RecFnStore;
    logger: Logger;
    webhookDeliverer?: WebhookDeliverer;
    metrics?: MetricsEmitter;
  },
): Promise<UploadRecordingResult> {
  const { botId, namespace, capture, source = 'manual_upload' } = input;
  const { storage, store, logger, webhookDeliverer, metrics } = deps;

  if (capture.duration > 0) {
    const limits = loadLimitsConfig();
    checkRecordingDuration(capture.duration, limits);
  }

  const recordingId = generateRecordingId();
  const key = storageKey(namespace, recordingId, capture.format);

  logger.info('recording.upload.start', {
    botId,
    recordingId,
    format: capture.format,
    size: capture.size,
    source,
  });

  const producer = await store.beginBotProducer({ botId, namespace, recordingId, storageRef: key });
  let externalSettled = false;
  const startTime = Date.now();
  try {
    await uploadObject(storage, key, 'data' in capture ? capture.data : capture, {
      contentType: contentTypeForFormat(capture.format),
      encryption: true,
    });

    externalSettled = true;
    const uploadDuration = Date.now() - startTime;

    logger.info('recording.upload.complete', {
      botId,
      recordingId,
      uploadDurationMs: uploadDuration,
      storageRef: key,
      source,
    });

    const recording: Recording = {
      id: recordingId,
      botId,
      format: capture.format,
      duration: capture.duration,
      storageRef: key,
      size: capture.size,
      createdAt: new Date().toISOString(),
    };

    await store.createRecording(recording, namespace);

    if (webhookDeliverer) {
      webhookDeliverer
        .deliver(
          namespace,
          'recording.ready',
          buildRecordingReadyPayload(recording, botId),
        )
        .catch(() => {});
    }

    if (metrics) {
      emitRecordingUploadLatency(metrics, uploadDuration, {
        botId,
        recordingId,
        namespace,
      });
      const recordings = await store.getRecordings(botId, namespace);
      emitRecordingsCount(metrics, recordings.length, namespace);
    }

    return { recording };
  } catch (error) {
    logger.error('recording.upload.failed', {
      botId,
      recordingId,
      source,
      code: ErrorCode.RECORDING_FINALIZATION_FAILED,
      error: error instanceof Error ? error.message : String(error),
    });
    throw createError(
      ErrorCode.RECORDING_FINALIZATION_FAILED,
      `Recording upload failed for ${botId}.`,
      {
        botId,
        recordingId,
        source,
      },
    );
  } finally {
    await store.finishBotProducer(producer.id, namespace, externalSettled);
  }
}

/** Upload consumes a file artifact; always release it, including preflight failures. */
export async function uploadRecording(input: UploadRecordingInput, deps: Parameters<typeof uploadRecordingInner>[1]): Promise<UploadRecordingResult> {
  try { return await uploadRecordingInner(input, deps); }
  finally { if ('dispose' in input.capture) await input.capture.dispose(); }
}
