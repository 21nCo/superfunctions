/** Server-side image transfer. DNS is checked in the socket lookup itself. */
import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, denied, permitsPrivateHost } from '../utils/destination-policy.js';
export { isPublicAddress } from '../utils/destination-policy.js';
import { constants } from 'node:fs';
import { open, mkdir, link, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { BrowseFnError } from '../core/errors.js';
import type { ImageDownloadOptions } from '../core/types.js';

export async function fetchImageBytes(input: string, options: ImageDownloadOptions): Promise<Uint8Array> {
  const deadline = Date.now() + 30_000;
  const maxBytes = options.maxPayloadBytes ?? 20 * 1024 * 1024;
  let url = new URL(input);
  for (let redirects = 0; ; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const allowPrivate = permitsPrivateHost(hostname, options.security ?? { allowPrivateHosts: options.allowPrivateHosts });
    if (!allowPrivate && (isIP(hostname) ? !isPublicAddress(hostname) : hostname === 'localhost')) throw denied();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BrowseFnError({ code: 'PROVIDER_ERROR', message: 'Image download timed out.' });
    const result = await new Promise<{ bytes?: Uint8Array; location?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false,
        headers: { 'accept-encoding': 'identity' },
        lookup: (host, _lookupOptions, callback) => {
          lookup(host, { all: true, verbatim: true }, (error, addresses) => {
            if (error) return callback(error, '', 4);
            if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => !isPublicAddress(address)))) return callback(denied(), '', 4);
            // Return the checked address directly; the connection never resolves it again.
            const chosen = addresses[0];
            if (_lookupOptions.all) (callback as Function)(null, addresses);
            else callback(null, chosen.address, chosen.family);
          });
        },
      });
      const timer = setTimeout(() => request.destroy(new Error('Image download timed out.')), remaining);
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
      request.on('response', async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (redirects >= (options.maxRedirects ?? 5)) throw new BrowseFnError({ code: 'SECURITY_POLICY_BLOCKED', message: 'Redirect limit exceeded for image download.' });
            if (!response.headers.location) throw new Error('Redirect response did not include a location header.');
            resolve({ location: response.headers.location });
            return;
          }
          if (status < 200 || status >= 300) throw new BrowseFnError({ code: status === 404 ? 'UPSTREAM_NOT_FOUND' : 'PROVIDER_ERROR', message: `HTTP ${status}: ${response.statusMessage}` });
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new BrowseFnError({ code: 'PROVIDER_ERROR', message: 'Encoded image responses are not supported.' });
          const tooLarge = () => new BrowseFnError({ code: 'DOWNLOAD_TOO_LARGE', message: 'Image payload exceeds the configured maximum size.' });
          if (Number(response.headers['content-length']) > maxBytes) throw tooLarge();
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > maxBytes) throw tooLarge();
            chunks.push(chunk);
            options.onProgress?.(size, Number(response.headers['content-length']) || size);
          }
          resolve({ bytes: Buffer.concat(chunks, size) });
        } catch (error) { reject(error); }
        finally { response.destroy(); }
      });
      request.end();
    });
    if (result.bytes) return result.bytes;
    url = new URL(result.location!, url);
  }
}

/** The destination directory must be application-owned, not writable by untrusted users. */
export async function writeImage(path: string, bytes: Uint8Array, overwrite?: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    if (overwrite === false) await link(temporary, path);
    else await rename(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BrowseFnError({ code: 'DOWNLOAD_EXISTS', message: 'Destination file already exists and overwrite is disabled.' });
    throw error;
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
