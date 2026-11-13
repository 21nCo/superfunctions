import { describe, expect, it } from 'vitest';
import * as db from '@superfunctions/db';
import * as dbTesting from '@superfunctions/db/testing';
import * as db02 from '@superfunctions/db-0.2';
import * as db02Testing from '@superfunctions/db-0.2/testing';

describe('db 0.2 compatibility run', () => {
  it('resolves every @superfunctions/db import to the 0.2.x package', () => {
    expect(db.DuplicateKeyError).toBe(db02.DuplicateKeyError);
    expect(dbTesting.memoryAdapter).toBe(db02Testing.memoryAdapter);
  });
});
