import crypto from 'crypto';

import {
  MEMORY_DEDUP_THRESHOLD,
  MEMORY_TOP_K,
} from './config.js';
import {
  createMemoryEmbedding,
  createMemoryItem,
  getMemoryEmbeddingsByGroup,
  getMemoryItemsByIds,
  searchMemoryFts,
  MemoryItemRow,
} from './db.js';
import { cosineSimilarity, decodeVector, embedText, encodeVector } from './embeddings.js';
import { logger } from './logger.js';

export interface MemoryItemInput {
  groupFolder: string;
  content: string;
  summary?: string;
  tags?: string[];
  source?: string;
}

export interface MemoryResult extends MemoryItemRow {
  score: number;
}

function buildId(): string {
  return `mem-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeTextScore(bm25: number | null): number {
  if (bm25 === null || bm25 === undefined) return 0;
  return 1 / (1 + Math.max(0, bm25));
}

function timeDecayScore(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  return 1 / (1 + ageDays / 30);
}

export async function writeMemoryItem(input: MemoryItemInput): Promise<MemoryItemRow | null> {
  const content = input.content.trim();
  if (!content) return null;

  const embedding = await embedText(content);
  if (embedding) {
    const candidates = getMemoryEmbeddingsByGroup(input.groupFolder);
    for (const candidate of candidates) {
      const vec = decodeVector(candidate.vector);
      const similarity = cosineSimilarity(embedding.vector, vec);
      if (similarity >= MEMORY_DEDUP_THRESHOLD) {
        logger.debug(
          { similarity, memoryId: candidate.id },
          'Memory deduped by vector similarity',
        );
        return null;
      }
    }
  }

  const now = new Date().toISOString();
  const row = createMemoryItem({
    id: buildId(),
    group_folder: input.groupFolder,
    content,
    summary: input.summary ?? null,
    tags: input.tags ? input.tags.join(',') : null,
    source: input.source ?? null,
    created_at: now,
  });

  if (embedding) {
    createMemoryEmbedding({
      memory_id: row.id,
      model: embedding.model,
      vector: encodeVector(embedding.vector),
      created_at: now,
    });
  }

  return row;
}

export async function searchMemory(groupFolder: string, query: string, limit = MEMORY_TOP_K): Promise<MemoryResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const embedding = await embedText(trimmed);
  let ftsRows: Array<{ id: string; bm25: number }> = [];
  try {
    ftsRows = searchMemoryFts({
      groupFolder,
      query: trimmed,
      limit: Math.max(limit * 4, 20),
    });
  } catch (err) {
    logger.warn({ err }, 'Memory FTS query failed');
  }
  const embeddingMap = new Map<string, number[]>();
  const candidateIds = new Set<string>(ftsRows.map((r) => r.id));

  if (embedding) {
    const candidates = getMemoryEmbeddingsByGroup(groupFolder);
    for (const c of candidates) {
      embeddingMap.set(c.id, decodeVector(c.vector));
      candidateIds.add(c.id);
    }
  }

  const items = getMemoryItemsByIds([...candidateIds]);

  const ftsScoreMap = new Map<string, number>();
  for (const row of ftsRows) {
    ftsScoreMap.set(row.id, normalizeTextScore(row.bm25));
  }

  const results: MemoryResult[] = items.map((item) => {
    const vec = embedding && embeddingMap.has(item.id)
      ? cosineSimilarity(embedding.vector, embeddingMap.get(item.id)!)
      : 0;
    const textScore = ftsScoreMap.get(item.id) ?? 0;
    const timeScore = timeDecayScore(item.created_at);

    const score = vec * 0.6 + textScore * 0.3 + timeScore * 0.1;

    return { ...item, score };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
