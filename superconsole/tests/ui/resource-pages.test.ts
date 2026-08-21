import { describe, expect, it, vi } from 'vitest';
import { loadResourceList } from '../../src/lib/components/resource-pages';
import type { RegistryViewModel } from '../../src/lib/components/view-models';

const registry: RegistryViewModel = {
  modules: [{
    id: 'examplefn',
    name: 'ExampleFn',
    description: 'Example resources.',
    href: '/modules/examplefn',
    enabled: true,
    resources: [{
      id: 'records',
      resourceId: 'records',
      sourceModuleId: 'examplefn',
      idField: 'id',
      label: 'Records',
      href: '/modules/examplefn/records',
      listApiHref: '/api/admin/v1/modules/examplefn/resources/records',
      presentation: {
        columns: [{ field: 'createdAt', label: 'Created' }],
        defaultSort: { field: 'createdAt', direction: 'desc' },
      },
    }],
  }],
};

describe('generic resource list ordering', () => {
  it('preserves provider ordering for canonical items and explicit rows', async () => {
    const payloads = [
      { items: [{ id: 'provider-first', createdAt: '2024-01-01' }, { id: 'provider-second', createdAt: '2026-01-01' }] },
      { rows: [{ id: 'explicit-first', values: { createdAt: '2024-01-01' } }, { id: 'explicit-second', values: { createdAt: '2026-01-01' } }] },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: payloads.shift() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const input = {
      fetcher,
      url: new URL('https://console.example.test/modules/examplefn/records'),
      registry,
      moduleId: 'examplefn',
      resourceId: 'records',
    };

    const canonical = await loadResourceList(input);
    const explicit = await loadResourceList(input);

    expect(canonical.view?.rows.map((row) => row.id)).toEqual(['provider-first', 'provider-second']);
    expect(explicit.view?.rows.map((row) => row.id)).toEqual(['explicit-first', 'explicit-second']);
  });
});
