/**
 * Ollama embedding client.
 * Calls the local Ollama HTTP API to generate vector embeddings.
 * Model: nomic-embed-text (384 dimensions)
 */

export const EMBEDDING_DIMENSIONS = 384;

export interface EmbedResult {
  embedding: number[];
  model: string;
}

export class Embedder {
  private url: string;
  private model: string;

  constructor(ollamaUrl: string = "http://localhost:11434", model: string = "nomic-embed-text") {
    this.url = ollamaUrl.replace(/\/$/, "");
    this.model = model;
  }

  /** Generate embedding for a single text */
  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embed failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  /** Generate embeddings for multiple texts in a single call */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embed batch failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  /** Check if Ollama is running and the model is available */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.url}/api/tags`);
      if (!res.ok) return { ok: false, error: `Ollama returned ${res.status}` };

      const data = (await res.json()) as { models: Array<{ name: string }> };
      const hasModel = data.models.some((m) => m.name.startsWith(this.model));

      if (!hasModel) {
        return { ok: false, error: `Model '${this.model}' not found. Run: ollama pull ${this.model}` };
      }

      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Cannot reach Ollama at ${this.url}: ${msg}` };
    }
  }
}
