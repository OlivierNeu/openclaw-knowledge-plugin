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
import type { RpmMonitor } from "../jina/rate-limit.js";
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
  /**
   * Which engine fills the gap when heuristics are ambiguous.
   * `jina-classifier-parallel` classifies exactly like `jina-classifier`;
   * the parallelism (speculative source launch) lives in the hook handler.
   */
  mode: "heuristic" | "jina-classifier" | "jina-classifier-parallel";
  /** Timeout for the classify HTTP call in ms (client default 8000). @since 4.0.0 */
  timeoutMs?: number;
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
  /**
   * Minimum classifier confidence (cosine similarity in `[0, 1]`) required
   * to trust a classifier prediction. When `outcome.score` is below this
   * threshold, the router fails open to `ALL` with reason
   * `"classifier_low_confidence"` rather than acting on a noisy decision.
   *
   * Optional in the public interface so external JS callers that pre-date
   * v3.2.2 still benefit from the guard via {@link DEFAULT_MIN_CONFIDENCE}.
   * The internal call site in `src/index.ts` always passes a resolved,
   * clamped value (see `ResolvedKnowledgeConfig.routerMinConfidence`).
   *
   * Rationale: Jina v3 zero-shot scores cluster around 0.25 when none of
   * the labels actually match the query. Acting on those quasi-random
   * predictions (especially `NONE`) silently blocks legitimate retrieval.
   * Trusting only confident scores keeps the gate fail-safe.
   */
  minConfidence?: number;
  /**
   * Optional callback fired AFTER a successful Jina `/v1/classify` call
   * with payload-level numbers (duration, model). The plugin uses it to
   * emit a `jina` usage event so dashboards can track classify spend
   * per turn independently of the router decision.
   *
   * @since 3.2.4
   */
  onClassifierUsage?: (usage: {
    durationMs: number;
    model: "zero-shot" | "few-shot";
  }) => void;
  /** Optional RPM monitor (forwarded to the Jina client). @since 3.2.4 */
  rpmMonitor?: RpmMonitor;
}

/**
 * Default applied by {@link decideRoute} when a caller omits
 * `minConfidence` (e.g. older JS plugins that haven't migrated to the
 * 3.2.2 shape). Matches the production default in `src/config.ts` —
 * keep both constants in sync.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.35;

/** Clamp a finite number into `[0, 1]`. Non-finite values fall back to `0`. */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
  const early = decideRouteWithoutClassifier(cfg, ctx);
  if (early !== null) return early;
  return classifyRoute(cfg, ctx);
}

/**
 * Synchronous first half of {@link decideRoute}: returns the decision when
 * it can be made without the network (router disabled, heuristic hit,
 * heuristic-only mode, missing key), or `null` when the Jina classifier must
 * be consulted. Lets the hook launch sources speculatively in parallel with
 * the classifier (`jina-classifier-parallel`).
 *
 * @since 4.0.0
 */
export function decideRouteWithoutClassifier(
  cfg: RouterConfig,
  ctx: RouterRuntimeContext,
): RouterDecision | null {
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
  return null;
}

/**
 * Network half of {@link decideRoute}: consult the Jina classifier. Callers
 * must only invoke it when {@link decideRouteWithoutClassifier} returned
 * `null`. Fails open to `ALL` on every Jina error.
 *
 * @since 4.0.0
 */
export async function classifyRoute(
  cfg: RouterConfig,
  ctx: RouterRuntimeContext,
): Promise<RouterDecision> {
  // Normalize the confidence threshold once at function entry so the
  // low-confidence guard applies uniformly to every caller, including
  // external JS plugins that may pass an undefined / out-of-range value.
  const minConfidence = clampConfidence(cfg.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
  try {
    const startedAt = Date.now();
    const outcome = cfg.classifierId
      ? await classifyFewShot({
          apiKey: cfg.jinaApiKey,
          text: ctx.query,
          classifierId: cfg.classifierId,
          expectedLabels: ROUTER_LABEL_NAMES as string[],
          timeoutMs: cfg.timeoutMs,
          signal: ctx.signal,
          rpmMonitor: cfg.rpmMonitor,
        })
      : await classifyZeroShot({
          apiKey: cfg.jinaApiKey,
          text: ctx.query,
          labels: (cfg.labels ?? DEFAULT_ROUTER_LABELS) as string[],
          timeoutMs: cfg.timeoutMs,
          signal: ctx.signal,
          rpmMonitor: cfg.rpmMonitor,
        });

    if (cfg.onClassifierUsage) {
      cfg.onClassifierUsage({
        durationMs: Date.now() - startedAt,
        model: cfg.classifierId ? "few-shot" : "zero-shot",
      });
    }

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

    // Low-confidence guard: a classifier score below `minConfidence`
    // means none of the labels actually matched the query (the engine
    // just picked the least-bad one). Trusting it would silently block
    // retrieval on legitimate questions. Fail open and log the score.
    // A `null` score also fails open: when Jina omits the score field
    // we cannot prove the prediction is confident.
    if (outcome.score === null || outcome.score < minConfidence) {
      return {
        route: FALLBACK,
        reason: "classifier_low_confidence",
        score: outcome.score,
      };
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
