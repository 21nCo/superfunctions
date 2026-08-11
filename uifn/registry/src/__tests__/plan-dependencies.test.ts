import { describe, expect, it } from 'vitest';
import { REGISTRY_CATALOG_PAYLOAD } from '../generated/catalog';
import { inferFrameworkDependencies } from '../plan';
import { REQUIRED_FRAMEWORKS } from '../schema';

describe('source dependency inference', () => {
  it.each(REQUIRED_FRAMEWORKS)('includes direct recipe imports for %s templates', (framework) => {
    const manifest = REGISTRY_CATALOG_PAYLOAD.artifacts[0];
    const dependencies = inferFrameworkDependencies(manifest, framework);

    expect(dependencies).toContainEqual({
      name: '@uifn/recipes',
      version: '0.0.1',
      relationship: 'runtime',
    });
  });
});
