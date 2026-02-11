#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diffSchemas } from './migrations/diff.js';
import { generateDrizzleMigration, generatePrismaMigration, generateKyselyMigration } from './migrations/adapters/index.js';
import { renderPostgres } from './migrations/render-postgres.js';
import { renderMySQL } from './migrations/render-mysql.js';
import { renderSQLite } from './migrations/render-sqlite.js';
import type { MigrationContext } from './migrations/types.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    schema: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    adapter: { type: 'string', default: 'raw' },
    database: { type: 'string', default: 'postgres' },
    output: { type: 'string', default: './migrations' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];

if (values.help || !command) {
  printHelp();
  process.exit(0);
}

if (command === 'generate-migration') {
  generateMigration();
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

function generateMigration() {
  let fromSchema = null;
  let toSchema;
  
  if (values.schema) {
    toSchema = JSON.parse(readFileSync(resolve(values.schema), 'utf-8'));
    fromSchema = { resources: [], relations: [] };
  } else if (values.from && values.to) {
    fromSchema = JSON.parse(readFileSync(resolve(values.from), 'utf-8'));
    toSchema = JSON.parse(readFileSync(resolve(values.to), 'utf-8'));
  } else {
    console.error('Error: Provide either --schema or both --from and --to');
    process.exit(1);
  }

  const plan = diffSchemas(fromSchema, toSchema);
  
  if (plan.changes.length === 0) {
    console.log('No changes detected');
    return;
  }

  const ctx: MigrationContext = {
    dialect: values.database as any,
    adapter: values.adapter as any,
    fromSchema,
    toSchema,
    joinTablePrefix: '__datafn_join_',
  };

  let output: string;
  let ext: string;
  
  switch (values.adapter) {
    case 'drizzle':
      output = generateDrizzleMigration(plan, ctx);
      ext = 'ts';
      break;
    case 'prisma':
      output = generatePrismaMigration(plan, ctx);
      ext = 'sql';
      break;
    case 'kysely':
      output = generateKyselyMigration(plan, ctx);
      ext = 'ts';
      break;
    default:
      switch (values.database) {
        case 'mysql': output = renderMySQL(plan, ctx); break;
        case 'sqlite': output = renderSQLite(plan, ctx); break;
        default: output = renderPostgres(plan, ctx);
      }
      ext = 'sql';
  }

  const outputDir = resolve(values.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  const timestamp = Date.now();
  const filename = `${timestamp}_migration.${ext}`;
  const outputPath = join(outputDir, filename);
  
  writeFileSync(outputPath, output);
  console.log(`Migration written to: ${outputPath}`);
  console.log(`Changes: ${plan.changes.length}`);
}

function printHelp() {
  console.log(`
@datafn/cli - DataFn CLI

Usage:
  datafn generate-migration [options]

Commands:
  generate-migration    Generate database migration from schema changes

Options:
  --schema <path>      Path to schema file (for initial migration)
  --from <path>        Path to source schema file
  --to <path>          Path to target schema file
  --adapter <name>     ORM adapter: drizzle, prisma, kysely, raw (default: raw)
  --database <name>    Database: postgres, mysql, sqlite (default: postgres)
  --output <dir>       Output directory (default: ./migrations)
  -h, --help           Show this help message

Examples:
  # Generate initial migration
  datafn generate-migration --schema ./schema.json --adapter drizzle --database postgres

  # Generate migration from schema changes
  datafn generate-migration --from ./schema-v1.json --to ./schema-v2.json --adapter drizzle
`);
}
