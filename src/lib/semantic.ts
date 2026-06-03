// ─────────────────────────────────────────────────────────────────────────
// Semantic layer over pgvector (asset_embeddings table). Stores 512-d Marengo
// embeddings for our assets and runs cosine search. Prisma has no native
// vector type, so we use raw SQL.
//
// Vectors are passed as the pgvector literal '[0.1,0.2,...]'. We build that
// string ourselves from numeric arrays (no injection surface).
// ─────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";

export type SemanticHit = {
  id: string;
  assetId: string | null;
  brandId: string | null;
  modality: string;
  category: string | null;
  url: string;
  startSec: number | null;
  endSec: number | null;
  similarity: number;
};

function toVectorLiteral(vec: number[]): string {
  // pgvector literal: [v1,v2,...]. Guard against non-finite values.
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;
}

// Insert one embedding row. For videos, call once per clip segment.
export async function insertEmbedding(params: {
  assetId: string | null;
  brandId: string | null;
  modality: "image" | "video" | "text";
  category: string | null;
  url: string;
  embedding: number[];
  startSec?: number | null;
  endSec?: number | null;
}): Promise<void> {
  const vec = toVectorLiteral(params.embedding);
  await prisma.$executeRawUnsafe(
    `INSERT INTO asset_embeddings (asset_id, brand_id, modality, category, url, start_sec, end_sec, embedding)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::vector)`,
    params.assetId,
    params.brandId,
    params.modality,
    params.category,
    params.url,
    params.startSec ?? null,
    params.endSec ?? null,
    vec,
  );
}

// Remove all embeddings for an asset (e.g. when the asset is deleted).
export async function deleteEmbeddingsForAsset(assetId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM asset_embeddings WHERE asset_id = $1::uuid`, assetId);
}

// Cosine search. Returns hits ordered by similarity (1 = identical).
// Optional filters: brandId, modality, category.
export async function searchEmbeddings(params: {
  embedding: number[];
  brandId?: string | null;
  modality?: string | null;
  category?: string | null;
  limit?: number;
}): Promise<SemanticHit[]> {
  const vec = toVectorLiteral(params.embedding);
  const limit = Math.min(params.limit ?? 40, 100);
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      asset_id: string | null;
      brand_id: string | null;
      modality: string;
      category: string | null;
      url: string;
      start_sec: number | null;
      end_sec: number | null;
      similarity: number;
    }>
  >(
    `SELECT id, asset_id, brand_id, modality, category, url, start_sec, end_sec,
            1 - (embedding <=> $1::vector) AS similarity
     FROM asset_embeddings
     WHERE ($2::uuid IS NULL OR brand_id = $2::uuid)
       AND ($3::text IS NULL OR modality = $3)
       AND ($4::text IS NULL OR category = $4)
     ORDER BY embedding <=> $1::vector
     LIMIT ${limit}`,
    vec,
    params.brandId ?? null,
    params.modality ?? null,
    params.category ?? null,
  );
  type Row = {
    id: string;
    asset_id: string | null;
    brand_id: string | null;
    modality: string;
    category: string | null;
    url: string;
    start_sec: number | null;
    end_sec: number | null;
    similarity: number;
  };
  return (rows as Row[]).map((r: Row): SemanticHit => ({
    id: r.id,
    assetId: r.asset_id,
    brandId: r.brand_id,
    modality: r.modality,
    category: r.category,
    url: r.url,
    startSec: r.start_sec,
    endSec: r.end_sec,
    similarity: Number(r.similarity),
  }));
}
