import type { Recording } from 'recfn';
import type { RecFnHttpClient } from '../client.js';
import type { ApiResult } from '../client.js';

export function createRecordingsResource(client: RecFnHttpClient) {
  function toUploadBlob(file: Blob | Uint8Array): Blob {
    if (file instanceof Blob) {
      return file;
    }

    const bytes = new Uint8Array(file.byteLength);
    bytes.set(file);
    return new Blob([bytes.buffer], { type: 'application/octet-stream' });
  }

  return {
    async list(botId: string): Promise<ApiResult<{ recordings: Recording[] }>> {
      return client.request('GET', `/api/v1/bots/${botId}/recordings`);
    },

    async get(recordingId: string): Promise<ApiResult<Recording & { downloadUrl?: string }>> {
      return client.request('GET', `/api/v1/recordings/${recordingId}`);
    },

    async downloadUrl(recordingId: string): Promise<ApiResult<string>> {
      const res = await client.request<Recording & { downloadUrl?: string }>(
        'GET',
        `/api/v1/recordings/${recordingId}`,
      );
      if (res.ok && res.data.downloadUrl) {
        return { ok: true, data: res.data.downloadUrl };
      }
      if (res.ok) {
        return {
          ok: false,
          error: {
            code: 'RECORDING_NOT_FOUND',
            message: 'Download URL not available',
            details: {},
          },
        };
      }
      return res as ApiResult<string>;
    },

    async download(recordingId: string): Promise<ApiResult<Response>> {
      const urlRes = await this.downloadUrl(recordingId);
      if (!urlRes.ok) return urlRes as ApiResult<Response>;
      const response = await fetch(urlRes.data);
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'RECORDING_NOT_FOUND',
            message: `Download failed: ${response.status}`,
            details: {},
          },
        };
      }
      return { ok: true, data: response };
    },

    async upload(
      file: Blob | Uint8Array,
      opts: { botId: string; transcribe?: boolean },
    ): Promise<ApiResult<Recording & { downloadUrl?: string }>> {
      const path = `/api/v1/recordings/upload?botId=${encodeURIComponent(opts.botId)}${opts.transcribe ? '&transcribe=true' : ''}`;
      const blob = toUploadBlob(file);
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');

      const res = await client.requestForm('POST', path, formData);
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: Recording & { downloadUrl?: string };
        error?: { code: string; message: string; details?: Record<string, unknown> };
      };
      if (!res.ok) {
        return {
          ok: false,
          error: body?.error ?? {
            code: 'HTTP_ERROR',
            message: `HTTP ${res.status}`,
            details: {},
          },
        };
      }
      if (body?.ok === true && body?.data) {
        return { ok: true, data: body.data };
      }
      return {
        ok: false,
        error: body?.error ?? {
          code: 'PARSE_ERROR',
          message: 'Unexpected response format',
          details: {},
        },
      };
    },
  };
}
