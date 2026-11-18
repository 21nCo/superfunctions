// Run after building, on Node >=20.19 (synchronous require(ESM) support).
const assert = require('node:assert/strict');
const { wrapWithSchema, transformRecordForStorage } = require('@superfunctions/db/schema');
assert.equal(typeof wrapWithSchema, 'function');
const schema = { rows: { modelName: 'rows', fields: { payload: { type: 'json', jsonStorageType: 'json-text' } } } };
assert.deepEqual(transformRecordForStorage(schema, 'rows', { payload: { valid: true } }), { payload: '{"valid":true}' });
console.log('Synchronous schema entry passed on', process.version);
