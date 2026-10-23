import type { Route, RouteContext } from '@superfunctions/http';
import { computeAnalytics } from '@recfn/core';
import { ErrorCode } from '@recfn/core';
import type { RecFnStore } from '../store/types.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';
import { ok, err } from '../middleware/envelope.js';

export interface AnalyticsRouteDeps {
  store: RecFnStore;
  validateApiKey: ValidateApiKey;
}

export function createAnalyticsRoutes(deps: AnalyticsRouteDeps): Route[] {
  const { store, validateApiKey } = deps;

  return [
    {
      method: 'GET',
      path: '/api/v1/recordings/:recordingId/analytics',
      handler: async (request: Request, ctx: RouteContext) => {
        const auth = await authenticate(request, validateApiKey);
        const recordingId = ctx.params.recordingId;

        const recording = await store.getRecording(recordingId, auth.namespace);
        if (!recording) {
          return err(ErrorCode.RECORDING_NOT_FOUND, 'Recording not found.');
        }

        const transcript = await store.getTranscript(recordingId, auth.namespace);
        if (!transcript) {
          return err(
            ErrorCode.ANALYTICS_NOT_READY,
            'Transcript not ready. Analytics require a completed transcript.',
          );
        }

        if (transcript.status !== 'ready') {
          return err(
            ErrorCode.ANALYTICS_NOT_READY,
            'Transcript not ready. Analytics require a completed transcript.',
          );
        }

        const analytics = computeAnalytics(
          recordingId,
          transcript.segments,
          recording.duration,
        );

        return ok(analytics);
      },
    },
  ];
}
