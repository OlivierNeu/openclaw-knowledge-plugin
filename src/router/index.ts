// Router orchestrator: heuristic → classifier (optional) → fallback.
//
// Public entry point is `decideRoute(...)`. It produces a `RouterDecision`
// the hook handler consumes to gate calls to pgvector / LightRAG.
//
// Design contract (fail-open):
//   - Any error in the classifier MUST yield `ALL` so retrieval keeps
//     working. The router never blocks the agent.
//   - The classifier is only called when the heuristic returns `null`
//     (ambiguous input). Heuristic hits are deterministic and free.
//   - Classifier results that don't map to a known label fall back to
//     `ALL` with reason `"classifier_fallback"`.

import {
  classifyFewShot,
  classifyZeroShot,
} from "../jina/classifier.js";
import { JinaError } from "../jina/errors.js";
import {
  DEFAULT_ROUTER_LABELS,
  ROUTER_LABEL_NAMES,
  extractRouteFromLabel,
} from "./labels.js";
import { heuristicRoute } from "./heuristic.js";
import type { Route, RouterDecision } from "./types.js";

export interface RouterConfig {
  /** Master switch. When false, every call returns `{route: "ALL"}`. */
  enabled: boolean;
  /** Which engine fills the gap when heuristics are ambiguous. */
  mode: "heuristic" | "jina-classifier";
  /** Jina API key — required when mode === "jina-classifier". */
  jinaApiKey: string;
  /**
   * Optional few-shot classifier ID. When provided, the router calls
   * `/v1/classify` with this ID instead of running zero-shot.
   */
  classifierId?: string;
  /** Labels for zero-shot classification. Defaults to {@link DEFAULT_ROUTER_LABELS}. */
  labels?: readonly string[];
  /** Triggers that bypass retrieval (subset of NON_USER_TRIGGERS). */
  skipTriggers?: readonly string[];
}

export interface RouterRuntimeContext {
  query: string;
  trigger?: string;
  /** Whether the sender is the local CLI test harness. */
  isCli?: boolean;
  /** Optional AbortSignal propagated to the classifier HTTP call. */
  signal?: AbortSignal;
}

const FALLBACK: Route = "ALL";

/**
 * Decide the route for one user turn.
 *
 * Returns a {@link RouterDecision}. The plugin caller logs `reason` and
 * uses `route` to gate source calls.
 */
export async function decideRoute(
  cfg: RouterConfig,
  ctx: RouterRuntimeContext,
): Promise<RouterDecision> {
  // 0. Disabled → preserve legacy behavior.
  if (!cfg.enabled) {
    return { route: "ALL", reason: "router_disabled", score: null };
  }

  // 1. Heuristic pass — cheap and deterministic.
  const verdict = heuristicRoute({
    query: ctx.query,
    trigger: ctx.trigger,
    isCli: ctx.isCli,
  });
  if (verdict.route !== null) {
    return { route: verdict.route, reason: verdict.reason, score: null };
  }

  // 2. Classifier pass — only when heuristics were ambiguous.
  if (cfg.mode === "heuristic") {
    // Operator asked for heuristic-only routing; ambiguous → ALL.
    return { route: FALLBACK, reason: "classifier_fallback", score: null };
  }

  if (!cfg.jinaApiKey) {
    // Misconfiguration safety net — never crash, just fall back.
    return { route: FALLBACK, reason: "classifier_fallback", score: null };
  }

  try {
    const outcome = cfg.classifierId
      ? await classifyFewShot({
          apiKey: cfg.jinaApiKey,
          text: ctx.query,
          classifierId: cfg.classifierId,
          expectedLabels: ROUTER_LABEL_NAMES as string[],
          signal: ctx.signal,
        })
      : await classifyZeroShot({
          apiKey: cfg.jinaApiKey,
          text: ctx.query,
          labels: (cfg.labels ?? DEFAULT_ROUTER_LABELS) as string[],
          signal: ctx.signal,
        });

    if (!outcome) {
      return { route: FALLBACK, reason: "classifier_fallback", score: null };
    }

    const routeName =
      // Few-shot classifiers return the raw label name as trained; zero-shot
      // returns the full descriptive label — strip the colon prefix.
      cfg.classifierId
        ? outcome.label
        : (extractRouteFromLabel(outcome.label) ?? outcome.label);

    if (!isKnownRoute(routeName)) {
      return { route: FALLBACK, reason: "classifier_fallback", score: outcome.score };
    }

    return {
      route: routeName,
      reason: "classifier_hit",
      score: outcome.score,
    };
  } catch (err) {
    // Re-throw non-Jina errors (programmer errors, type mismatches). Jina
    // failures fail open.
    if (!(err instanceof JinaError)) throw err;
    return { route: FALLBACK, reason: "classifier_error", score: null };
  }
}

function isKnownRoute(value: string): value is Route {
  return (
    value === "NONE" ||
    value === "PGVECTOR_ONLY" ||
    value === "LIGHTRAG_ONLY" ||
    value === "ALL"
  );
}
