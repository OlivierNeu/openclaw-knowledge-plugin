// Knowledge policy resolution and session-state validation (4.0.0).
//
// Effective policy for one turn, highest priority first:
//
//   1. one-shot  — a per-prompt choice a client (Atrium) stores right before
//                  sending ONE message; consumed by the next human turn;
//   2. session   — a per-conversation override (Atrium toggle, `/knowledge`);
//   3. agent     — `config.agents[<agentId>]`;
//   4. default   — `config.defaults` (or the legacy "every enabled source,
//                  inject automatically" behavior).
//
// SECURITY INVARIANT: whatever a client writes into the session extension,
// the resolved `sources` are ALWAYS a subset of the agent's
// `allowedSources` (itself a subset of the configured, enabled sources).
// Session state is re-validated on every read — the Gateway's
// `sessions.pluginPatch` stores client JSON without asking the plugin, so
// write-time validation alone would not be enough.

import { isInjectionPolicy, isLightRAGMode } from "./config.js";
import type {
  InjectionPolicy,
  LightRAGQueryMode,
  ResolvedAgentPolicy,
  ResolvedKnowledgeConfig,
  ResolvedKnowledgeSource,
} from "./types.js";

/** Session-extension namespace owned by this plugin. */
export const POLICY_NAMESPACE = "policy";

/** Upper bound on `oneShot.expiresAfterTurns`. */
export const MAX_ONE_SHOT_TURNS = 20;

/** Maximum number of source ids accepted in one selection. */
const MAX_SELECTED_SOURCES = 16;

export type PolicyOrigin = "oneShot" | "session" | "agent" | "default";

/** A per-prompt selection (persisted until consumed). */
export interface KnowledgeOneShot {
  injection?: InjectionPolicy;
  sources?: string[];
  lightragQueryMode?: LightRAGQueryMode;
  /** Number of human turns this selection applies to. Default 1. */
  expiresAfterTurns?: number;
  /**
   * When true (default), the selection bypasses the acknowledgement filter
   * and the router for the turns it applies to: the user explicitly asked.
   */
  force?: boolean;
  /** Epoch ms when the client stored it; stale selections are ignored. */
  setAt?: number;
}

/** Persisted plugin session state (pluginExtensions["openclaw-knowledge"].policy). */
export interface KnowledgeSessionState {
  v?: 1;
  injection?: InjectionPolicy;
  sources?: string[];
  lightragQueryMode?: LightRAGQueryMode;
  oneShot?: KnowledgeOneShot;
  updatedAt?: number;
  updatedBy?: string;
  /**
   * Internal replay guard: the one-shot applied to `runId`, so a retry or
   * prompt rebuild of the SAME run keeps the user's per-prompt choice after
   * it was consumed. Never projected to clients.
   */
  lastOneShot?: KnowledgeOneShot & { runId: string };
}

export interface EffectivePolicy {
  agentId: string | undefined;
  injection: InjectionPolicy;
  sources: string[];
  lightragQueryMode?: LightRAGQueryMode;
  topK?: number;
  /** One-shot `force`: bypass acknowledgement filter + router. */
  force: boolean;
  origin: { injection: PolicyOrigin; sources: PolicyOrigin };
  /** Source ids a client may select for this agent. */
  allowedSources: string[];
  /** Whether client overrides are honoured for this agent. */
  overridesAllowed: boolean;
  /** Content-free validation notes (unknown / disallowed ids). */
  warnings: string[];
}

/**
 * A pending one-shot this turn used (or found expired). The write applies it
 * to the FRESH session row (see `applyOneShotConsumption`), never to the
 * snapshot the turn read, so a concurrent `policy.set` is not overwritten.
 */
export interface OneShotConsumption {
  /** The exact pending one-shot observed when the turn read the row. */
  shot: KnowledgeOneShot;
  expired: boolean;
  runId?: string;
}

export interface PolicyResolution {
  policy: EffectivePolicy;
  /** Pending one-shot to consume (or clear when expired), or undefined. */
  consumption?: OneShotConsumption;
  /** State after consumption, computed on the snapshot the turn read. */
  nextState?: KnowledgeSessionState;
}

// ---------------------------------------------------------------------------
// Structural sanitation (read path) — tolerant, never throws
// ---------------------------------------------------------------------------

function asIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_SELECTED_SOURCES) break;
  }
  return out;
}

