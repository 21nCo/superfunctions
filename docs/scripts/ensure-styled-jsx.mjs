import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootNodeModules = join(scriptsDir, '..', '..', 'node_modules');
const docsNodeModules = join(scriptsDir, '..', 'node_modules');

const source = join(rootNodeModules, 'styled-jsx');
const target = join(docsNodeModules, 'styled-jsx');

if (!existsSync(source) || existsSync(target)) {
  process.exit(0);
}

mkdirSync(docsNodeModules, { recursive: true });
cpSync(source, target, { recursive: true });
