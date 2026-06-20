// LightRAG query client.
//
// LightRAG is a knowledge graph server built on Neo4j + a vector store. We
// call its `/query` endpoint with `only_need_context=true` so it returns the
// assembled context text WITHOUT running its own LLM synthesis — we only need
// the raw context to feed back into OpenClaw's agent.

import type {
  LightRAGQueryMode,
  LightRAGQueryResult,
  LightRAGReference,
} from "./types.js";

interface LightRAGResponsePayload {
  /** Assembled context. Newer builds may use `context`; we accept both. */
  response?: string;
  context?: string;
  /** Structured source references (LightRAG ≥ 1.4.5). */
  references?: unknown;
}

/**
 * Parse the `references` field of a LightRAG response into a clean list.
 *
 * Mirrors the production gold-eval extractor: keep only dict entries with a
 * non-empty string `file_path`; anything malformed is silently dropped (the
 * references are a best-effort enrichment, never a hard dependency). Returns
 * `[]` for older servers that omit the field entirely, which preserves the
 * pre-3.2.8 behavior end-to-end.
 *
 * @internal exported for unit testing
 */
export function parseLightRAGReferences(raw: unknown): LightRAGReference[] {
  if (!Array.isArray(raw)) return [];
  const out: LightRAGReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const fp = rec.file_path;
    if (typeof fp !== "string" || fp.length === 0) continue;
    const ref: LightRAGReference = { file_path: fp };
    if (typeof rec.reference_id === "string" && rec.reference_id.length > 0) {
      ref.reference_id = rec.reference_id;
    }
    out.push(ref);
  }
  return out;
}

/**
 * Query a LightRAG server for context relevant to `query`.
 *
 * Modes:
 * - `naive`  — simple vector similarity on chunks
 * - `local`  — entity-neighbourhood traversal
 * - `global` — community summaries
 * - `hybrid` — local + global (recommended default)
 *
 * Returns the assembled `context` plus the structured source `references`
 * (empty on servers that don't emit them). The references enable provenance
 * source-attribution; the caller decides whether/how to surface them.
 *
 * @throws Error on any non-OK HTTP response, with the first 200 chars of the
 *         error body for debugging.
 */
export async function queryLightRAG(
  url: string,
  apiKey: string,
  query: string,
  mode: LightRAGQueryMode = "hybrid",
): Promise<LightRAGQueryResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const resp = await fetch(`${url}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      mode,
      only_need_context: true,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `LightRAG query failed (${resp.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as LightRAGResponsePayload;
  return {
    context: data.response ?? data.context ?? "",
    references: parseLightRAGReferences(data.references),
  };
}

/**
 * Truncate text to `maxChars` without cutting mid-sentence when possible.
 * Falls back to a raw character cut if no sentence boundary is found in the
 * second half of the allowed window.
 */
export function truncateLightRAG(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.5
    ? truncated.slice(0, lastPeriod + 1)
    : truncated;
}

/**
 * Convenience wrapper used by the hook handler: trim the context, truncate
 * it to the configured budget, and return `null` if nothing remains.
 */
export function formatLightRAGResults(
  rawContext: string,
  maxChars: number,
): { truncated: string; originalLength: number } | null {
  const context = rawContext.trim();
  if (context.length === 0) return null;

  return {
    truncated: truncateLightRAG(context, maxChars),
    originalLength: context.length,
  };
}
