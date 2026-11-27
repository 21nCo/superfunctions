import type {
  IMemoryFn,
  Memory,
  MemoryType,
  SearchMemoryInput,
} from '@memoryfn/core';
import type { AdminOperationContext } from '@superfunctions/admin';

/** Deliberately omits embeddings, tenant keys, scope tags, and arbitrary metadata. */
export type MemoryFnAdminMemory = Pick<
  Memory,
  'id' | 'type' | 'content' | 'isLatest' | 'createdAt' | 'updatedAt'
>;

export type MemoryFnSearchMemoriesInput = Omit<SearchMemoryInput, 'containerTags' | 'tenantId'>;

export interface MemoryFnSearchMemoriesOutput {
  items: MemoryFnAdminMemory[];
  totalFound: number;
  returned: number;
}

export interface MemoryFnIngestMemoryInput {
  content: string;
  type?: MemoryType;
  metadata?: Record<string, unknown>;
}

export interface MemoryFnIngestMemoryOutput {
  items: MemoryFnAdminMemory[];
  summary: {
    created: number;
    updated: number;
    deduplicated: number;
  };
  relationshipsCreated: number;
  cost?: {
    llm: number;
    embeddings: number;
    total: number;
  };
}

export interface MemoryFnAdminService {
  searchMemories(
    input: MemoryFnSearchMemoriesInput,
    context: AdminOperationContext,
  ): Promise<MemoryFnSearchMemoriesOutput>;
  ingestMemory(
    input: MemoryFnIngestMemoryInput,
    context: AdminOperationContext,
  ): Promise<MemoryFnIngestMemoryOutput>;
}

export interface MemoryFnDomainAdminServiceOptions {
  /** Project that owns the configured MemoryFn runtime or runtime resolver. */
  projectId: string;
  /** Public MemoryFn API. A resolver may select a region-local configured runtime. */
  memory:
    | IMemoryFn
    | ((context: AdminOperationContext) => IMemoryFn | Promise<IMemoryFn>);
}
