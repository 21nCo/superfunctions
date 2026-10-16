import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Supply the trusted npm CLI explicitly; do not resolve executables through PATH.
export const npmCli = process.env.NPM_CLI ?? process.env.npm_execpath;
if (!npmCli || !isAbsolute(npmCli) || !existsSync(npmCli)) {
  throw new Error('Set NPM_CLI to the absolute path of npm/bin/npm-cli.js before running acceptance scripts.');
}
