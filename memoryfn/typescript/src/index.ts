import { MemoryFnConfig } from './core/config';
import { MemoryFn } from './core/pipeline';
import { StorageAdapter } from './storage/adapter';
import { MemoryStorageAdapter } from './storage/memory/adapter';
import { PostgresAdapter } from './storage/pg/adapter';
import { OpenAIEmbedder } from './providers/embed/openai';
import { OpenAILLM } from './providers/llm/openai';
import { Embedder, LLMProvider } from './providers/types';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './storage/pg/schema';

// Simple factory for now
export function memoryfn(config: MemoryFnConfig): MemoryFn {
  let storage: StorageAdapter;
  let embedder: Embedder | undefined;
  let llm: LLMProvider | undefined;

  // Init Storage
  if (config.storage.kind === 'pg') {
    if (!config.storage.url) {
      throw new Error('Postgres connection URL is required for kind: pg');
    }
    const client = postgres(config.storage.url);
    const db = drizzle(client, { schema });
    storage = new PostgresAdapter(db);
  } else if (config.storage.kind === 'sqlite') {
      // Process-local persistence for zero-infrastructure and test deployments.
      // A path-backed SQLite adapter can replace this through the public
      // MemoryFn constructor without changing the administration contract.
      storage = new MemoryStorageAdapter();
  } else {
      throw new Error(`Storage kind ${config.storage.kind} not yet supported`);
  }

  // Init Embedder
  if (config.embedder?.provider === 'openai') {
      if (!config.embedder.apiKey) {
          throw new Error('OpenAI API key required for embedder');
      }
      embedder = new OpenAIEmbedder({
          apiKey: config.embedder.apiKey,
          model: config.embedder.model,
          dims: config.embedder.dims
      });
  }

  // Init LLM
  if (config.llm?.provider === 'openai') {
      if (!config.llm.apiKey) {
          throw new Error('OpenAI API key required for LLM');
      }
      llm = new OpenAILLM({
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens
      });
  }

  return new MemoryFn(config, storage, embedder, llm);
}

export * from './core/types';
export * from './core/config';
export * from './core/pipeline';
export * from './providers/types';
export * from './storage/adapter';
export * from './storage/memory/adapter';
export * as http from './http';
export * as mcp from './mcp';
