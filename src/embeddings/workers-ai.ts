import type { EmbeddingProvider } from '../core/types';
import { validateVector } from '../core/retrieval';
export interface AIBinding { run(model: string, input: unknown): Promise<unknown> }
export class WorkersAIEmbeddings implements EmbeddingProvider {
  readonly model = '@cf/baai/bge-base-en-v1.5';
  readonly version = '1';
  constructor(private readonly ai: AIBinding) {}
  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.ai.run(this.model, { text: texts }) as { data: number[][] };
    if (!response.data || response.data.length !== texts.length) throw new Error('Embedding batch length mismatch');
    response.data.forEach(validateVector);
    return response.data;
  }
}
