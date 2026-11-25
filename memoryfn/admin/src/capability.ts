import {
  defineAdminCapability,
  type AdminObjectSchema,
  type AdminOperationDefinition,
  type AdminResourceDefinition,
} from '@superfunctions/admin';
import type {
  MemoryFnIngestMemoryInput,
  MemoryFnIngestMemoryOutput,
  MemoryFnSearchMemoriesInput,
  MemoryFnSearchMemoriesOutput,
} from './types.js';

const stringSchema = { type: 'string', minLength: 1 } as const;
const memoryTypeSchema = {
  type: 'string',
  enum: [
    'profile_static',
    'profile_dynamic',
    'conversational',
    'procedural',
    'document',
    'derived',
  ],
} as const;
const metadataSchema = { type: 'object', additionalProperties: true } as const;

const memorySchema: AdminObjectSchema = {
  type: 'object',
  properties: {
    id: stringSchema,
    type: memoryTypeSchema,
    content: { type: 'string' },
    isLatest: { type: 'boolean' },
    createdAt: { type: 'integer', minimum: 0 },
    updatedAt: { type: 'integer', minimum: 0 },
  },
  required: ['id', 'type', 'content', 'isLatest', 'createdAt', 'updatedAt'],
  additionalProperties: false,
};

const searchOutputSchema: AdminObjectSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: memorySchema },
    totalFound: { type: 'integer', minimum: 0 },
    returned: { type: 'integer', minimum: 0 },
  },
  required: ['items', 'totalFound', 'returned'],
  additionalProperties: false,
};

const ingestOutputSchema: AdminObjectSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: memorySchema },
    summary: {
      type: 'object',
      properties: {
        created: { type: 'integer', minimum: 0 },
        updated: { type: 'integer', minimum: 0 },
        deduplicated: { type: 'integer', minimum: 0 },
      },
      required: ['created', 'updated', 'deduplicated'],
      additionalProperties: false,
    },
    relationshipsCreated: { type: 'integer', minimum: 0 },
    cost: {
      type: 'object',
      properties: {
        llm: { type: 'number', minimum: 0 },
        embeddings: { type: 'number', minimum: 0 },
        total: { type: 'number', minimum: 0 },
      },
      required: ['llm', 'embeddings', 'total'],
      additionalProperties: false,
    },
  },
  required: ['items', 'summary', 'relationshipsCreated'],
  additionalProperties: false,
};

export const memoryFnAdminResources = [
  {
    id: 'memories',
    label: 'Memories',
    description: 'Search and ingest memories through an environment-scoped MemoryFn runtime.',
    icon: 'memoryfn:memories',
    risk: 'sensitive',
    minimumScope: 'environment',
    idField: 'id',
    displayFields: ['id', 'type', 'content', 'isLatest', 'updatedAt'],
    searchableFields: ['id', 'content'],
    filterableFields: ['type', 'isLatest'],
    sortableFields: ['createdAt', 'updatedAt'],
    sensitiveFields: ['content', 'metadata', 'embedding', 'tenantId', 'containerTags'],
  },
] as const satisfies readonly AdminResourceDefinition[];

const operations = [
  {
    id: 'memoryfn.memories.search',
    title: 'Search memories',
    description: 'Semantically search memories inside the active environment and namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 20_000 },
        filters: metadataSchema,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        threshold: { type: 'number', minimum: 0, maximum: 1 },
        rerank: { type: 'boolean' },
        traverseRelationships: { type: 'boolean' },
        onlyLatest: { type: 'boolean' },
        maxTokens: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        hybridRank: { type: 'boolean' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    outputSchema: searchOutputSchema,
    route: { method: 'POST', path: '/resources/memories/search' },
    permission: 'memoryfn.memories.read',
    minimumScope: 'environment',
    safety: {
      classification: 'read',
      idempotent: true,
      requiresConfirmation: false,
      audit: 'required',
    },
    mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    redaction: { inputFields: ['q', 'filters'] },
    target: { resource: 'memories', collection: true },
  } as const satisfies AdminOperationDefinition<
    MemoryFnSearchMemoriesInput,
    MemoryFnSearchMemoriesOutput
  >,
  {
    id: 'memoryfn.memories.ingest',
    title: 'Ingest memory',
    description: 'Persist a memory through MemoryFn inside the active environment and namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 5_000_000 },
        type: memoryTypeSchema,
        metadata: metadataSchema,
      },
      required: ['content'],
      additionalProperties: false,
    },
    outputSchema: ingestOutputSchema,
    route: { method: 'POST', path: '/resources/memories' },
    permission: 'memoryfn.memories.write',
    minimumScope: 'environment',
    safety: {
      classification: 'write',
      idempotent: false,
      requiresConfirmation: false,
      audit: 'required',
    },
    mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    redaction: { inputFields: ['content', 'metadata'] },
    target: { resource: 'memories', collection: true },
  } as const satisfies AdminOperationDefinition<
    MemoryFnIngestMemoryInput,
    MemoryFnIngestMemoryOutput
  >,
] as const;

export const memoryFnAdminOperations = operations;
export type MemoryFnAdminOperationId = (typeof memoryFnAdminOperations)[number]['id'];

export const memoryFnAdminCapability = defineAdminCapability({
  schemaVersion: '1.0',
  id: 'memoryfn',
  displayName: 'MemoryFn',
  version: '1.0.0',
  description: 'Environment-scoped memory search and ingestion backed by MemoryFn.',
  category: 'data',
  availability: 'required-product',
  scopeLevels: ['installation', 'workspace', 'project', 'environment'],
  dependencies: [],
  resources: memoryFnAdminResources,
  navigation: {
    id: 'memoryfn',
    label: 'MemoryFn',
    path: '/modules/memoryfn',
    icon: 'memoryfn',
    description: 'Search and ingest scoped memories.',
    order: 70,
    requiredPermission: 'memoryfn.memories.read',
  },
  operations,
});

export const capability = memoryFnAdminCapability;
