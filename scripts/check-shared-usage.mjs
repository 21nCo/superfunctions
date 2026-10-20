#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const roots = ['langfn/typescript', 'langfn/python'];

export function checkSharedUsage(repoRoot = process.cwd()) {
  for (const root of roots) {
    if (!lstatSync(path.join(repoRoot, root)).isDirectory()) {
      throw new Error(`Shared usage scan requires directory: ${root}`);
    }
  }
  // Git is already required by CI. Include untracked, nonignored source files for
  // local runs, while excluding generated dependencies and ignored build output.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...roots], {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
  let scannedFiles = 0;
  for (const file of new Set(files)) {
    const absolute = path.join(repoRoot, file);
    // Match the former search's default: do not follow symbolic links.
    if (!lstatSync(absolute).isFile()) continue;
    const content = readFileSync(absolute);
    if (content.includes(0)) continue;
    scannedFiles++;
    if (/@superfunctions\/|superfunctions\./.test(content.toString('utf8'))) {
      return { file, scannedFiles };
    }
  }
  throw new Error(`No shared superfunctions usage found in ${roots.join(', ')} (${scannedFiles} text files scanned); expected @superfunctions/ or superfunctions.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(checkSharedUsage()));
  } catch (error) {
    console.error(`Shared superfunctions usage guard failed: ${error.message}${error.code ? ` [${error.code}]` : ''}`);
    process.exitCode = 1;
  }
}
