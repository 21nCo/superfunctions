import { expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { wrapWithSchema } from '@superfunctions/db/schema';
import { getContentfnSchema } from '../storage/schema.js';
import { schemaUpsert, schemaGet } from '../storage/schemaStorage.js';
import { datasetCreate } from '../storage/datasets.js';

it('rejects a stale schema upgrade after another writer commits a newer version', async () => {
  const db = wrapWithSchema(memoryAdapter(), getContentfnSchema());
  await datasetCreate({ db }, { dataset: 'prod' });
  const schema = (version: number) => ({ version, documentTypes: [{ name: 'post', fields: [] }] });
  await schemaUpsert({ db }, { dataset: 'prod', schema: schema(1) });
  let reads = 0;
  let releaseReads!: () => void;
  let releaseThree!: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
  const threeWritten = new Promise<void>(resolve => { releaseThree = resolve; });
  // Model READ COMMITTED interleaving: both writers observe v1; v3 commits first.
  const concurrent = new Proxy(db, {
    has: (target, key) => key !== 'transaction' && key in target,
    get(target, key) {
      if (key === 'transaction') return undefined;
      if (key === 'findOne') return async (args: Parameters<typeof db.findOne>[0]) => {
        const row = await target.findOne(args);
        if (args.model === 'contentfn_schema') { if (++reads === 2) releaseReads(); await bothRead; }
        return row;
      };
      if (key === 'updateMany') return async (args: Parameters<typeof db.updateMany>[0]) => {
        if (args.data.version === 2) await threeWritten;
        const count = await target.updateMany(args);
        if (args.data.version === 3) releaseThree();
        return count;
      };
      return Reflect.get(target, key);
    },
  });
  const [older, newer] = await Promise.all([2, 3].map(version => schemaUpsert({ db: concurrent }, { dataset: 'prod', schema: schema(version) })));
  expect(older).toMatchObject({ ok: false, error: { code: 'SCHEMA_VERSION_CONFLICT' } });
  expect(newer.ok).toBe(true);
  expect(await schemaGet({ db }, { dataset: 'prod' })).toMatchObject({ ok: true, result: { version: 3 } });
});
