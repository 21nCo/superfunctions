/** Runs exactly the same supported-query vectors against the built TS engine. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {QueryEngine} from '../../typescript/dist/index.mjs';
const vectors=JSON.parse(await readFile(new URL('../tests/fixtures/query-golden.json',import.meta.url),'utf8'));
for (const vector of vectors.cases) {
 const events=vector.events??vectors.events;
 const engine=new QueryEngine({getAll:async()=>events});
 const {data}=await engine.execute(vector.query);
 assert.deepEqual(vector.rawLabels?data.map(event=>event.properties.label):data,vector.expected,vector.name);
}
console.log(`TypeScript QueryEngine passed ${vectors.cases.length} shared golden vectors`);
