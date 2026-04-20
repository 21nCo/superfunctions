import type { Route, RouteContext } from '@superfunctions/http';
import { ErrorCode } from 'recfn';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { StorageAdapter } from '../integrations/filefn.js';
import { createDownloadResponse } from '../integrations/filefn.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';
import { generateSignedUrl } from '../recording/signed-url.js';

export interface RecordingRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
  storage?: StorageAdapter;
}

export function createRecordingRoutes(deps: RecordingRouteDeps): Route[] {
  const { store, validateApiKey, storage } = deps;

  return [
    {
      method: 'GET',
      path: '/api/v1/bots/:botId/recordings',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const bot = await store.getBot(ctx.params.botId, auth.namespace);
        if (!bot) {
          return err(ErrorCode.BOT_NOT_FOUND, 'Bot not found.');
        }
        const recordings = await store.getRecordings(
          ctx.params.botId,
          auth.namespace,
        );
        return ok({ recordings });
      },
    },

    {
      method: 'GET',
      path: '/api/v1/recordings/:recordingId',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const recording = await store.getRecording(
          ctx.params.recordingId,
          auth.namespace,
        );
        if (!recording) {
          return err(
            ErrorCode.RECORDING_NOT_FOUND,
            'Recording not found.',
          );
        }

        let downloadUrl: string | undefined;
        if (storage && recording.storageRef) {
          try {
            downloadUrl = await generateSignedUrl(
              recording.storageRef,
              storage,
              {
                proxyUrl: new URL(
                  `/api/v1/recordings/${recording.id}/download`,
                  request.url,
                ).toString(),
              },
            );
          } catch {
            // Storage may not have the file yet
          }
        }

        return ok({ ...recording, downloadUrl });
      },
    },

    {
      method: 'GET',
      path: '/api/v1/recordings/:recordingId/download',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const recording = await store.getRecording(
          ctx.params.recordingId,
          auth.namespace,
        );
        if (!recording) {
          return err(
            ErrorCode.RECORDING_NOT_FOUND,
            'Recording not found.',
          );
        }

        if (!storage || !recording.storageRef) {
          return err(
            ErrorCode.RECORDING_NOT_FOUND,
            'Recording file not available.',
          );
        }

        try {
          const signedUrl = await generateSignedUrl(
            recording.storageRef,
            storage,
          );

          return new Response(null, {
            status: 302,
            headers: { Location: signedUrl },
          });
        } catch {
          return createDownloadResponse(storage, recording.storageRef);
        }
      },
    },
  ];
}
