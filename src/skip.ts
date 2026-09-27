// Pre-router skip stage (4.0.0).
//
// Runs on EVERY deployment (router enabled or not), before any network
// call, and answers one question: "is this turn a human asking something?"
// Non-human turns never need document retrieval:
//
//   - sub-agent sessions (`sessions_spawn` children, `...:subagent:<id>`) and
//     the active-memory recall sub-agent (`...:active-memory:<hash>`);
//   - non-conversational triggers: heartbeat, cron, memory flush, and
//     `manual` (host-initiated runs such as the active-memory recall,
//     session companion, compaction and setup assistants);
//   - typed non-human input: `ctx.inputProvenance.kind` is `inter_session`
//     (sessions_send, subagent announce / settle) or `internal_system`
//     (exec completions, background task wakes, restart recovery...). The
//     host documents that `trigger === "user"` does NOT prove human origin
//     for these (docs/plugins/hooks/prompt-and-session.md);
//   - whole-message acknowledgements ("merci", "ok parfait", "oui vas-y").
//
// Absent provenance is treated as human: the host omits it on some ordinary
// human paths, so treating absence as non-human would break retrieval.

import { isAcknowledgement } from "./router/heuristic.js";
import type { RouterReason } from "./router/types.js";
import type { PluginHookAgentContext, ResolvedSkipConfig } from "./types.js";

export interface SkipVerdict {
  reason: RouterReason;
  /** Short, content-free detail for the event line (pattern / trigger / kind). */
  detail?: string;
}

/** The only provenance kind that denotes a human sender. */
const HUMAN_PROVENANCE_KIND = "external_user";

/**
 * Decide whether retrieval must be skipped for this turn. Returns `null`
 * when the turn is eligible. `query` is the already-extracted user text.
 */
export function evaluateSkip(
  skip: ResolvedSkipConfig,
  ctx: PluginHookAgentContext | undefined,
  query: string,
): SkipVerdict | null {
  const sessionKey = ctx?.sessionKey ?? "";
  if (sessionKey) {
    const lower = sessionKey.toLowerCase();
    const pattern = skip.sessionPatterns.find(
      (p) => p.length > 0 && lower.includes(p.toLowerCase()),
    );
    if (pattern) return { reason: "skip_subagent_session", detail: pattern };
  }

  const trigger = ctx?.trigger;
  if (trigger && skip.triggers.includes(trigger)) {
    // Same reason name as the pre-4.0 router heuristic so dashboards keep
    // counting trigger skips under one label.
    return { reason: "heuristic_trigger", detail: trigger };
  }

  if (skip.nonHumanInput) {
    const provenance = ctx?.inputProvenance;
    const kind = typeof provenance?.kind === "string" ? provenance.kind : undefined;
    if (kind && kind !== HUMAN_PROVENANCE_KIND) {
      const sourceTool = provenance?.sourceTool;
      if (!(sourceTool && skip.allowSourceTools.includes(sourceTool))) {
        return {
          reason: "skip_non_human_input",
          detail: sourceTool ? `${kind}:${sourceTool}` : kind,
        };
      }
    }
  }

  if (skip.acknowledgements && isAcknowledgement(query)) {
    return { reason: "heuristic_ack" };
  }

  return null;
}
