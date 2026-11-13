import type { DownloadDescriptor, DownloadDescriptorOptions } from './types.js';

export interface DescriptorBounds { signal: AbortSignal; maxResponseBytes: number }

export async function descriptorOperation<T>(options: DownloadDescriptorOptions, operation: (bounds: DescriptorBounds) => Promise<T>): Promise<T> {
  const signal = options.signal;
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('Invalid download descriptor signal');
  const timeout = options.timeoutMs ?? 10000;
  const maximum = options.maxResponseBytes ?? 65536;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16777216) throw new TypeError('Invalid download descriptor bounds');
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Download descriptor aborted', 'AbortError'));
  const timer = setTimeout(() => controller.abort(new DOMException('Download descriptor deadline exceeded', 'TimeoutError')), timeout);
  try {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return await operation({ signal: controller.signal, maxResponseBytes: maximum });
  }
  catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Host auth callbacks cannot be forcibly stopped; no request starts after abort. */
export async function descriptorHeaders<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); throw signal.reason; }
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([pending, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function descriptorBody(response: Response, bounds: DescriptorBounds): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid download descriptor response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      bounds.signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > bounds.maxResponseBytes) throw new Error('Download descriptor response exceeds byte limit');
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Invalid download descriptor encoding'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function descriptorIdentity(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f/\\?#]/.test(value)) throw new TypeError('Invalid download descriptor identity');
  // Existing FileFn routes capture raw path segments without percent-decoding.
  // Preserve literal custom IDs, but reject values the URL parser would rewrite.
  const path = `/${value}/download`;
  if (new URL(path, 'https://filefn.invalid').pathname !== path) throw new TypeError('Invalid download descriptor identity');
  return value;
}

export function validateDescriptor(value: unknown): DownloadDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid download descriptor');
  const { url, headers } = value as Record<string, unknown>;
  if (typeof url !== 'string' || !url || url.length > 16384 || /[\u0000-\u0020\u007f]/.test(url)) throw new Error('Invalid download descriptor URL');
  // Keep legitimate relative proxy URLs. Resolving/fetching the destination is the caller's responsibility.
  const output: DownloadDescriptor = { url };
  if (headers !== undefined) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('Invalid download descriptor headers');
    const entries = Object.entries(headers); let bytes = 0; const names = new Set<string>();
    if (entries.length > 64) throw new Error('Download descriptor headers exceed limit');
    for (const [name, content] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || names.has(name.toLowerCase()) || typeof content !== 'string' || /[\r\n\u0000]/.test(content)) throw new Error('Invalid download descriptor headers');
      names.add(name.toLowerCase()); bytes += new TextEncoder().encode(name + content).length;
      if (bytes > 16384) throw new Error('Download descriptor headers exceed limit');
    }
    try { new Headers(entries as [string, string][]); } catch { throw new Error('Invalid download descriptor headers'); }
    output.headers = Object.fromEntries(entries) as Record<string, string>;
  }
  return output;
}
