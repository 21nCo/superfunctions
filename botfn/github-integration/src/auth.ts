/**
 * Get GitHub App installation access token
 */
export async function getGitHubAppToken(
  appId: string,
  installationId: string,
  privateKey: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 10 * 60,
    iss: appId,
  };

  const jwt = await generateJWT(payload, privateKey);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Discord-GitHub-Bot',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get GitHub App token: ${response.status}`);
  }

  const data = await response.json();
  return (data as any).token;
}

/**
 * Generate JWT for GitHub App authentication
 */
async function generateJWT(
  payload: Record<string, any>,
  privateKey: string
): Promise<string> {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;

  // GitHub supplies PKCS#1 RSA PEM; Web Crypto imports PKCS#8 PrivateKeyInfo.
  // Also accept standard PKCS#8 PEM and the historical raw PKCS#8 base64 form.
  const binaryKey = privateKeyDer(privateKey);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  // Sign
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(message)
  );

  const encodedSignature = base64UrlEncode(signature);
  return `${message}.${encodedSignature}`;
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(data: string | ArrayBuffer | Uint8Array): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = btoa(data);
  } else if (data instanceof ArrayBuffer) {
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  } else {
    base64 = btoa(String.fromCharCode(...data));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Wrap PKCS#1 bytes in PKCS#8 without Node-only crypto dependencies. */
function privateKeyDer(value: string): ArrayBuffer {
  if (typeof value !== 'string' || value.length > 65536) throw new Error('Invalid GitHub App private key');
  const pem = value.trim();
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]+)-----END \1-----$/.exec(pem);
  if (pem.includes('-----') && !match) throw new Error('Unsupported GitHub App private key format');
  const encoded = (match ? match[2] : pem).replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid GitHub App private key');
  const bytes = new Uint8Array(base64ToArrayBuffer(encoded));
  if (match?.[1] !== 'RSA PRIVATE KEY') return bytes.buffer;
  const length = (n: number): number[] => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  // version=0; rsaEncryption AlgorithmIdentifier including NULL parameters.
  const prefix = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const contents = new Uint8Array([...prefix, 0x04, ...length(bytes.length), ...bytes]);
  return new Uint8Array([0x30, ...length(contents.length), ...contents]).buffer;
}
