import { Document, Embeddings, VectorStore } from "./base.js";

export class InMemoryVectorStore extends VectorStore {
  private documents: Document[] = [];
  private vectors: number[][] = [];

  constructor(private readonly embeddings: Embeddings) {
    super();
  }

  async addDocuments(documents: Document[]): Promise<void> {
    const texts = documents.map(doc => doc.content);
    const vectors = await this.embeddings.embedDocuments(texts);
    this.documents.push(...documents);
    this.vectors.push(...vectors);
  }

  async search(query: string, options: { k?: number; filter?: Record<string, any> } = {}): Promise<Document[]> {
    const k = options.k ?? 4;
    const queryVector = await this.embeddings.embedQuery(query);

    const scores: { score: number; doc: Document }[] = [];

    for (let i = 0; i < this.vectors.length; i++) {
      const docVector = this.vectors[i];
      const doc = this.documents[i];

      // Filter
      if (options.filter) {
        let match = true;
        for (const [key, value] of Object.entries(options.filter)) {
          if (doc.metadata[key] !== value) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      const score = this.cosineSimilarity(queryVector, docVector);
      scores.push({ score, doc });
    }

    return scores
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
