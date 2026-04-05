/**
 * Embedding integration for the MCP server.
 * Provides a shared embedder instance and helpers to store embeddings
 * for memory writes. Embedding is fire-and-forget — failures are logged
 * but never block the MCP response.
 */

import { Embedder, storeEmbedding, isVecAvailable } from "@mnemo/shared";
import { getDb, getConfig } from "./db.js";

let embedder: Embedder | null = null;

function getEmbedder(): Embedder {
  if (!embedder) {
    const cfg = getConfig();
    embedder = new Embedder(cfg.ollama_url, cfg.ollama_model);
  }
  return embedder;
}

/**
 * Embed text and store in vec_memory. Non-blocking, non-fatal.
 * Call this after any memory write.
 */
export function embedAndStore(
  sourceTable: string,
  sourceId: string | number,
  text: string,
  createdAt?: string
): void {
  if (!isVecAvailable()) return;

  // Fire and forget — don't await, don't block
  getEmbedder()
    .embed(text)
    .then((embedding) => {
      storeEmbedding(getDb(), sourceTable, sourceId, embedding, createdAt);
    })
    .catch(() => {
      // Silently ignore embedding failures — FTS still works
    });
}

/**
 * Generate an embedding for a query (for vector search).
 * This one IS awaited because we need the result for the search.
 */
export async function embedQuery(text: string): Promise<number[] | null> {
  if (!isVecAvailable()) return null;

  try {
    return await getEmbedder().embed(text);
  } catch {
    return null;
  }
}

/** Expose the embedder for health checks */
export function getEmbedderInstance(): Embedder {
  return getEmbedder();
}
