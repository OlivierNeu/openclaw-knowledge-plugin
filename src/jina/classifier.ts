// Jina Classifier client.
//
// Wraps POST /v1/classify in both modes:
//
//   - **zero-shot**  — caller supplies `labels`; Jina embeds them on the fly
//                       and matches against the input. Up to 256 classes.
//                       Stateless.
//
//   - **few-shot**   — caller supplies a `classifier_id` from a prior
//                       training run. The plugin does NOT implement training
//                       (/v1/train) — that is an explicit out-of-band step
//                       performed via the Jina Playground or a one-off
//                       script. Rationale: training is a rare, deliberate
//                       act; baking it into the plugin would invite
//                       accidental retraining on every plugin reload.
//
// Defensive response parsing:
// Jina has historically used several field names for the predicted label
// across docs revisions: `predictions[0].label`, `predictions[0].prediction`,
// `label`, `prediction`. The parser tries each known path in turn and falls
// back to `null` if none matches (callers treat `null` like a Jina outage
// → fail-open route).

import { postJson } from "./client.js";
import type { RpmMonitor } from "./rate-limit.js";
import type {
  ClassificationOutcome,
  ClassifierEmbeddingModel,
  ClassifierTextInput,
  JinaClassifyFewShotRequest,
  JinaClassifyZeroShotRequest,
} from "./types.js";

const CLASSIFY_URL = "https://api.jina.ai/v1/classify";

/** Defaults aligned with the plugin's "no-config" mode. */
const DEFAULT_CLASSIFIER_MODEL: ClassifierEmbeddingModel = "jina-embeddings-v3";

// ---------------------------------------------------------------------------
// Zero-shot
// ---------------------------------------------------------------------------

export interface ZeroShotClassifyParams {
  apiKey: string;
  text: string;
  labels: string[];
  model?: ClassifierEmbeddingModel;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional RPM monitor (forwarded to {@link postJson}). @since 3.2.4 */
  rpmMonitor?: RpmMonitor;
}

/**
 * Classify `text` against a list of semantic labels.
 *
 * Returns `null` when:
 *   - the response shape is unexpected (Jina rev mismatch),
 *   - the predicted label does not exactly match any provided label (we
 *     refuse to invent a class — the router should treat this as "unknown").
 *
 * Throws on network / API errors so the caller's circuit breaker can react.
 */
export async function classifyZeroShot({
  apiKey,
  text,
  labels,
  model = DEFAULT_CLASSIFIER_MODEL,
  timeoutMs,
  signal,
  rpmMonitor,
}: ZeroShotClassifyParams): Promise<ClassificationOutcome | null> {
  if (labels.length < 2) {
    // Jina rejects requests with fewer than 2 labels; surface a clearer
    // error than the upstream's generic 400.
    throw new Error("classifyZeroShot: at least 2 labels are required");
  }

  const body: JinaClassifyZeroShotRequest = {
    model,
    input: [{ text }] as ClassifierTextInput[],
    labels,
  };

  const raw = await postJson<JinaClassifyZeroShotRequest>({
    url: CLASSIFY_URL,
    body,
    apiKey,
    timeoutMs,
    signal,
    rpmMonitor,
  });

  return parseClassificationResponse(raw, labels);
}

// ---------------------------------------------------------------------------
// Few-shot
// ---------------------------------------------------------------------------

export interface FewShotClassifyParams {
  apiKey: string;
  text: string;
  classifierId: string;
  /**
   * Optional whitelist used by the defensive parser to verify that the
   * returned label is one the caller expects. When omitted, any non-empty
   * string returned by Jina is accepted (caller knows what was trained).
   */
  expectedLabels?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional RPM monitor (forwarded to {@link postJson}). @since 3.2.4 */
  rpmMonitor?: RpmMonitor;
}

/**
 * Classify `text` using a pre-trained few-shot classifier identified by
 * `classifierId`. Same `null`-vs-throw contract as `classifyZeroShot`.
 */