function sanitizeOneShot(raw: unknown): KnowledgeOneShot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: KnowledgeOneShot = {};
  if (isInjectionPolicy(r.injection)) out.injection = r.injection;
  const sources = asIdList(r.sources);
  if (sources && sources.length > 0) out.sources = sources;
  if (isLightRAGMode(r.lightragQueryMode)) out.lightragQueryMode = r.lightragQueryMode;
  if (typeof r.expiresAfterTurns === "number" && Number.isFinite(r.expiresAfterTurns)) {
    out.expiresAfterTurns = Math.max(1, Math.min(MAX_ONE_SHOT_TURNS, Math.floor(r.expiresAfterTurns)));
  }
  if (typeof r.force === "boolean") out.force = r.force;
  if (typeof r.setAt === "number" && Number.isFinite(r.setAt)) out.setAt = r.setAt;
  if (out.injection === undefined && out.sources === undefined && out.lightragQueryMode === undefined) {
    return undefined;
  }
  return out;
}

/** Tolerant structural sanitation of whatever is stored in the session row. */
export function sanitizeSessionState(raw: unknown): KnowledgeSessionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: KnowledgeSessionState = {};
  if (isInjectionPolicy(r.injection)) out.injection = r.injection;
  const sources = asIdList(r.sources);
  if (sources && sources.length > 0) out.sources = sources;
  if (isLightRAGMode(r.lightragQueryMode)) out.lightragQueryMode = r.lightragQueryMode;
  const oneShot = sanitizeOneShot(r.oneShot);
  if (oneShot) out.oneShot = oneShot;
  if (typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt)) out.updatedAt = r.updatedAt;
  if (typeof r.updatedBy === "string" && r.updatedBy.length <= 64) out.updatedBy = r.updatedBy;
  const last = r.lastOneShot as Record<string, unknown> | undefined;
  if (last && typeof last === "object" && typeof last.runId === "string" && last.runId) {
    const shot = sanitizeOneShot(last);
    if (shot) out.lastOneShot = { ...shot, runId: last.runId.slice(0, 200) };
  }
  return out;
}

/** Client-facing projection: drops internal bookkeeping. */
export function projectSessionState(state: KnowledgeSessionState): Record<string, unknown> {
  const out: Record<string, unknown> = { v: 1 };
  if (state.injection) out.injection = state.injection;
  if (state.sources) out.sources = [...state.sources];
  if (state.lightragQueryMode) out.lightragQueryMode = state.lightragQueryMode;
  if (state.oneShot) out.oneShot = { ...state.oneShot };
  if (state.updatedAt !== undefined) out.updatedAt = state.updatedAt;
  if (state.updatedBy) out.updatedBy = state.updatedBy;
  return out;
}

// ---------------------------------------------------------------------------
// Strict validation (write path: session action, command)
// ---------------------------------------------------------------------------

export type PolicyErrorCode =
  | "invalid_payload"
  | "unknown_source"
  | "source_not_allowed"
  | "overrides_disabled";

export class PolicyValidationError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

/** Resolve the agent-level policy (agent entry or global default). */
export function agentPolicyFor(
  config: ResolvedKnowledgeConfig,
  agentId: string | undefined,
): ResolvedAgentPolicy {
  return (agentId && config.agentPolicies[agentId]) || config.defaultPolicy;
}

/** Enabled sources the agent may use, in registry order. */
export function allowedSourcesFor(
  config: ResolvedKnowledgeConfig,
  agentId: string | undefined,
): ResolvedKnowledgeSource[] {
  const allowed = agentPolicyFor(config, agentId).allowedSources;
  return config.sources.filter((src) => src.enabled && allowed.includes(src.id));
}

