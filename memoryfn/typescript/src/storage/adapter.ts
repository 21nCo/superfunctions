import { Memory, MemoryRelationship, SearchMemoryInput, SearchMemoryResult } from '../core/types';

export interface StorageAdapter {
  insertMemories(memories: Partial<Memory>[]): Promise<Memory[]>;
  insertRelationships(relationships: Partial<MemoryRelationship>[]): Promise<MemoryRelationship[]>;
  searchVectors(params: {
    embedding: number[];
    containerTags: string[];
    filters?: Record<string, any>;
    topK: number;
    threshold?: number;
  }): Promise<Memory[]>;
  // ... other methods
}
