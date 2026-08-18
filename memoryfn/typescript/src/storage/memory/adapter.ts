import type { Memory, MemoryRelationship } from '../../core/types';
import type { StorageAdapter } from '../adapter';

function cloneMemory(memory: Memory): Memory {
  return {
    ...memory,
    containerTags: [...memory.containerTags],
    embedding: memory.embedding ? [...memory.embedding] : null,
    metadata: structuredClone(memory.metadata),
  };
}

function cloneRelationship(relationship: MemoryRelationship): MemoryRelationship {
  return { ...relationship };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function metadataMatches(
  metadata: Record<string, unknown>,
  filters: Record<string, unknown> | undefined,
): boolean {
  if (!filters) return true;
  return Object.entries(filters).every(([key, value]) => jsonContains(metadata[key], value));
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.every((candidate) => actual.some((value) => jsonContains(value, candidate)));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>)
      .every(([key, value]) => jsonContains((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
}

/**
 * A process-local StorageAdapter for self-hosted development and tests. It
 * preserves records for the lifetime of this adapter instance and applies the
 * same tag-overlap and metadata-filter semantics as the Postgres adapter. Use
 * the Postgres adapter when storage must survive process restarts.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private readonly memories = new Map<string, Memory>();
  private readonly relationships = new Map<string, MemoryRelationship>();
  private sequence = 0;

  async insertMemories(inputs: Partial<Memory>[]): Promise<Memory[]> {
    const now = Date.now();
    const saved = inputs.map((input) => {
      const memory: Memory = {
        id: input.id ?? `memory-${now}-${++this.sequence}`,
        tenantId: input.tenantId ?? 'default',
        containerTags: [...(input.containerTags ?? [])],
        type: input.type ?? 'conversational',
        content: input.content ?? '',
        embedding: input.embedding ? [...input.embedding] : null,
        metadata: structuredClone(input.metadata ?? {}),
        isLatest: input.isLatest ?? true,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      };
      return memory;
    });
    const ids = new Set<string>();
    for (const memory of saved) {
      if (ids.has(memory.id) || this.memories.has(memory.id)) {
        throw new Error(`Memory already exists: ${memory.id}`);
      }
      ids.add(memory.id);
    }
    for (const memory of saved) this.memories.set(memory.id, cloneMemory(memory));
    return saved.map(cloneMemory);
  }

  async insertRelationships(inputs: Partial<MemoryRelationship>[]): Promise<MemoryRelationship[]> {
    const now = Date.now();
    const saved = inputs.map((input) => {
      if (!input.fromId || !input.toId) {
        throw new Error('Memory relationships require fromId and toId.');
      }
      const relationship: MemoryRelationship = {
        id: input.id ?? `relationship-${now}-${++this.sequence}`,
        fromId: input.fromId,
        toId: input.toId,
        type: input.type ?? 'extends',
        confidence: input.confidence ?? 1,
        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        createdAt: input.createdAt ?? now,
      };
      this.relationships.set(relationship.id, cloneRelationship(relationship));
      return relationship;
    });
    return saved.map(cloneRelationship);
  }

  async searchVectors(params: {
    tenantId?: string;
    embedding: number[];
    containerTags: string[];
    filters?: Record<string, unknown>;
    topK: number;
    threshold?: number;
  }): Promise<Memory[]> {
    const requestedTags = new Set(params.containerTags);
    return [...this.memories.values()]
      .filter((memory) => (
        memory.tenantId === (params.tenantId ?? 'default')
        && (requestedTags.size === 0 || memory.containerTags.some((tag) => requestedTags.has(tag)))
        && metadataMatches(memory.metadata, params.filters)
      ))
      .map((memory) => ({
        memory,
        similarity: memory.embedding ? cosineSimilarity(params.embedding, memory.embedding) : 0,
      }))
      .filter(({ similarity }) => Number.isFinite(similarity) && (params.threshold === undefined || similarity >= params.threshold))
      .sort((left, right) => right.similarity - left.similarity || right.memory.updatedAt - left.memory.updatedAt)
      .slice(0, Math.max(0, params.topK))
      .map(({ memory }) => cloneMemory(memory));
  }
}