function validateSourceSelection(
  ids: unknown,
  config: ResolvedKnowledgeConfig,
  allowed: string[],
  field: string,
): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTED_SOURCES) {
    throw new PolicyValidationError(
      "invalid_payload",
      `${field} must be a non-empty array of at most ${MAX_SELECTED_SOURCES} source ids`,
    );
  }
  const known = new Set(config.sources.map((s) => s.id));
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new PolicyValidationError("invalid_payload", `${field} entries must be strings`);
    }
    const id = raw.trim();
    if (!known.has(id)) {
      throw new PolicyValidationError("unknown_source", `unknown source id: ${id}`, { sourceId: id });
    }
    if (!allowed.includes(id)) {
      throw new PolicyValidationError(
        "source_not_allowed",
        `source not allowed for this agent: ${id}`,
        { sourceId: id },
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Strictly validate a client patch and merge it into `current`.
 *
 * Patch fields: `injection`, `sources`, `lightragQueryMode`, `oneShot`
 * (object, or `null` to clear), `reset: true` (drop the whole override).
 * A field set to `null` clears that field. Unknown fields are rejected.
 */
export function applyPolicyPatch(
  current: KnowledgeSessionState,
  patch: unknown,
  config: ResolvedKnowledgeConfig,
  agentId: string | undefined,
  now: number,
  updatedBy: string,
): KnowledgeSessionState {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new PolicyValidationError("invalid_payload", "payload must be an object");
  }
  const agentPolicy = agentPolicyFor(config, agentId);
  if (!config.controlPlane.sessionOverrides || !agentPolicy.allowSessionOverrides) {
    throw new PolicyValidationError(
      "overrides_disabled",
      "session overrides are disabled for this agent",
    );
  }
  const allowed = allowedSourcesFor(config, agentId).map((s) => s.id);
  const p = patch as Record<string, unknown>;
  const ALLOWED_KEYS = new Set(["injection", "sources", "lightragQueryMode", "oneShot", "reset"]);
  for (const key of Object.keys(p)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new PolicyValidationError("invalid_payload", `unknown field: ${key}`);
    }
  }

  let next: KnowledgeSessionState = p.reset === true ? {} : { ...current };
  delete next.lastOneShot;

  if ("injection" in p) {
    if (p.injection === null) delete next.injection;
    else if (isInjectionPolicy(p.injection)) next.injection = p.injection;
    else throw new PolicyValidationError("invalid_payload", "injection must be auto|tool|hybrid|off");
  }
  if ("sources" in p) {
    if (p.sources === null) delete next.sources;
    else next.sources = validateSourceSelection(p.sources, config, allowed, "sources");
  }
  if ("lightragQueryMode" in p) {
    if (p.lightragQueryMode === null) delete next.lightragQueryMode;
    else if (isLightRAGMode(p.lightragQueryMode)) next.lightragQueryMode = p.lightragQueryMode;
    else {
      throw new PolicyValidationError(
        "invalid_payload",
        "lightragQueryMode must be naive|local|global|hybrid|mix",
      );
    }
  }
  if ("oneShot" in p) {
    if (p.oneShot === null) {
      delete next.oneShot;
    } else {
      const raw = p.oneShot;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new PolicyValidationError("invalid_payload", "oneShot must be an object or null");
      }
      const o = raw as Record<string, unknown>;
      const ONE_SHOT_KEYS = new Set(["injection", "sources", "lightragQueryMode", "expiresAfterTurns", "force"]);
      for (const key of Object.keys(o)) {
        if (!ONE_SHOT_KEYS.has(key)) {
          throw new PolicyValidationError("invalid_payload", `unknown oneShot field: ${key}`);
        }
      }
      const shot: KnowledgeOneShot = { setAt: now };
      if (o.injection !== undefined) {
        if (!isInjectionPolicy(o.injection)) {
          throw new PolicyValidationError("invalid_payload", "oneShot.injection must be auto|tool|hybrid|off");
        }
        shot.injection = o.injection;
      }
      if (o.sources !== undefined) {
        shot.sources = validateSourceSelection(o.sources, config, allowed, "oneShot.sources");
      }
      if (o.lightragQueryMode !== undefined) {
        if (!isLightRAGMode(o.lightragQueryMode)) {
          throw new PolicyValidationError(
            "invalid_payload",
            "oneShot.lightragQueryMode must be naive|local|global|hybrid|mix",
          );
        }
        shot.lightragQueryMode = o.lightragQueryMode;
      }
      if (o.expiresAfterTurns !== undefined) {
        if (
          typeof o.expiresAfterTurns !== "number" ||
          !Number.isInteger(o.expiresAfterTurns) ||
          o.expiresAfterTurns < 1 ||
          o.expiresAfterTurns > MAX_ONE_SHOT_TURNS
        ) {
          throw new PolicyValidationError(
            "invalid_payload",
            `oneShot.expiresAfterTurns must be an integer in [1, ${MAX_ONE_SHOT_TURNS}]`,
          );
        }
        shot.expiresAfterTurns = o.expiresAfterTurns;
      }
      if (o.force !== undefined) {
        if (typeof o.force !== "boolean") {
          throw new PolicyValidationError("invalid_payload", "oneShot.force must be a boolean");
        }
        shot.force = o.force;
      }
      if (shot.injection === undefined && shot.sources === undefined && shot.lightragQueryMode === undefined) {
        throw new PolicyValidationError(
          "invalid_payload",
          "oneShot needs at least one of injection, sources, lightragQueryMode",
        );
      }
      next.oneShot = shot;
    }
  }
  next = { ...next, v: 1, updatedAt: now, updatedBy };
  return next;
}

// ---------------------------------------------------------------------------
// Effective policy resolution (read path)
// ---------------------------------------------------------------------------

