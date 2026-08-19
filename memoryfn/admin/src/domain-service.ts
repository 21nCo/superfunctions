import type { IMemoryFn, Memory } from '@memoryfn/core';
import { AdminError, type AdminOperationContext } from '@superfunctions/admin';
import type {
  MemoryFnAdminMemory,
  MemoryFnAdminService,
  MemoryFnDomainAdminServiceOptions,
} from './types.js';

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function assertScope(
  options: MemoryFnDomainAdminServiceOptions,
  context: AdminOperationContext,
): { tenantId: string; scopeTag: string } {
  if (!context.scope.projectId || context.scope.projectId !== options.projectId) {
    throw new AdminError('forbidden', 'The active project cannot access this MemoryFn runtime.');
  }
  const environmentId = context.scope.environmentId?.trim();
  if (!environmentId) {
    throw new AdminError('precondition_failed', 'MemoryFn administration requires an environment scope.');
  }
  const namespace = context.scope.namespace?.trim();
  if (!namespace) {
    throw new AdminError('precondition_failed', 'MemoryFn administration requires a namespace.');
  }
  const region = context.scope.region?.trim() || 'global';
  const scopeTag = [
    'sfn-scope:v1',
    encoded(options.projectId),
    encoded(environmentId),
    encoded(namespace),
    encoded(region),
  ].join(':');
  return { tenantId: scopeTag, scopeTag };
}

async function resolveMemory(
  options: MemoryFnDomainAdminServiceOptions,
  context: AdminOperationContext,
): Promise<IMemoryFn> {
  return typeof options.memory === 'function'
    ? options.memory(context)
    : options.memory;
}

function isInScope(memory: Memory, tenantId: string, scopeTag: string): boolean {
  return memory.tenantId === tenantId && memory.containerTags.includes(scopeTag);
}

function outwardMemory(memory: Memory): MemoryFnAdminMemory {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    isLatest: memory.isLatest,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

/**
 * Binds admin calls to MemoryFn's public API. Tenant identifiers and the
 * mandatory isolation tag are derived exclusively from the active scope.
 */
export function createMemoryFnDomainAdminService(
  options: MemoryFnDomainAdminServiceOptions,
): MemoryFnAdminService {
  if (!options.projectId.trim()) {
    throw new AdminError('invalid_argument', 'MemoryFn admin binding requires a projectId.');
  }

  return {
    async searchMemories(input, context) {
      const { tenantId, scopeTag } = assertScope(options, context);
      const memory = await resolveMemory(options, context);
      const result = await memory.search({ ...input, tenantId, containerTags: [scopeTag] });
      const scoped = result.results.filter((item) => isInScope(item, tenantId, scopeTag));
      return {
        items: scoped.map(outwardMemory),
        totalFound: scoped.length,
        returned: scoped.length,
      };
    },

    async ingestMemory(input, context) {
      const { tenantId, scopeTag } = assertScope(options, context);
      const memory = await resolveMemory(options, context);
      const result = await memory.add({
        content: input.content,
        type: input.type,
        metadata: input.metadata,
        tenantId,
        // This must remain the only container tag: MemoryFn storage adapters
        // use tag overlap, so adding caller labels would weaken scope isolation.
        containerTags: [scopeTag],
      });
      if (result.memories.some((item) => !isInScope(item, tenantId, scopeTag))) {
        throw new AdminError(
          'dependency_unavailable',
          'MemoryFn returned a record outside the active scope.',
          { retryable: false },
        );
      }
      return {
        items: result.memories.map(outwardMemory),
        summary: result.summary,
        relationshipsCreated: result.relationships.length,
        ...(result.cost ? { cost: result.cost } : {}),
      };
    },
  };
}
