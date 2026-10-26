import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { getSchema } from '../contentfn/server/src/storage/schema.js';
import { generateDrizzleSchemaFile, generatePrismaSchemaFile, generateKyselySchemaFile } from '../packages/cli/src/utils/schema-generators.js';
import { discoverSuperfunctionsPackages } from '../packages/cli/src/utils/discover-packages.js';
const schema = getSchema();
for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
 const code = generateDrizzleSchemaFile(schema, 'contentfn', 'contentfn', dialect);
 assert.match(code, /docJson: text\('docJson'\)/);
 assert.match(code, /uniqueIndex\('contentfn_revisions_identity'\)/);
}
assert.match(generatePrismaSchemaFile(schema, 'contentfn', 'contentfn'), /docJson\s+String/);
assert.match(generateKyselySchemaFile(schema, 'contentfn', 'contentfn'), /docJson: string/);
const discovered = discoverSuperfunctionsPackages(process.cwd()).filter(item => item.packageName.startsWith('@contentfn/'));
assert.deepEqual(discovered.map(item => [item.packageName,item.initFunction]), [['@contentfn/server','createContentfnServer']]);
writeFileSync('/tmp/contentfn-schema.prisma', generatePrismaSchemaFile(schema, 'contentfn', 'contentfn'));
for (const table of schema.schemas) assert.equal(table.fields.id.maxLength, 64);
const mysql = generateDrizzleSchemaFile(getSchema({jsonStorage: 'native'}), 'contentfn', 'contentfn', 'mysql');
assert.match(mysql, /docJson: json/);
assert.match(mysql, /id: varchar\('id', \{ length: 64 \}\)/);
console.log('Shared CLI discovery and SQLite/PostgreSQL Drizzle/Prisma/Kysely physical schema generation passed');