function filterAllowed(
  ids: string[] | undefined,
  allowed: string[],
  level: PolicyOrigin,
  warnings: string[],
): string[] | undefined {
  if (!ids) return undefined;
  const kept = ids.filter((id) => allowed.includes(id));
  const dropped = ids.filter((id) => !allowed.includes(id));
  if (dropped.length > 0) {
    warnings.push(`${level}: ignored ${dropped.length} source id(s) not allowed for this agent`);
  }
  // A level whose selection is entirely disallowed is ignored (falls through
  // to the level below) rather than meaning "no sources".
  return kept.length > 0 ? kept : undefined;
}

export interface ResolvePolicyParams {
  config: ResolvedKnowledgeConfig;
  agentId: string | undefined;
  /** Raw session-extension value (unvalidated). */
  sessionState: unknown;
  now: number;
  runId?: string;
  /** Whether this turn is eligible to consume a pending one-shot. */
  consumeOneShot: boolean;
}

/** Resolve the effective policy for one turn and the state to write back. */
export function resolveEffectivePolicy(params: ResolvePolicyParams): PolicyResolution {
  const { config, agentId, now, runId } = params;
  const agentPolicy = agentPolicyFor(config, agentId);
  const allowed = allowedSourcesFor(config, agentId).map((s) => s.id);
  const overridesAllowed = config.controlPlane.sessionOverrides && agentPolicy.allowSessionOverrides;
  const warnings: string[] = [];

  const agentLevel: PolicyOrigin =
    agentId && config.agentPolicies[agentId] ? "agent" : "default";
  let injection = agentPolicy.injection;
  let injectionOrigin: PolicyOrigin = agentLevel;
  let sources = agentPolicy.sources.filter((id) => allowed.includes(id));
  let sourcesOrigin: PolicyOrigin = agentLevel;
  let lightragQueryMode = agentPolicy.lightragQueryMode;
  let force = false;
  let consumption: OneShotConsumption | undefined;

  const state = overridesAllowed ? sanitizeSessionState(params.sessionState) : {};

  // Session level.
  if (state.injection) {
    injection = state.injection;
    injectionOrigin = "session";
  }
  const sessionSources = filterAllowed(state.sources, allowed, "session", warnings);
  if (sessionSources) {
    sources = sessionSources;
    sourcesOrigin = "session";
  }
  if (state.lightragQueryMode) lightragQueryMode = state.lightragQueryMode;

  // One-shot level: the replay of the one THIS run already consumed (a retry
  // or prompt rebuild must neither lose nor re-consume it), else a pending one.
  let shot: KnowledgeOneShot | undefined;
  if (overridesAllowed && params.consumeOneShot) {
    if (runId && state.lastOneShot && state.lastOneShot.runId === runId) {
      shot = state.lastOneShot;
    } else if (state.oneShot) {
      // A one-shot without `setAt` was not written through the plugin (raw
      // `sessions.pluginPatch`); it has no provable age, so it never applies.
      const setAt = state.oneShot.setAt;
      const stale =
        typeof setAt !== "number" || now - setAt > config.controlPlane.oneShotTtlMs;
      if (stale) {
        warnings.push("oneShot: expired or undated — ignored");
      } else {
        shot = state.oneShot;
      }
      consumption = { shot: state.oneShot, expired: stale, ...(runId ? { runId } : {}) };
    }
  }
  if (shot) {
    if (shot.injection) {
      injection = shot.injection;
      injectionOrigin = "oneShot";
    }
    const shotSources = filterAllowed(shot.sources, allowed, "oneShot", warnings);
    if (shotSources) {
      sources = shotSources;
      sourcesOrigin = "oneShot";
    }
    if (shot.lightragQueryMode) lightragQueryMode = shot.lightragQueryMode;
    force = shot.force !== false;
  }

  return {
    policy: {
      agentId,
      injection,
      sources,
      ...(lightragQueryMode ? { lightragQueryMode } : {}),
      ...(agentPolicy.topK !== undefined ? { topK: agentPolicy.topK } : {}),
      force,
      origin: { injection: injectionOrigin, sources: sourcesOrigin },
      allowedSources: allowed,
      overridesAllowed,
      warnings,
    },
    ...(consumption
      ? { consumption, nextState: applyOneShotConsumption(state, consumption) ?? state }
      : {}),
  };
}

function oneShotFingerprint(shot: KnowledgeOneShot): string {
  return JSON.stringify([
    shot.injection ?? null,
    shot.sources ?? null,
    shot.lightragQueryMode ?? null,
    shot.expiresAfterTurns ?? null,
    shot.force ?? null,
    shot.setAt ?? null,
  ]);
}

