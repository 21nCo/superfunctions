/** Bounded, validated transport for bounded metadata; full document bodies are not exposed. */
import type { ContentfnEnvelope } from '@contentfn/core';
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
class ResponseTooLargeError extends Error {}
export async function boundedRequest<T>(baseUrl: string, path: string, body: unknown, validate: (value: unknown) => value is T, signal?: AbortSignal, resource: 'media' | 'references' = 'media', timeoutMs = 10_000): Promise<ContentfnEnvelope<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = async (): Promise<ContentfnEnvelope<T>> => {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); return { ok: false, error: { code: 'PERMISSION_DENIED', message: `No access to ${resource}.`, details: {} } }; }
      if (!response.body) throw Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 2 * 1024 * 1024) throw new ResponseTooLargeError(); chunks.push(part.value); }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (isRecord(value) && value.ok === false && isRecord(value.error)) {
        const code = value.error.code;
        if (code === 'PERMISSION_DENIED' || code === 'AUTH_REQUIRED' || code === 'PAYLOAD_TOO_LARGE' || code === 'VALIDATION_FAILED') return { ok: false, error: { code: code === 'AUTH_REQUIRED' ? 'PERMISSION_DENIED' : code, message: code === 'PERMISSION_DENIED' || code === 'AUTH_REQUIRED' ? `No access to ${resource}.` : code === 'PAYLOAD_TOO_LARGE' ? (resource === 'media' ? 'File exceeds the upload limit.' : 'Reference preview exceeds the response limit.') : `Invalid ${resource} request.`, details: {} } };
      }
      if (!response.ok || !isRecord(value) || value.ok !== true || !validate(value.result)) throw Error();
      return { ok: true, result: value.result };
    };
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error()); }, timeoutMs); })]);
  } catch (error) { if (error instanceof ResponseTooLargeError) return { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Response exceeds the metadata limit.', details: { reason: 'RESPONSE_TOO_LARGE' } } }; return { ok: false, error: { code: 'INTERNAL_ERROR', message: `${resource === 'media' ? 'Media' : 'Reference'} request could not be completed.`, details: {} } }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
