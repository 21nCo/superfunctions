import { GITHUB_APP_SIGNING_ALGORITHM, type GitHubAppSigningKey } from './key.js';

/** GitHub allows up to 60 s of clock drift; `iat` is back-dated by that much. */
export const GITHUB_APP_JWT_BACKDATE_SECONDS = 60;
/**
 * `exp` is set this far ahead of the current time, so `exp - iat` is exactly
 * 10 minutes, the longest lifetime GitHub accepts for an App JWT.
 */
export const GITHUB_APP_JWT_LIFETIME_SECONDS = 540;

export interface GitHubAppJwtClaims {
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The claims of an App JWT issued at `nowSeconds`. */
export function githubAppJwtClaims(appId: string, nowSeconds: number): GitHubAppJwtClaims {
  return {
    iat: nowSeconds - GITHUB_APP_JWT_BACKDATE_SECONDS,
    exp: nowSeconds + GITHUB_APP_JWT_LIFETIME_SECONDS,
    iss: appId,
  };
}

/** Signs an RS256 App JWT with WebCrypto. The result is a bearer secret: never log it. */
export async function signGitHubAppJwt(key: GitHubAppSigningKey, claims: GitHubAppJwtClaims): Promise<string> {
  const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(GITHUB_APP_SIGNING_ALGORITHM, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
