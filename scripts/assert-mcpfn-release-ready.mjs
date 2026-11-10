#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleaseTag } from './resolve-release-tag.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read-only registry query. Network/authentication errors are never absence. */
export function registryVersions(name, range, registry) {
  let output;
  try {
    output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', `${name}@${range}`, 'version', '--json', '--registry', registry],
      {encoding:'utf8', timeout:30_000, stdio:['ignore','pipe','pipe']});
  } catch (error) {
    let diagnostic;
    try { diagnostic = JSON.parse(String(error.stdout)); } catch { /* Not a structured registry response. */ }
    if (diagnostic?.error?.code === 'E404') return [];
    throw new Error(`Could not verify registry availability of ${name}@${range}`, {cause:error});
  }
  const result = JSON.parse(output);
  const versions = typeof result === 'string' ? [result] : result;
  if (!Array.isArray(versions) || !versions.length || !versions.every(version => typeof version === 'string' && version.length)) {
    throw new Error(`Invalid version response for ${name}@${range}`);
  }
  return versions;
}

/** Enforce dependency-first publication; this function never publishes anything. */
export async function assertMcpReleaseReady(manifest, {
  internalNames,
  registry = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry ?? 'https://registry.npmjs.org',
  lookup = registryVersions,
} = {}) {
  if (!manifest.name?.startsWith('@mcpfn/')) return {applicable:false};
  const url = new URL(registry);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Registry must be an HTTP(S) URL without embedded credentials');
  }
  const names = internalNames ?? new Set(JSON.parse(readFileSync(path.join(root,'release-packages.json'))).map(entry => entry.name));
  const existing = await lookup(manifest.name, manifest.version, registry);
  if (existing.length) throw new Error(`${manifest.name}@${manifest.version} already exists; choose a new version instead of substituting a workspace build`);
  const checked = [];
  const missing = [];
  // Check each declaration independently: optional/peer entries must not hide a
  // required declaration with the same name and an incompatible version range.
  for (const field of ['dependencies','optionalDependencies','peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!names.has(name) && !/^@(mcpfn|superfunctions|datafn)\//.test(name)) continue;
      if (typeof range !== 'string' || !/^[~^<>=*0-9]/.test(range)) {
        throw new Error(`${manifest.name} has a non-version internal ${field} declaration: ${name}@${range}`);
      }
      const versions = await lookup(name, range, registry);
      if (!versions.length) missing.push(`${name}@${range} (${field})`);
      checked.push({name, range, field, versions});
    }
  }
  if (missing.length) throw new Error(`Publish required internal dependencies before ${manifest.name}@${manifest.version}: ${missing.join(', ')}`);
  return {applicable:true, name:manifest.name, version:manifest.version, checked};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = await resolveReleaseTag(process.argv[2] ?? process.env.RELEASE_TAG);
    const manifest = JSON.parse(readFileSync(path.join(root,target.path,'package.json')));
    console.log(JSON.stringify(await assertMcpReleaseReady(manifest), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