/**
 * Apply a consumption to the CURRENT stored value. Returns the next state, or
 * undefined when the pending one-shot is no longer the one the turn observed
 * (already consumed by a retry, replaced or cleared since) — nothing to do.
 */
export function applyOneShotConsumption(
  raw: unknown,
  consumption: OneShotConsumption,
): KnowledgeSessionState | undefined {
  const state = sanitizeSessionState(raw);
  if (!state.oneShot || oneShotFingerprint(state.oneShot) !== oneShotFingerprint(consumption.shot)) {
    return undefined;
  }
  const base = withoutOneShot(state);
  if (consumption.expired) return base;
  const remaining = (state.oneShot.expiresAfterTurns ?? 1) - 1;
  return {
    ...base,
    ...(remaining > 0 ? { oneShot: { ...state.oneShot, expiresAfterTurns: remaining } } : {}),
    ...(consumption.runId
      ? { lastOneShot: { ...stripOneShotMeta(consumption.shot), runId: consumption.runId } }
      : {}),
  };
}

/** Whether a state carries anything worth persisting (else the key is removed). */
export function hasPersistedPolicy(state: KnowledgeSessionState): boolean {
  return (
    state.injection !== undefined ||
    state.sources !== undefined ||
    state.lightragQueryMode !== undefined ||
    state.oneShot !== undefined ||
    state.lastOneShot !== undefined
  );
}

function withoutOneShot(state: KnowledgeSessionState): KnowledgeSessionState {
  const next = { ...state };
  delete next.oneShot;
  delete next.lastOneShot;
  return next;
}

function stripOneShotMeta(shot: KnowledgeOneShot): KnowledgeOneShot {
  const out: KnowledgeOneShot = {};
  if (shot.injection) out.injection = shot.injection;
  if (shot.sources) out.sources = [...shot.sources];
  if (shot.lightragQueryMode) out.lightragQueryMode = shot.lightragQueryMode;
  if (shot.force !== undefined) out.force = shot.force;
  return out;
}

/** Client-facing view of an effective policy (Gateway method / command). */
export function describePolicy(
  policy: EffectivePolicy,
  config: ResolvedKnowledgeConfig,
): Record<string, unknown> {
  return {
    agentId: policy.agentId ?? null,
    injection: policy.injection,
    sources: [...policy.sources],
    ...(policy.lightragQueryMode ? { lightragQueryMode: policy.lightragQueryMode } : {}),
    origin: { ...policy.origin },
    allowedSources: [...policy.allowedSources],
    overridesAllowed: policy.overridesAllowed,
    injectionTarget: config.injectionTarget,
  };
}

// ---------------------------------------------------------------------------
// `/knowledge` command parsing
// ---------------------------------------------------------------------------

export type KnowledgeCommand =
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "set"; patch: Record<string, unknown> }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * Parse `/knowledge` arguments:
 *   status | on | off | tool | auto | hybrid | use <id,id> | once <id,id> | reset | help
 */
export function parseKnowledgeCommand(args: string | undefined): KnowledgeCommand {
  // A chat command is one line. Clients may append standing instructions after
  // the user's text (Atrium's "[LIVRAISON]" block), and the host passes
  // everything after the command name as args — only the first line is ours.
  const text = (args ?? "").split(/\r?\n/, 1)[0]!.trim();
  if (!text) return { kind: "status" };
  const [verbRaw, ...rest] = text.split(/\s+/);
  const verb = (verbRaw ?? "").toLowerCase();
  const tail = rest.join(" ").trim();
  const ids = tail
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  switch (verb) {
    case "status":
    case "show":
      return { kind: "status" };
    case "help":
    case "?":
      return { kind: "help" };
    case "reset":
    case "default":
      return { kind: "reset" };
    case "on":
    case "auto":
      return { kind: "set", patch: { injection: "auto" } };
    case "off":
      return { kind: "set", patch: { injection: "off" } };
    case "tool":
      return { kind: "set", patch: { injection: "tool" } };
    case "hybrid":
      return { kind: "set", patch: { injection: "hybrid" } };
    case "use":
    case "sources":
      if (ids.length === 0) return { kind: "error", message: "usage: /knowledge use <source-id>[,<source-id>]" };
      if (ids.length === 1 && (ids[0] === "all" || ids[0] === "default")) {
        return { kind: "set", patch: { sources: null } };
      }
      return { kind: "set", patch: { sources: ids } };
    case "once":
      if (ids.length === 0) return { kind: "error", message: "usage: /knowledge once <source-id>[,<source-id>]" };
      return { kind: "set", patch: { oneShot: { injection: "auto", sources: ids } } };
    default:
      return { kind: "error", message: `unknown subcommand: ${verb}` };
  }
}
