/**
 * Server upload client — upload recording file to recfn server.
 */

import type { RecFn } from 'recfn-client';

export interface UploadOptions {
  botId: string;
  triggerTranscription?: boolean;
}

export type UploadableRecording = Uint8Array | ArrayBuffer | Blob;

/**
 * Upload a recording file to the recfn server.
 */
export async function uploadRecording(
  client: RecFn,
  file: UploadableRecording,
  options: UploadOptions,
) {
  const payload =
    file instanceof ArrayBuffer ? new Uint8Array(file) : file;
  return client.recordings.upload(payload, {
    botId: options.botId,
    transcribe: options.triggerTranscription,
  });
}
