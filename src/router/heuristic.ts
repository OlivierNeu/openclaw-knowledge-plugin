// Zero-cost router heuristics.
//
// Runs BEFORE any Jina call. Three jobs:
//
//   1. **Deterministic skip on operational triggers.** When OpenClaw fires
//      `before_prompt_build` with `ctx.trigger ∈ {heartbeat, cron, memory}`,
//      we know the turn is not a real user question — skip retrieval
//      unconditionally. This is the cheapest and most important gain:
//      heartbeats fire continuously and were eating ~95% of the previous
//      Jina quota.
//
//   2. **Meta-agent regex matches.** Questions like "what is your session
//      id" or "combien d'agents ici" cannot be answered by the knowledge
//      base, so we skip them deterministically too.
//
//   3. **Keyword fast-paths for common business questions.** A small set of
//      regex hints lets the heuristic decide on its own (PGVECTOR_ONLY vs
//      LIGHTRAG_ONLY) without paying for a Jina call. The router falls back
//      to the classifier — or to `ALL` — when nothing matches.
//
// Everything in this module is pure (no I/O, no side effects) so the tests
// can exhaustively cover the matrix.

import type { Route, RouterReason } from "./types.js";

/**
 * Triggers from the OpenClaw SDK that mean "not a user-initiated turn".
 *
 * Sourced from `PluginHookAgentContext.trigger` in the OpenClaw plugin SDK:
 * `"user" | "heartbeat" | "cron" | "memory"`.
 */
export const NON_USER_TRIGGERS = new Set(["heartbeat", "cron", "memory"]);

// ---------------------------------------------------------------------------
// Meta-agent questions — skip entirely
// ---------------------------------------------------------------------------

const META_PATTERNS: RegExp[] = [
  // Identifiant/Id de session, session id, runId, agent id
  /\b(?:session\s*id|runid|run\s*id|identifiant\s+(?:de\s+)?session|sessions?\s*identifi(?:ant|cation))\b/i,
  // Combien d'agents/subagents
  /\bcombien\s+d['e\s]?\s*(?:sub-?)?agent/i,
  // Self-introspection "qui es-tu", "what model are you", "who are you"
  /\b(?:qui\s+es-tu|what\s+model\s+are\s+you|who\s+are\s+you|what\s+is\s+your\s+name|comment\s+t['e]appelles?-tu)\b/i,
  // Trivial system pings — the WHOLE prompt must be a status/ping check.
  // Anchored on `^` so business questions ending with the word "status"
  // (e.g. "what is the ACME project status?") are NOT classified as meta.
  // Same anchoring for the FR variants ("tu es là ?").
  /^\s*(?:(?:system|the\s+system)\s+)?(?:status|ping|heartbeat)\s*[?!.]*\s*$/i,
  /^\s*(?:are\s+you\s+(?:there|alive)|t['e]es?\s+(?:la|en\s+ligne))\s*[?!.]*\s*$/i,
];

// ---------------------------------------------------------------------------
// CLI test guards — short trivial prompts coming from `id:"cli"`
// ---------------------------------------------------------------------------

const CLI_TRIVIAL_PATTERN =
  /^\s*(?:test|test\s+de\s+(?:bon\s+)?fonctionnement|ping|hello|hi|salut|coucou|ok|yes|no|oui|non)\W*\s*$/i;

// ---------------------------------------------------------------------------
// Keyword fast-paths
// ---------------------------------------------------------------------------

const PGVECTOR_KEYWORDS: RegExp[] = [
  /\bversion\b/i,
  /\brelease\s+notes?\b/i,
  /\bchangelog\b/i,
  /\bsource\s+(?:document|file|pdf|markdown)\b/i,
  /\b\w+\.(?:md|pdf|yaml|yml|json|ts|js|py|sh)\b/i, // file name with extension
];

const LIGHTRAG_KEYWORDS: RegExp[] = [
  /\bcompare\w*\b/i,
  /\baudit\b/i,
  /\bsynth[éè]se\b/i,
  /\brelations?\s+entre\b/i,
  /\bqui\s+(?:travaille|collabore|coach|forme)\s+(?:avec|pour|chez)\b/i,
  /\bdifferent\w*\s+(?:entre|de)\b/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HeuristicInput {
  /** The extracted user query (already trimmed and length-validated). */
  query: string;
  /** Trigger from `PluginHookAgentContext`. May be undefined on legacy SDKs. */
  trigger?: string;
  /** Whether the sender is the local CLI test harness (id: "cli"). */
  isCli?: boolean;
}

export interface HeuristicVerdict {
  route: Route | null;
  reason: RouterReason;
}

/**
 * Decide a route from cheap signals only. Returns `route: null` when the
 * input is ambiguous and a classifier (or `ALL` fallback) should take over.
 *
 * The returned `reason` always identifies the rule that fired (or
 * `"classifier_fallback"` if no rule did — yes that's reused, but a `null`
 * route forces the caller to consult the classifier or fall back).
 */
export function heuristicRoute(input: HeuristicInput): HeuristicVerdict {
  const { query, trigger, isCli } = input;

  // 1. Operational trigger → NEVER call any source.
  if (trigger && NON_USER_TRIGGERS.has(trigger)) {
    return { route: "NONE", reason: "heuristic_trigger" };
  }

  // 2. Meta-agent question → NEVER call any source.
  for (const re of META_PATTERNS) {
    if (re.test(query)) {
      return { route: "NONE", reason: "heuristic_meta" };
    }
  }

  // 3. CLI trivial prompt → NEVER call any source. Restricted to CLI to
  //    avoid blocking legitimate-but-short collaborator questions.
  if (isCli && CLI_TRIVIAL_PATTERN.test(query)) {
    return { route: "NONE", reason: "heuristic_short" };
  }

  // 4. Keyword fast-paths.
  if (PGVECTOR_KEYWORDS.some((re) => re.test(query))) {
    return { route: "PGVECTOR_ONLY", reason: "heuristic_keyword" };
  }
  if (LIGHTRAG_KEYWORDS.some((re) => re.test(query))) {
    return { route: "LIGHTRAG_ONLY", reason: "heuristic_keyword" };
  }

  // 5. Nothing fired — defer to the classifier (or fallback to ALL).
  return { route: null, reason: "classifier_fallback" };
}
