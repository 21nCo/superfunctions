import OpenAI from 'openai';
import { Embedder } from '../types';

/**
 * OpenAI's limit on the tokens of all inputs of one embeddings request. A
 * token of the byte-level BPE encodings is at least one UTF-8 byte, so the
 * UTF-8 length of the inputs bounds their tokens from above.
 */
export const OPENAI_EMBEDDING_REQUEST_TOKENS = 300_000;

/** UTF-8 length of `text` (an unpaired surrogate counts as the 3 bytes of U+FFFD). */
function utf8Length(text: string): number {
  let bytes = text.length;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) continue;
    if (unit < 0x800) { bytes += 1; continue; }
    if (unit >= 0xD800 && unit <= 0xDBFF && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) index++;
    bytes += 2;
  }
  return bytes;
}

export class OpenAIEmbedder implements Embedder {
  private client: OpenAI;
  private model: string;
  private dims?: number;
  private batchSize: number;

  constructor(config: { apiKey: string; model?: string; dims?: number; batchSize?: number }) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model || 'text-embedding-3-small';
    this.dims = config.dims;
    this.batchSize = config.batchSize ?? 2048;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 2048) {
      throw new RangeError('OpenAI embedding batchSize must be an integer between 1 and 2048');
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dims
    });
    return response.data[0].embedding;
  }

  /**
   * Embeds `texts` in order, in requests of at most batchSize inputs whose
   * UTF-8 bytes (an upper bound of their tokens) stay within
   * OPENAI_EMBEDDING_REQUEST_TOKENS; a longer single input goes alone. A failed
   * request rejects the whole call.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (let offset = 0; offset < texts.length;) {
      let end = offset + 1;
      let tokens = utf8Length(texts[offset]);
      while (end < texts.length && end - offset < this.batchSize) {
        const next = utf8Length(texts[end]);
        if (tokens + next > OPENAI_EMBEDDING_REQUEST_TOKENS) break;
        tokens += next;
        end++;
      }
      const batch = texts.slice(offset, end);
      offset = end;
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dims
      });
      const ordered = [...response.data].sort((left, right) => left.index - right.index);
      if (ordered.length !== batch.length || ordered.some((item, index) => item.index !== index)) {
        throw new Error('MEMORY_EMBEDDING_RESPONSE_MISMATCH');
      }
      embeddings.push(...ordered.map(item => item.embedding));
    }
    return embeddings;
  }
}
