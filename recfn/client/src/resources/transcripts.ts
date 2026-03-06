import type { Transcript, TranscriptExportFormat } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';
import type { TranscriptStream } from '../ws.js';
import { createTranscriptStream } from '../ws.js';

export interface TranscriptSearchResult {
  results: Array<{
    recordingId: string;
    botId: string;
    segment: unknown;
    context?: unknown[];
  }>;
  nextCursor?: string | null;
}

export function createTranscriptsResource(client: RecFnHttpClient) {
  return {
    async get(
      recordingId: string,
      opts?: { format?: TranscriptExportFormat; redact?: boolean },
    ): Promise<ApiResult<Transcript | string>> {
      const params = new URLSearchParams();
      if (opts?.format) params.set('format', opts.format);
      if (opts?.redact) params.set('redact', 'true');
      const qs = params.toString();
      const path = qs
        ? `/api/v1/recordings/${recordingId}/transcript?${qs}`
        : `/api/v1/recordings/${recordingId}/transcript`;

      const res = await client.requestRaw('GET', path);

      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
        return {
          ok: false,
          error: json.error ?? {
            code: 'HTTP_ERROR',
            message: `HTTP ${res.status}`,
            details: {},
          },
        };
      }

      const format = opts?.format ?? 'json';
      if (format === 'json') {
        const data = (await res.json()) as { ok?: boolean; data?: Transcript; error?: { code: string; message: string; details?: Record<string, unknown> } };
        if (data.ok === true && data.data) {
          return { ok: true, data: data.data };
        }
        if (data.ok === false && data.error) {
          return { ok: false, error: data.error };
        }
      }

      const text = await res.text();
      return { ok: true, data: text };
    },

    async transcribe(
      recordingId: string,
      opts?: { asrProvider?: string; language?: string },
    ): Promise<ApiResult<{ transcriptId: string; status: string }>> {
      return client.request('POST', `/api/v1/recordings/${recordingId}/transcribe`, {
        body: opts ?? {},
      });
    },

    async search(opts: {
      q: string;
      botId?: string;
      limit?: number;
      cursor?: string;
    }): Promise<ApiResult<TranscriptSearchResult>> {
      const params = new URLSearchParams();
      params.set('q', opts.q);
      if (opts.botId) params.set('botId', opts.botId);
      if (opts.limit != null) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      return client.request('GET', `/api/v1/transcripts/search?${params}`);
    },

    stream(botId: string): TranscriptStream {
      return createTranscriptStream(client, botId);
    },
  };
}
