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
  // Open WebUI automatic background prompts — Open WebUI re-uses the
  // same chat thread to ask the LLM for a title, tags, follow-up
  // questions, or a summary after every assistant turn. Successive
  // code-review iterations rejected weaker signals:
  //   - Codex #28: verb alone (Generate/Suggest/Create) matches real
  //     prompts like "Create a migration plan from the docs".
  //   - Codex #29: structural triple `### Task:` + `### Output:` +
  //     `JSON format: {` matches power-user structured extraction.
  //   - Codex #30: even the four canonical OWUI keys (title / tags /
  //     follow_ups / summary) match real tasks like "Summarize the
  //     documents with JSON format: { summary: ... }".
  //   - Codex #31: just `### Task:` + `<chat_history>…</chat_history>`
  //     matches a user asking to ANALYZE the OWUI template itself.
  //
  // To converge, we stack FOUR OWUI-specific structural markers so a
  // hand-written prompt would have to mimic the EXACT OWUI shape to
  // be falsely classified:
  //
  //   1. `### Task:`           at the START of the prompt (anchored)
  //   2. `### Output:`          OWUI directive header
  //   3. `### Chat History:`    OWUI section header (literal, not the
  //                             generic XML tag — a user analyzing
  //                             the OWUI template typically pastes
  //                             only `<chat_history>` without the
  //                             section header preceding it)
  //   4. `<chat_history>…</chat_history>` block — and it MUST sit at
  //                             the END of the prompt (`\s*$`). OWUI
  //                             auto-prompts terminate exactly there;
  //                             a user analyzing the template almost
  //                             always appends a question / "explain"
  //                             AFTER the closing tag, defeating the
  //                             end anchor.
  //
  // The middle expansions are bounded (`{1,16000}`, `{1,4000}?`,
  // `{0,32000}`) to keep the regex engine linear on malformed input.
  // 16 KB covers the longest OWUI Guidelines block; 4 KB covers the
  // Output + Examples section; 32 KB covers realistic chat history
  // payloads (OWUI defaults to the last 6 messages).
  /^\s*###\s*Task:[\s\S]{1,16000}\n###\s*Output:[\s\S]{1,4000}?\n###\s*Chat\s+History:\s*\n<chat_history>[\s\S]{0,32000}<\/chat_history>\s*$/i,
];

// ---------------------------------------------------------------------------
// CLI test guards — short trivial prompts coming from `id:"cli"`
// ---------------------------------------------------------------------------

const CLI_TRIVIAL_PATTERN =
  /^\s*(?:test|test\s+de\s+(?:bon\s+)?fonctionnement|ping|hello|hi|salut|coucou|ok|yes|no|oui|non)\W*\s*$/i;

// ---------------------------------------------------------------------------
// Acknowledgements — whole-message greetings / thanks / confirmations (4.0.0)
// ---------------------------------------------------------------------------

// One acknowledgement token (FR + EN). Multi-word entries are listed before
// their prefixes so the alternation prefers the longest match.
const ACK_TOKENS: readonly string[] = [
  // thanks
  String.raw`merci(?:\s+(?:beaucoup|bien|infiniment|encore|à\s+toi|a\s+toi|à\s+vous|a\s+vous))?`,
  String.raw`thank\s+you(?:\s+(?:so\s+much|very\s+much))?`,
  String.raw`thanks(?:\s+a\s+lot)?`,
  "thx",
  // confirmations
  String.raw`d['’]\s?accord`,
  "dac",
  "okok",
  "oki",
  "ok(?:ay|ey)?",
  "oui",
  "ouais",
  "yes",
  "yep",
  "yup",
  "yeah",
  "non",
  "nope",
  "no",
  String.raw`vas[\s-]?y`,
  String.raw`allez[\s-]?y`,
  String.raw`go(?:\s+ahead)?`,
  String.raw`c['’]\s?est\s+(?:bon|parfait|top|noté|note|ok|clair)`,
  String.raw`[çc]a\s+marche`,
  String.raw`bien\s+re[çc]u`,
  "parfait",
  "super",
  "g[ée]nial",
  "top",
  "cool",
  "nickel",
  "impeccable",
  "excellent",
  "bravo",
  "great",
  "nice",
  "perfect",
  "awesome",
  "sure",
  "noted",
  "compris",
  "entendu",
  "not[ée]",
  "re[çc]u",
  String.raw`sounds\s+good`,
  String.raw`got\s+it`,
  // greetings
  "bonjour",
  "bonsoir",
  "salut",
  "coucou",
  "hello",
  "hi",
  "hey",
  String.raw`good\s+(?:morning|evening|afternoon)`,
];

const ACK_TOKEN = `(?:${ACK_TOKENS.join("|")})`;

// Trailing decoration: punctuation, whitespace and a few emoji
// (Extended_Pictographic + variation selector / ZWJ / skin tones). Bounded
// repetition keeps the regex linear on any input.
const ACK_TAIL = String.raw`[\s!.?…,;:)(~*-]*(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}][\s!.?…]*){0,8}`;

const ACK_PATTERN = new RegExp(
  String.raw`^${ACK_TOKEN}(?:[\s,!.]+${ACK_TOKEN}){0,3}${ACK_TAIL}$`,
  "iu",
);

/** Upper bound on the length of a message considered for ack matching. */
export const ACK_MAX_LENGTH = 48;

/**
 * True when the WHOLE message is a greeting, thanks or short confirmation
 * ("merci", "ok parfait", "oui vas-y 👍", "thanks!"). Anchored on both ends
 * and length-bounded: any real question that merely contains these words is
 * NOT an acknowledgement.
 *
 * @since 4.0.0
 */
export function isAcknowledgement(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > ACK_MAX_LENGTH) return false;
  return ACK_PATTERN.test(trimmed);
}

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
