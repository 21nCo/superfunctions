import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ConditionEvaluator} from '../../typescript/dist/index.mjs';
const cases=JSON.parse(await readFile(new URL('../tests/fixtures/alert-golden.json',import.meta.url),'utf8'));
for(const test of cases){
 const result=new ConditionEvaluator().evaluateResult(test.condition,new Map(Object.entries(test.data)),test.now);
 assert.equal(result.matched,test.expected,test.name);
 assert.equal(result.value ?? null,test.expectedValue,`${test.name}: scalar value`);
}
console.log(`TypeScript passed ${cases.length} shared alert condition vectors`);
