// LightRAG query client.
//
// LightRAG is a knowledge graph server built on Neo4j + a vector store. We
// call its `/query` endpoint with `only_need_context=true` so it returns the
// assembled context text WITHOUT running its own LLM synthesis — we only need
// the raw context to feed back into OpenClaw's agent.

import type { LightRAGQueryMode } from "./types.js";

interface LightRAGResponsePayload {
  response: string;
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
 * @throws Error on any non-OK HTTP response, with the first 200 chars of the
 *         error body for debugging.
 */
export async function queryLightRAG(
  url: string,
  apiKey: string,
  query: string,
  mode: LightRAGQueryMode = "hybrid",
): Promise<string> {
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
  return data.response ?? "";
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
