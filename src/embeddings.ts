import { EMBEDDINGS_API_KEY, EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL } from './config.js';
import { logger } from './logger.js';

export interface EmbeddingResult {
  vector: number[];
  model: string;
}

export async function embedText(text: string): Promise<EmbeddingResult | null> {
  if (!EMBEDDINGS_API_KEY) {
    logger.debug('Embeddings API key not set, skipping embedding');
    return null;
  }

  try {
    const resp = await fetch(`${EMBEDDINGS_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${EMBEDDINGS_API_KEY}`,
      },
      body: JSON.stringify({
        input: text,
        model: EMBEDDINGS_MODEL,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn({ status: resp.status, body }, 'Embedding request failed');
      return null;
    }

    const data = (await resp.json()) as {
      data?: Array<{ embedding: number[] }>;
      model?: string;
    };
    const vector = data.data?.[0]?.embedding;
    if (!vector || vector.length === 0) return null;

    return { vector, model: data.model || EMBEDDINGS_MODEL };
  } catch (err) {
    logger.warn({ err }, 'Embedding request error');
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function encodeVector(vector: number[]): Buffer {
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer);
}

export function decodeVector(buffer: Buffer): number[] {
  const arr = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return Array.from(arr);
}
