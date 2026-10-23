import { BlockList, isIP } from 'node:net';
import { BrowseFnError } from '../core/errors.js';
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

export function isPublicAddress(address: string): boolean {
  return isIP(address) === 4 ? !blocked.check(address, 'ipv4') :
    isIP(address) === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function denied(): BrowseFnError {
  return new BrowseFnError({ code: 'SECURITY_POLICY_BLOCKED', message: 'Target host is not allowed by the active security policy.' });
}


import type { DestinationSecurity } from '../core/types.js';
/** Exact names only. URL components, wildcards and ambiguous numeric hosts are invalid. */
export function normalizePolicyHost(value: string): string {
  const invalid = () => new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Security host rules must be exact hostnames or IP addresses.' });
  if (typeof value !== 'string' || !value || /[\s/@?#\\%*]/u.test(value)) throw invalid();
  let host = value.endsWith('.') ? value.slice(0, -1) : value;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (isIP(host) === 6) return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  if (host.includes(':') || !host || host.endsWith('.') || host.includes('..')) throw invalid();
  let normalized: string;
  try { normalized = new URL(`http://${host}/`).hostname; } catch { throw invalid(); }
  if (isIP(normalized) === 4 && normalized !== host) throw invalid();
  if (/^[\d.]+$/.test(host) && !isIP(host)) throw invalid();
  if (!normalized.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label) && label.length <= 63) || normalized.length > 253) throw invalid();
  return normalized.toLowerCase();
}
export function normalizeSecurity(value?: DestinationSecurity): DestinationSecurity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.allowPrivateHosts !== undefined && typeof value.allowPrivateHosts !== 'boolean')) {
    throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Invalid destination security policy.' });
  }
  const hosts = (rules: unknown): string[] | undefined => {
    if (rules === undefined) return undefined;
    if (!Array.isArray(rules) || rules.some(rule => typeof rule !== 'string')) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Security host rules must be arrays of exact hostnames.' });
    return [...new Set(rules.map(normalizePolicyHost))];
  };
  return { allowPrivateHosts: value.allowPrivateHosts, allowedHosts: hosts(value.allowedHosts), blockedHosts: hosts(value.blockedHosts) };
}
export function mergeSecurity(defaults?: DestinationSecurity, override?: DestinationSecurity): DestinationSecurity | undefined {
  const base = normalizeSecurity(defaults), call = normalizeSecurity(override);
  if (!base && !call) return undefined;
  return { allowPrivateHosts: call?.allowPrivateHosts ?? base?.allowPrivateHosts ?? false,
    allowedHosts: call?.allowedHosts ?? base?.allowedHosts ?? [],
    blockedHosts: [...new Set([...(base?.blockedHosts ?? []), ...(call?.blockedHosts ?? [])])] };
}
/** Returns whether this exact destination has an explicit private-address exception. */
export function permitsPrivateHost(host: string, security?: DestinationSecurity): boolean {
  const policy = normalizeSecurity(security);
  const normalized = normalizePolicyHost(host);
  if (policy?.blockedHosts?.includes(normalized)) throw denied();
  return policy?.allowPrivateHosts === true || policy?.allowedHosts?.includes(normalized) === true;
}
export function requiresProtectedTransport(security?: DestinationSecurity): boolean {
  const policy = normalizeSecurity(security);
  return !!policy && (!policy.allowPrivateHosts || !!policy.blockedHosts?.length || !!policy.allowedHosts?.length);
}

export function hasHostnameRules(security?: DestinationSecurity): boolean {
  const policy = normalizeSecurity(security);
  return !!policy?.allowedHosts?.length || !!policy?.blockedHosts?.length;
}
