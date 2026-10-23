/** Bounded, validated transport for media metadata; asset bytes are never returned. */
import type { ContentfnEnvelope } from '@contentfn/core';
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export async function mediaRequest<T>(baseUrl: string, path: string, body: unknown, validate: (value: unknown) => value is T, signal?: AbortSignal): Promise<ContentfnEnvelope<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = async (): Promise<ContentfnEnvelope<T>> => {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'No access to media.', details: {} } }; }
      if (!response.body) throw Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 2 * 1024 * 1024) throw Error(); chunks.push(part.value); }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (isRecord(value) && value.ok === false && isRecord(value.error)) {
        const code = value.error.code;
        if (code === 'PERMISSION_DENIED' || code === 'PAYLOAD_TOO_LARGE' || code === 'VALIDATION_FAILED') return { ok: false, error: { code, message: code === 'PERMISSION_DENIED' ? 'No access to media.' : code === 'PAYLOAD_TOO_LARGE' ? 'File exceeds the upload limit.' : 'Invalid media request.', details: {} } };
      }
      if (!response.ok || !isRecord(value) || value.ok !== true || !validate(value.result)) throw Error();
      return { ok: true, result: value.result };
    };
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error()); }, 10_000); })]);
  } catch { return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Media request could not be completed.', details: {} } }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
