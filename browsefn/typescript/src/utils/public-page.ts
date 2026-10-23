import { pageLimits } from './security-limits.js';
import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { BrowseFnError } from '../core/errors.js';
import type { GetPageOptions } from '../core/types.js';
import { isPublicAddress, denied, permitsPrivateHost } from './destination-policy.js';

export async function fetchPublicPage(input: string, options: GetPageOptions): Promise<{ bytes: Uint8Array; url: string }> {
  const deadline = Date.now() + (options.timeout ?? 30_000);
  const { maxBytes, maxRedirects } = pageLimits(options.security);
  let url = new URL(input);
  let headers = { ...options.headers };
  if (options.proxy) throw denied();
  for (let redirects = 0; ; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const allowPrivate = permitsPrivateHost(hostname, options.security);
    if (!allowPrivate && (isIP(hostname) ? !isPublicAddress(hostname) : hostname === 'localhost')) throw denied();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BrowseFnError({ code: 'UPSTREAM_TIMEOUT', message: 'Page request timed out.' });
    const result = await new Promise<{ bytes?: Uint8Array; location?: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent: false,
        headers: { ...headers, host: url.host, 'accept-encoding': 'identity' },
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
      const timer = setTimeout(() => request.destroy(new BrowseFnError({ code: 'UPSTREAM_TIMEOUT', message: 'Page request timed out.' })), remaining);
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
      request.on('response', async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (redirects >= maxRedirects) throw new BrowseFnError({ code: 'SECURITY_POLICY_BLOCKED', message: 'Redirect limit exceeded for page request.' });
            if (!response.headers.location) throw new Error('Redirect response did not include a location header.');
            resolve({ location: response.headers.location });
            return;
          }
          if (status < 200 || status >= 300) throw new BrowseFnError({ code: status === 404 ? 'UPSTREAM_NOT_FOUND' : 'PROVIDER_ERROR', message: `HTTP ${status}: ${response.statusMessage}` });
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new BrowseFnError({ code: 'PROVIDER_ERROR', message: 'Encoded page responses are not supported.' });
          const tooLarge = () => new BrowseFnError({ code: 'DOWNLOAD_TOO_LARGE', message: 'Page payload exceeds the configured maximum size.' });
          if (Number(response.headers['content-length']) > maxBytes) throw tooLarge();
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > maxBytes) throw tooLarge();
            chunks.push(chunk);
          }
          resolve({ bytes: Buffer.concat(chunks, size) });
        } catch (error) { reject(error); }
        finally { response.destroy(); }
      });
      request.end();
    });
    if (result.bytes) return { bytes: result.bytes, url: url.href };
    const next = new URL(result.location!, url);
    if (next.origin !== url.origin) headers = {};
    url = next;
  }
}

