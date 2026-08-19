import {
  MemoryFn,
  MemoryStorageAdapter,
  type Embedder,
} from '@memoryfn/core';
import { describe, expect, it } from 'vitest';
import {
  createMemoryFnDomainAdminAdapter,
  createMemoryFnDomainAdminService,
  memoryFnAdminCapability,
} from '../index.js';

const context = {
  scope: {
    organizationId: 'org_1',
    workspaceId: 'workspace_1',
    projectId: 'project_1',
    environmentId: 'environment_1',
    namespace: 'tenant_1',
    region: 'in-south',
  },
  actor: { id: 'operator_1', type: 'user' as const, permissions: ['*'] },
  requestId: 'request_1',
  correlationId: 'correlation_1',
  source: 'console' as const,
};

const otherEnvironmentContext = {
  ...context,
  requestId: 'request_2',
  scope: {
    ...context.scope,
    environmentId: 'environment_2',
    namespace: 'tenant_2',
  },
};

function vectorFor(text: string): number[] {
  return text.toLowerCase().includes('alpha') ? [1, 0] : [0, 1];
}

const embedder: Embedder = {
  async embed(text) {
    return vectorFor(text);
  },
  async embedBatch(texts) {
    return texts.map(vectorFor);
  },
};

function runtime(storage = new MemoryStorageAdapter()) {
  return {
    storage,
    memory: new MemoryFn({ storage: { kind: 'sqlite' } }, storage, embedder),
  };
}

describe('@memoryfn/admin', () => {
  it('publishes only the two operations supported by MemoryFn', () => {
    expect(memoryFnAdminCapability.operations.map((operation) => operation.id)).toEqual([
      'memoryfn.memories.search',
      'memoryfn.memories.ingest',
    ]);
    expect(memoryFnAdminCapability.resources?.map((resource) => resource.id)).toEqual([
      'memories',
    ]);
    expect(memoryFnAdminCapability.operations.some((operation) => (
      operation.id.includes('taxonomy')
      || operation.id.includes('retention')
      || operation.id.includes('export')
      || operation.id.includes('delete')
    ))).toBe(false);
    expect(memoryFnAdminCapability.operations.find((operation) => (
      operation.id === 'memoryfn.memories.ingest'
    ))?.safety).toMatchObject({
      classification: 'write',
      idempotent: false,
      requiresConfirmation: false,
      audit: 'required',
    });
  });

  it('persists through the real MemoryFn pipeline and isolates environment namespaces', async () => {
    const { memory } = runtime();
    const adapter = createMemoryFnDomainAdminAdapter({ projectId: 'project_1', memory });

    const visible = await adapter.execute('memoryfn.memories.ingest', {
      content: 'alpha project note',
      type: 'document',
      metadata: { apiKey: 'do-not-return', kind: 'note' },
    }, context);
    await adapter.execute('memoryfn.memories.ingest', {
      content: 'alpha other environment note',
      type: 'document',
      metadata: { kind: 'note' },
    }, otherEnvironmentContext);

    const result = await adapter.execute('memoryfn.memories.search', {
      q: 'alpha',
      filters: { kind: 'note' },
      limit: 20,
      threshold: 0.9,
    }, context);

    expect(visible.data).toEqual({
      items: [expect.objectContaining({ content: 'alpha project note', type: 'document' })],
      summary: { created: 1, updated: 0, deduplicated: 0 },
      relationshipsCreated: 0,
    });
    expect(result.data).toEqual({
      items: [expect.objectContaining({ content: 'alpha project note', type: 'document' })],
      totalFound: 1,
      returned: 1,
    });
    expect(result.data.items[0]).not.toHaveProperty('tenantId');
    expect(result.data.items[0]).not.toHaveProperty('containerTags');
    expect(result.data.items[0]).not.toHaveProperty('embedding');
    expect(result.data.items[0]).not.toHaveProperty('metadata');

    const other = await adapter.execute('memoryfn.memories.search', {
      q: 'alpha',
      filters: { kind: 'note' },
      limit: 20,
      threshold: 0.9,
    }, otherEnvironmentContext);
    expect(other.data.items).toEqual([
      expect.objectContaining({ content: 'alpha other environment note' }),
    ]);
  });

  it('derives the sole container tag instead of accepting caller-controlled tenancy', async () => {
    const { storage, memory } = runtime();
    const service = createMemoryFnDomainAdminService({ projectId: 'project_1', memory });

    await service.ingestMemory({
      content: 'alpha scoped',
    }, context);
    const stored = await storage.searchVectors({
      tenantId: 'sfn-scope:v1:project_1:environment_1:tenant_1:in-south',
      embedding: [1, 0],
      containerTags: [],
      topK: 10,
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]!.tenantId).toMatch(/^sfn-scope:v1:/);
    expect(stored[0]!.containerTags).toEqual([stored[0]!.tenantId]);
  });

  it('rejects a mismatched project before resolving or writing the runtime', async () => {
    const { storage, memory } = runtime();
    const service = createMemoryFnDomainAdminService({ projectId: 'project_1', memory });

    await expect(service.ingestMemory({ content: 'alpha forbidden' }, {
      ...context,
      scope: { ...context.scope, projectId: 'project_2' },
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(storage.searchVectors({
      tenantId: 'sfn-scope:v1:project_1:environment_1:tenant_1:in-south',
      embedding: [1, 0],
      containerTags: [],
      topK: 10,
    })).resolves.toEqual([]);
  });
});
