/**
 * The operator's explicit approval of nonproduction resources for a live run.
 * It names resources and the environment variables that hold credentials;
 * it never holds a credential. Anything the harness may create on a provider
 * or domain must fall inside it.
 */

import { byCodeUnit } from "./matrix.js";

export interface QualificationApproval {
  version: 1;
  nonproduction: true;
  approvedBy: string;
  expiresAt: string;
  /** A registered development domain whose names already resolve only to loopback. */
  domain?: string;
  oauth?: { provider: "google"; clientIdEnv: string; clientSecretEnv: string; relayHost: string; redirectUri: string };
  cloudflare?: { domain: string; accountId: string; zoneId: string; tunnelId: string; credentialsFile: string; apiTokenEnv: string };
  ngrokReserved?: { domain: string; authtokenEnv: string; apiKeyEnv: string };
  /** The API key reads back the account's online endpoints, so a withdrawn name's absence is observed. */
  ngrokEphemeral?: { authtokenEnv: string; apiKeyEnv: string };
}

/** The callback path of the fixture OAuth apps; the relay redirect URI is the relay origin plus this path. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export class ApprovalError extends Error {
  public constructor(message: string) { super(message); this.name = "ApprovalError"; }
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEX32 = /^[a-f0-9]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Fields = Record<string, unknown>;

function object(value: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApprovalError(`${field} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key) && !optional.includes(key));
  // A field the harness does not understand may be a credential value or a scope it would ignore. Its name is never echoed: it is the file's content.
  if (unknown.length) throw new ApprovalError(`${field} has unsupported fields; it allows only ${[...keys, ...optional].sort(byCodeUnit).join(", ")}.`);
  const missing = keys.filter((key) => (value as Fields)[key] === undefined);
  if (missing.length) throw new ApprovalError(`${field} is missing ${missing.join(", ")}.`);
  return value as Fields;
}

function text(fields: Fields, key: string, field: string, pattern?: RegExp): string {
  const value = fields[key];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new ApprovalError(`${field}.${key} is invalid.`);
  return value;
}

const envName = (fields: Fields, key: string, field: string) => text(fields, key, field, ENV_NAME);
const domain = (fields: Fields, key: string, field: string) => text(fields, key, field, DOMAIN);

/** Parse an approval, refusing anything production, expired, malformed or carrying an unexpected field. */
export function parseApproval(value: unknown, now = new Date()): QualificationApproval {
  const root = object(value, "approval", ["version", "nonproduction", "approvedBy", "expiresAt"], ["domain", "oauth", "cloudflare", "ngrokReserved", "ngrokEphemeral"]);
  if (root.version !== 1) throw new ApprovalError("approval.version must be 1.");
  if (root.nonproduction !== true) throw new ApprovalError("approval.nonproduction must be true; production resources are never qualified.");
  const approvedBy = text(root, "approvedBy", "approval");
  const expiresAt = text(root, "expiresAt", "approval");
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) throw new ApprovalError("approval.expiresAt is not a timestamp.");
  if (expiry <= now.getTime()) throw new ApprovalError("approval has expired.");
  const approval: QualificationApproval = { version: 1, nonproduction: true, approvedBy, expiresAt };
  if (root.domain !== undefined) approval.domain = domain(root, "domain", "approval");
  if (root.oauth !== undefined) {
    const oauth = object(root.oauth, "approval.oauth", ["provider", "clientIdEnv", "clientSecretEnv", "relayHost", "redirectUri"]);
    if (oauth.provider !== "google") throw new ApprovalError("approval.oauth.provider must be google.");
    if (!approval.domain) throw new ApprovalError("approval.oauth requires approval.domain for its relay.");
    const relayHost = text(oauth, "relayHost", "approval.oauth", LABEL);
    const redirectUri = text(oauth, "redirectUri", "approval.oauth");
    let redirect: URL;
    try { redirect = new URL(redirectUri); } catch { throw new ApprovalError("approval.oauth.redirectUri is not a URL."); }
    if (redirect.protocol !== "https:" || redirect.hostname !== `${relayHost}.${approval.domain}` || redirect.search || redirect.hash || redirect.username || redirect.password || redirect.pathname !== OAUTH_CALLBACK_PATH) {
      throw new ApprovalError(`approval.oauth.redirectUri must be https://<relayHost>.<domain>[:port]${OAUTH_CALLBACK_PATH}, the relay host of the approved domain.`);
    }
    approval.oauth = { provider: "google", clientIdEnv: envName(oauth, "clientIdEnv", "approval.oauth"), clientSecretEnv: envName(oauth, "clientSecretEnv", "approval.oauth"), relayHost, redirectUri: redirect.href };
  }
  if (root.cloudflare !== undefined) {
    const field = "approval.cloudflare";
    const cf = object(root.cloudflare, field, ["domain", "accountId", "zoneId", "tunnelId", "credentialsFile", "apiTokenEnv"]);
    const credentialsFile = text(cf, "credentialsFile", field);
    if (!credentialsFile.startsWith("/")) throw new ApprovalError(`${field}.credentialsFile must be an absolute path.`);
    approval.cloudflare = { domain: domain(cf, "domain", field), accountId: text(cf, "accountId", field, HEX32), zoneId: text(cf, "zoneId", field, HEX32),
      tunnelId: text(cf, "tunnelId", field, UUID), credentialsFile, apiTokenEnv: envName(cf, "apiTokenEnv", field) };
  }
  if (root.ngrokReserved !== undefined) {
    const field = "approval.ngrokReserved";
    const reserved = object(root.ngrokReserved, field, ["domain", "authtokenEnv", "apiKeyEnv"]);
    approval.ngrokReserved = { domain: domain(reserved, "domain", field), authtokenEnv: envName(reserved, "authtokenEnv", field), apiKeyEnv: envName(reserved, "apiKeyEnv", field) };
  }
  if (root.ngrokEphemeral !== undefined) {
    const field = "approval.ngrokEphemeral";
    const ephemeral = object(root.ngrokEphemeral, field, ["authtokenEnv", "apiKeyEnv"]);
    approval.ngrokEphemeral = { authtokenEnv: envName(ephemeral, "authtokenEnv", field), apiKeyEnv: envName(ephemeral, "apiKeyEnv", field) };
  }
  return approval;
}

/** Domains under which the run may create names: the approved domain and each approved tunnel domain. */
export function approvedDomains(approval: QualificationApproval | undefined): string[] {
  if (!approval) return [];
  return [approval.domain, approval.cloudflare?.domain, approval.ngrokReserved?.domain].filter((item): item is string => item !== undefined);
}
