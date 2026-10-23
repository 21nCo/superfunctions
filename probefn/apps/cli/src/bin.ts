#!/usr/bin/env node
import { executeCli } from './index.js';

try {
  process.exit(await executeCli());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Unknown CLI error.'}\n`);
  process.exit(1);
}
