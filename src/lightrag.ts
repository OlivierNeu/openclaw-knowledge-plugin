// LightRAG query client.
//
// LightRAG is a knowledge graph server built on Neo4j + a vector store. We
// call its `/query` endpoint with `only_need_context=true` so it returns the
// assembled context text WITHOUT running its own LLM synthesis — we only need
// the raw context to feed back into OpenClaw's agent.

import type { LightRAGQueryMode } from "./types.js";

interface LightRAGResponsePayload {
  response?: string;
  context?: string;
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
  mode: LightRAGQueryMode | undefined,
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
      mode: mode ?? "hybrid",
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

  const data = (await resp.json()) as LightRAGResponsePayload | string;

  // LightRAG's response shape varies between versions: older builds return a
  // plain string, newer ones return `{response: "..."}`, and a few return
  // `{context: "..."}`. Normalise to a single string here.
  if (typeof data === "string") return data;
  return data.response ?? data.context ?? "";
}

/**
 * Truncate LightRAG context to `maxChars` without cutting mid-sentence when
 * possible. Falls back to a raw character cut if no sentence boundary is
 * found in the second half of the allowed window.
 */
export function truncateLightRAG(
  text: string | null | undefined,
  maxChars: number,
): string | null | undefined {
  if (text == null || text === "") return text;
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
  rawContext: unknown,
  maxChars: number,
): { truncated: string; originalLength: number } | null {
  const context = typeof rawContext === "string" ? rawContext.trim() : "";
  if (context.length === 0) return null;

  const truncated = truncateLightRAG(context, maxChars) ?? "";
  return { truncated, originalLength: context.length };
}
