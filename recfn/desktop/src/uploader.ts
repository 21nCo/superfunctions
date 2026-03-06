/**
 * Server upload client — upload recording file to recfn server.
 */

import type { RecFn } from 'recfn-client';

export interface UploadOptions {
  botId: string;
  triggerTranscription?: boolean;
}

/**
 * Upload a recording file to the recfn server.
 */
export async function uploadRecording(
  client: RecFn,
  file: Uint8Array | Blob,
  options: UploadOptions,
) {
  return client.recordings.upload(file, {
    botId: options.botId,
    transcribe: options.triggerTranscription,
  });
}
