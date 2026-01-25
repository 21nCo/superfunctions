export interface Document {
  content: string;
  metadata: Record<string, any>;
  score?: number;
}

export abstract class Embeddings {
  abstract embedQuery(text: string): Promise<number[]>;
  abstract embedDocuments(texts: string[]): Promise<number[][]>;
}

export abstract class VectorStore {
  abstract addDocuments(documents: Document[]): Promise<void>;
  abstract search(query: string, options?: { k?: number; filter?: Record<string, any> }): Promise<Document[]>;
}

export abstract class Retriever {
  abstract getRelevantDocuments(query: string): Promise<Document[]>;
}