export async function classifyFewShot({
  apiKey,
  text,
  classifierId,
  expectedLabels,
  timeoutMs,
  signal,
  rpmMonitor,
}: FewShotClassifyParams): Promise<ClassificationOutcome | null> {
  if (!classifierId) {
    throw new Error("classifyFewShot: classifierId is required");
  }

  const body: JinaClassifyFewShotRequest = {
    classifier_id: classifierId,
    input: [{ text }] as ClassifierTextInput[],
  };

  const raw = await postJson<JinaClassifyFewShotRequest>({
    url: CLASSIFY_URL,
    body,
    apiKey,
    timeoutMs,
    signal,
    rpmMonitor,
  });

  return parseClassificationResponse(raw, expectedLabels);
}

// ---------------------------------------------------------------------------
// Defensive response parser
// ---------------------------------------------------------------------------

/**
 * Extract the predicted label + optional score from a Classifier response.
 *
 * Known shapes (in order tried):
 *   1. `{ data: [ { predictions: [ { label, score } ] } ] }`
 *   2. `{ results: [ { label, score } ] }`
 *   3. `{ data: [ { label, score } ] }`
 *   4. `{ data: [ { prediction, confidence } ] }`
 *
 * The first match wins. When `allowedLabels` is provided, the picked label
 * MUST be an exact (case-sensitive) member — otherwise we return `null` and
 * the caller falls back to its safe default (the router treats `null` like
 * an outage).
 *
 * @internal exported only for unit testing
 */
export function parseClassificationResponse(
  raw: unknown,
  allowedLabels?: string[],
): ClassificationOutcome | null {
  const candidates = extractCandidates(raw);

  for (const candidate of candidates) {
    const label = candidate.label;
    if (typeof label !== "string" || label.length === 0) continue;

    if (allowedLabels && allowedLabels.length > 0 && !allowedLabels.includes(label)) {
      // Silent skip — Jina occasionally hallucinates a "best" label that
      // is not in the input set. We never invent a class.
      continue;
    }

    return {
      label,
      score: typeof candidate.score === "number" ? candidate.score : null,
    };
  }

  return null;
}

interface ParsedCandidate {
  label: unknown;
  score: unknown;
}

function extractCandidates(raw: unknown): ParsedCandidate[] {
  if (!isRecord(raw)) return [];

  const candidates: ParsedCandidate[] = [];

  // Shape #1: data[].predictions[] — newer Jina docs. Falls through when
  // `predictions` is empty so the same payload can still be parsed via
  // shape #3 (data[] flat) below.
  if (Array.isArray(raw.data) && raw.data.length > 0) {
    const first = raw.data[0];
    if (isRecord(first) && Array.isArray(first.predictions)) {
      for (const p of first.predictions) {
        if (!isRecord(p)) continue;
        candidates.push({
          label: p.label ?? p.prediction,
          score: p.score ?? p.confidence,
        });
      }
    }
  }

  // Shape #2: results[] — older docs / few-shot path.
  if (Array.isArray(raw.results)) {
    for (const r of raw.results) {
      if (!isRecord(r)) continue;
      candidates.push({
        label: r.label ?? r.prediction,
        score: r.score ?? r.confidence,
      });
    }
  }

  // Shape #3 & #4: data[] flat — `{label, score}` or `{prediction, confidence}`.
  if (Array.isArray(raw.data)) {
    for (const d of raw.data) {
      if (!isRecord(d)) continue;
      // Only push if at least one of the recognized keys is present, to
      // avoid duplicating the predictions[] entries already captured above
      // when both shapes are present on the same record.
      if (
        d.label !== undefined ||
        d.prediction !== undefined ||
        d.score !== undefined ||
        d.confidence !== undefined
      ) {
        candidates.push({
          label: d.label ?? d.prediction,
          score: d.score ?? d.confidence,
        });
      }
    }
  }

  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
