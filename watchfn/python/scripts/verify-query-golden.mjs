/** Runs exactly the same supported-query vectors against the built TS engine. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {QueryEngine, TimeRangeParser} from '../../typescript/dist/index.mjs';
const vectors=JSON.parse(await readFile(new URL('../tests/fixtures/query-golden.json',import.meta.url),'utf8'));
for (const vector of vectors.cases) {
 const events=vector.events??vectors.events;
 const engine=new QueryEngine({getAll:async()=>events});
 const {data}=await engine[vector.aggregate?"aggregate":"execute"](vector.query);
 assert.deepEqual(vector.rawLabels?data.map(event=>event.properties.label):data,vector.expected,vector.name);
}
console.log(`TypeScript QueryEngine passed ${vectors.cases.length} shared golden vectors`);

const calendar=JSON.parse(await readFile(new URL('../tests/fixtures/calendar-golden.json',import.meta.url),'utf8'));
const OriginalDate=globalThis.Date, originalTZ=process.env.TZ;
try {
 for (const vector of calendar) {
  process.env.TZ=vector.timezone;
  globalThis.Date=class extends OriginalDate { constructor(...args){super(...(args.length?args:[vector.now]));} static now(){return vector.now;} };
  assert.deepEqual(TimeRangeParser.parse(vector.shortcut),vector.expected,vector.timezone+' '+vector.shortcut);
 }
} finally {
 globalThis.Date=OriginalDate;
 if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ;
}
console.log(`TypeScript calendar parser passed ${calendar.length} shared timezone/DST vectors`);
