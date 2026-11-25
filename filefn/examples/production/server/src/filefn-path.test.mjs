import assert from 'node:assert/strict';
import test from 'node:test';
import { stripFileFnPrefix } from './filefn-path.ts';

test('strips the /filefn mount and keeps a leading slash', () => {
  assert.equal(stripFileFnPrefix('/filefn'), '/');
  assert.equal(stripFileFnPrefix('/filefn/'), '/');
  assert.equal(stripFileFnPrefix('/filefn/upload/init'), '/upload/init');
  assert.equal(stripFileFnPrefix('/health'), '/health');
});
