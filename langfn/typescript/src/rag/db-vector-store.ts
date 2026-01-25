import { Adapter, WhereClause } from "@superfunctions/db";
import { Document, Embeddings, VectorStore } from "./base.js";

export interface DocumentRecord {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  namespace: string;
  createdAt: number;
}

export class DbVectorStore extends VectorStore {
  private tableName = "langfn_documents";

  constructor(
    private readonly db: Adapter,
    private readonly embeddings: Embeddings,
    private readonly namespace: string = "default"
  ) {
    super();
  }

  async addDocuments(documents: Document[]): Promise<void> {
    const texts = documents.map(doc => doc.content);
    const vectors = await this.embeddings.embedDocuments(texts);
    
    const records: DocumentRecord[] = documents.map((doc, i) => ({
      id: Math.random().toString(36).substring(7),
      content: doc.content,
      embedding: vectors[i],
      metadata: doc.metadata,
      namespace: this.namespace,
      createdAt: Date.now()
    }));

    await this.db.createMany({
      model: this.tableName,
      data: records
    });
  }

  async search(query: string, options: { k?: number; filter?: Record<string, any> } = {}): Promise<Document[]> {
    const k = options.k ?? 4;
    // Note: This implementation assumes the DB adapter doesn't support vector search directly
    // So it retrieves candidates and reranks in memory. 
    // In a real scenario, we'd use pgvector or similar if supported by the adapter.
    
    const where: WhereClause[] = [{ field: "namespace", operator: "eq", value: this.namespace }];
    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        where.push({ field: key, operator: "eq", value });
      }
    }

    const records = await this.db.findMany<DocumentRecord>({
      model: this.tableName,
      where,
      limit: 100 // Get some candidates
    });

    if (records.length === 0) return [];

    const queryVector = await this.embeddings.embedQuery(query);
    
    const scored = records.map(record => ({
      doc: { content: record.content, metadata: record.metadata },
      score: this.cosineSimilarity(queryVector, record.embedding)
    }));

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(item => ({ ...item.doc, score: item.score }));
  }

  private cosineSimilarity(v1: number[], v2: number[]): number {
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    for (let i = 0; i < v1.length; i++) {
      dotProduct += v1[i] * v2[i];
      magnitude1 += v1[i] * v1[i];
      magnitude2 += v2[i] * v2[i];
    }
    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    if (magnitude1 === 0 || magnitude2 === 0) return 0;
    return dotProduct / (magnitude1 * magnitude2);
  }
}
