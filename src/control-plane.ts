// Atrium- / user-driven control plane (4.0.0).
//
// Surfaces (all feature-detected — an older host simply lacks them):
//
//   - session extension `openclaw-knowledge/policy`
//       api.session.state.registerSessionExtension (upstream
//       src/plugins/plugin-api.types.ts OpenClawPluginSessionStateApi);
//       stored in SessionEntry.pluginExtensions["openclaw-knowledge"].policy
//       and projected into Gateway session rows as an array entry
//       `{ pluginId, namespace: "policy", value }`; writable by admin
//       clients through `sessions.pluginPatch` (stored unvalidated — the
//       plugin re-validates on every read, see policy.ts).
//   - session actions `policy.get` (operator.read), `policy.set`
//       (operator.write) and `policy.reset` (operator.write), dispatched with
//       `plugins.sessionAction` — the Gateway resolves the session owner
//       agent, authorizes the session target and validates the payload
//       schema; the plugin then validates the selection against the agent
//       allowlist before writing.
//   - Gateway methods `knowledge.sources` and `knowledge.policy.get`
//       (operator.read).
//   - chat command `/knowledge` (bypasses the LLM).
//
// Writes go through `api.runtime.agent.session.patchSessionEntry`, touching
// ONLY `pluginExtensions[<pluginId>].policy`. The next value is computed
// INSIDE the host's exclusive write (from the row it just read), so a turn
// consuming a one-shot and a client `policy.set` never overwrite each other.

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { KnowledgeResultCache } from "./cache.js";
import {
  POLICY_NAMESPACE,
  PolicyValidationError,
  agentPolicyFor,
  allowedSourcesFor,
  applyPolicyPatch,
  describePolicy,
  hasPersistedPolicy,
  parseKnowledgeCommand,
  projectSessionState,
  resolveEffectivePolicy,
  sanitizeSessionState,
  type KnowledgeSessionState,
} from "./policy.js";
import type { ResolvedKnowledgeConfig } from "./types.js";

export const PLUGIN_ID = "openclaw-knowledge";

// ---------------------------------------------------------------------------
// Session state store
// ---------------------------------------------------------------------------

/**
 * Compute the next stored value from the CURRENT raw one: a state to store,
 * `null` to remove it, or `undefined` to leave the row untouched. May throw
 * (e.g. PolicyValidationError); the error is re-thrown by `update`.
 */
export type SessionPolicyMutation = (current: unknown) => KnowledgeSessionState | null | undefined;

/** Read / write access to this plugin's session-extension value. */
export interface SessionPolicyStore {
  /** Raw (unvalidated) latest stored value, or undefined. Synchronous. */
  read(agentId: string | undefined, sessionKey: string): unknown;
  /**
   * Atomically read-modify-write the stored value. Resolves false when the
   * host write failed; re-throws an error raised by `mutate`.
   */
  update(
    agentId: string | undefined,
    sessionKey: string,
    mutate: SessionPolicyMutation,
  ): Promise<boolean>;
}

type SessionEntryLike = { pluginExtensions?: Record<string, Record<string, unknown>> };

interface RuntimeSessionLike {
  getSessionEntry?: (params: {
    sessionKey: string;
    agentId?: string;
    readConsistency?: "latest";
  }) => SessionEntryLike | undefined;
  patchSessionEntry?: (params: {
    sessionKey: string;
    agentId?: string;
    preserveActivity?: boolean;
    update: (entry: SessionEntryLike) => Partial<SessionEntryLike> | null;
  }) => Promise<unknown>;
}

/** Resolve `api.runtime.agent.session` structurally (absent on old hosts / tests). */
export function runtimeSessionOf(api: unknown): RuntimeSessionLike | undefined {
  const session = (api as { runtime?: { agent?: { session?: unknown } } })?.runtime?.agent?.session;
  if (!session || typeof session !== "object") return undefined;
  return session as RuntimeSessionLike;
}

/** Agent id embedded in a qualified session key (`agent:<id>:...`). */
export function agentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const m = /^agent:([^:]+):/i.exec(sessionKey);
  return m?.[1]?.toLowerCase();
}

/**
 * Session store backed by the host runtime. Read errors degrade to
 * "no override"; write errors resolve `false` (logged by the caller).
 */
export function createRuntimeSessionPolicyStore(
  api: unknown,
  pluginId: string,
  logger: PluginLogger,
): SessionPolicyStore | undefined {
  const session = runtimeSessionOf(api);
  if (!session?.getSessionEntry || !session.patchSessionEntry) return undefined;
  const getSessionEntry = session.getSessionEntry.bind(session);
  const patchSessionEntry = session.patchSessionEntry.bind(session);
  return {
    read(agentId, sessionKey) {
      try {
        // "latest" bypasses the in-process store snapshot: a one-shot written
        // by `policy.set` right before `chat.send` must be visible to the turn.
        const entry = getSessionEntry({
          sessionKey,
          ...(agentId ? { agentId } : {}),
          readConsistency: "latest",
        });
        return entry?.pluginExtensions?.[pluginId]?.[POLICY_NAMESPACE];
      } catch (err) {
        logger.debug?.(
          `openclaw-knowledge: session policy read failed — ${(err as Error)?.name ?? "Error"}`,
        );
        return undefined;
      }
    },
    async update(agentId, sessionKey, mutate) {
      let mutateError: unknown;
      let unchanged = false;
      try {
        const result = await patchSessionEntry({
          sessionKey,
          ...(agentId ? { agentId } : {}),
          // A policy change is not conversation activity.
          preserveActivity: true,
          update: (entry) => {
            const extensions = { ...(entry.pluginExtensions ?? {}) };
            const mine = { ...(extensions[pluginId] ?? {}) };
            let next: KnowledgeSessionState | null | undefined;
            try {
              next = mutate(mine[POLICY_NAMESPACE]);
            } catch (err) {
              mutateError = err;
              return null;
            }
            if (next === undefined) {
              unchanged = true;
              return null;
            }
            if (next === null) delete mine[POLICY_NAMESPACE];
            else mine[POLICY_NAMESPACE] = JSON.parse(JSON.stringify(next)) as unknown;
            if (Object.keys(mine).length > 0) extensions[pluginId] = mine;
            else delete extensions[pluginId];
            return { pluginExtensions: extensions };
          },
        });
        if (mutateError !== undefined) throw mutateError;
        return unchanged || (result !== null && result !== undefined);
      } catch (err) {
        // A validation error raised by `mutate` wins over whatever the host
        // did with the aborted (null) patch.
        if (mutateError !== undefined) throw mutateError;
        logger.warn(
          `openclaw-knowledge: session policy write failed — ${(err as Error)?.name ?? "Error"}`,
        );
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared read helpers
// ---------------------------------------------------------------------------

export interface ControlPlaneDeps {
  config: ResolvedKnowledgeConfig;
  logger: PluginLogger;
  store?: SessionPolicyStore;
  cache?: KnowledgeResultCache<unknown>;
  now?: () => number;
}

/** Sources visible to an agent (never exposes URLs / keys / collections). */
export function listSourcesForAgent(
  config: ResolvedKnowledgeConfig,
  agentId: string | undefined,
): Array<Record<string, unknown>> {
  const agentPolicy = agentPolicyFor(config, agentId);
  return allowedSourcesFor(config, agentId).map((src) => ({
    id: src.id,
    type: src.type,
    label: src.label,
    description: src.description,
    default: agentPolicy.sources.includes(src.id),
  }));
}

/** Policy snapshot for a session WITHOUT consuming a pending one-shot. */
export function readPolicySnapshot(
  deps: ControlPlaneDeps,
  agentId: string | undefined,
  sessionKey: string | undefined,
): Record<string, unknown> {
  const raw = sessionKey && deps.store ? deps.store.read(agentId, sessionKey) : undefined;
  const state = sanitizeSessionState(raw);
  const { policy } = resolveEffectivePolicy({
    config: deps.config,
    agentId,
    sessionState: state,
    now: (deps.now ?? Date.now)(),
    consumeOneShot: false,
  });
  return {
    ...describePolicy(policy, deps.config),
    session: projectSessionState(state),
    sources: listSourcesForAgent(deps.config, agentId),
    effectiveSources: [...policy.sources],
  };
}

async function applyAndWrite(
  deps: ControlPlaneDeps,
  agentId: string | undefined,
  sessionKey: string,
  patch: unknown,
  updatedBy: string,
): Promise<void> {
  const store = deps.store;
  if (!store) {
    throw new PolicyValidationError("invalid_payload", "session storage unavailable on this host");
  }
  const now = (deps.now ?? Date.now)();
  const ok = await store.update(agentId, sessionKey, (raw) => {
    const next = applyPolicyPatch(sanitizeSessionState(raw), patch, deps.config, agentId, now, updatedBy);
    return hasPersistedPolicy(next) ? next : null;
  });
  if (!ok) throw new Error("session write failed");
  // A source / mode change invalidates cached results of this session.
  deps.cache?.purgeSessionKey(sessionKey);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

function pick(api: unknown, grouped: string[], flat: string): AnyFn | undefined {
  let cursor: unknown = api;
  for (const key of grouped) {
    cursor = (cursor as Record<string, unknown> | undefined)?.[key];
  }
  if (typeof cursor === "function") {
    const owner = grouped.slice(0, -1).reduce<unknown>(
      (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
      api,
    );
    return (cursor as AnyFn).bind(owner);
  }
  const legacy = (api as Record<string, unknown> | undefined)?.[flat];
  return typeof legacy === "function" ? (legacy as AnyFn).bind(api) : undefined;
}

/** JSON schema for `policy.set` payloads (validated by the Gateway first). */
const POLICY_SET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    injection: { enum: ["auto", "tool", "hybrid", "off", null] },
    sources: {
      oneOf: [
        { type: "null" },
        { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 64 } },
      ],
    },
    lightragQueryMode: { enum: ["naive", "local", "global", "hybrid", "mix", null] },
    oneShot: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            injection: { enum: ["auto", "tool", "hybrid", "off"] },
            sources: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
            lightragQueryMode: { enum: ["naive", "local", "global", "hybrid", "mix"] },
            expiresAfterTurns: { type: "integer", minimum: 1, maximum: 20 },
            force: { type: "boolean" },
          },
        },
      ],
    },
    reset: { type: "boolean" },
  },
} as const;

function policyError(err: unknown): {
  ok: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
} {
  if (err instanceof PolicyValidationError) {
    return { ok: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
  }
  return { ok: false, error: "policy update failed", code: "write_failed" };
}

function strParam(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface GatewayRespond {
  (ok: boolean, payload?: unknown, error?: { code: string; message: string }): void;
}

/**
 * Register every control-plane surface the host supports. Each surface is
 * independent and wrapped so a failure never blocks the retrieval hook.
 */
export function registerControlPlane(api: unknown, deps: ControlPlaneDeps): string[] {
  const registered: string[] = [];
  const { config, logger } = deps;
  const attempt = (name: string, fn: () => void): void => {
    try {
      fn();
      registered.push(name);
    } catch (err) {
      logger.warn(
        `openclaw-knowledge: ${name} registration failed — ${(err as Error)?.message ?? String(err)}`,
      );
    }
  };

  // Session extension (projection + cache cleanup on reset/delete).
  const registerSessionExtension = pick(api, ["session", "state", "registerSessionExtension"], "registerSessionExtension");
  if (registerSessionExtension && config.controlPlane.sessionOverrides) {
    attempt("session-extension", () =>
      registerSessionExtension({
        namespace: POLICY_NAMESPACE,
        description:
          "Knowledge retrieval policy override for this session (injection mode, selected sources, one-shot per-prompt choice).",
        project: (ctx: { state?: unknown }) =>
          ctx.state === undefined ? undefined : projectSessionState(sanitizeSessionState(ctx.state)),
        cleanup: (ctx: { sessionKey?: string }) => {
          if (ctx.sessionKey) deps.cache?.purgeSessionKey(ctx.sessionKey);
        },
      }),
    );
  }

  if (config.controlPlane.gatewayMethods) {
    // Session actions: session-targeted, Gateway-authorized.
    const registerSessionAction = pick(api, ["session", "controls", "registerSessionAction"], "registerSessionAction");
    if (registerSessionAction) {
      attempt("session-action:policy.get", () =>
        registerSessionAction({
          id: "policy.get",
          description: "Effective knowledge policy and selectable sources for this session.",
          requiredScopes: ["operator.read"],
          handler: (ctx: { sessionKey?: string; agentId?: string }) => ({
            ok: true,
            result: readPolicySnapshot(deps, ctx.agentId ?? agentIdFromSessionKey(ctx.sessionKey), ctx.sessionKey),
          }),
        }),
      );
      if (config.controlPlane.sessionOverrides) {
        attempt("session-action:policy.set", () =>
          registerSessionAction({
            id: "policy.set",
            description:
              "Set this session's knowledge override (injection, sources, lightragQueryMode) or a one-shot per-prompt choice.",
            requiredScopes: ["operator.write"],
            schema: POLICY_SET_SCHEMA,
            handler: async (ctx: { sessionKey?: string; agentId?: string; payload?: unknown }) => {
              if (!ctx.sessionKey) {
                return { ok: false, error: "sessionKey is required", code: "invalid_payload" };
              }
              const agentId = ctx.agentId ?? agentIdFromSessionKey(ctx.sessionKey);
              try {
                await applyAndWrite(deps, agentId, ctx.sessionKey, ctx.payload ?? {}, "session-action");
                return { ok: true, result: readPolicySnapshot(deps, agentId, ctx.sessionKey) };
              } catch (err) {
                return policyError(err);
              }
            },
          }),
        );
        attempt("session-action:policy.reset", () =>
          registerSessionAction({
            id: "policy.reset",
            description: "Remove this session's knowledge override (back to the agent default).",
            requiredScopes: ["operator.write"],
            handler: async (ctx: { sessionKey?: string; agentId?: string }) => {
              if (!ctx.sessionKey) {
                return { ok: false, error: "sessionKey is required", code: "invalid_payload" };
              }
              const agentId = ctx.agentId ?? agentIdFromSessionKey(ctx.sessionKey);
              try {
                await applyAndWrite(deps, agentId, ctx.sessionKey, { reset: true }, "session-action");
                return { ok: true, result: readPolicySnapshot(deps, agentId, ctx.sessionKey) };
              } catch (err) {
                return policyError(err);
              }
            },
          }),
        );
      }
    }

    // Read-only Gateway methods (plugin-specific `knowledge.*` prefix; not a
    // reserved core namespace, so the requested scope is kept as-is).
    const registerGatewayMethod = pick(api, ["registerGatewayMethod"], "registerGatewayMethod");
    if (registerGatewayMethod) {
      attempt("gateway:knowledge.sources", () =>
        registerGatewayMethod(
          "knowledge.sources",
          ({ params, respond }: { params: unknown; respond: GatewayRespond }) => {
            const agentId = strParam(params, "agentId")?.toLowerCase();
            const agentPolicy = agentPolicyFor(config, agentId);
            respond(true, {
              agentId: agentId ?? null,
              configured: Boolean(agentId && config.agentPolicies[agentId]),
              injection: agentPolicy.injection,
              defaultSources: [...agentPolicy.sources],
              overridesAllowed: config.controlPlane.sessionOverrides && agentPolicy.allowSessionOverrides,
              injectionTarget: config.injectionTarget,
              sources: listSourcesForAgent(config, agentId),
            });
          },
          { scope: "operator.read" },
        ),
      );
      attempt("gateway:knowledge.policy.get", () =>
        registerGatewayMethod(
          "knowledge.policy.get",
          ({ params, respond }: { params: unknown; respond: GatewayRespond }) => {
            const sessionKey = strParam(params, "sessionKey");
            if (!sessionKey) {
              respond(false, undefined, { code: "INVALID_REQUEST", message: "sessionKey is required" });
              return;
            }
            const agentId = strParam(params, "agentId")?.toLowerCase() ?? agentIdFromSessionKey(sessionKey);
            respond(true, readPolicySnapshot(deps, agentId, sessionKey));
          },
          { scope: "operator.read" },
        ),
      );
    }
  }

  // `/knowledge` chat command (Telegram / WhatsApp / any channel). Never
  // reaches the LLM (plugin command results default to continueAgent=false).
  const registerCommand = pick(api, ["registerCommand"], "registerCommand");
  if (registerCommand && config.controlPlane.command) {
    attempt("command:/knowledge", () =>
      registerCommand({
        name: "knowledge",
        description: "Show or change knowledge-base retrieval for this conversation",
        acceptsArgs: true,
        handler: async (ctx: { args?: string; agentId?: string; sessionKey?: string }) => ({
          text: await runKnowledgeCommand(deps, ctx),
        }),
      }),
    );
  }

  return registered;
}

// ---------------------------------------------------------------------------
// `/knowledge` command
// ---------------------------------------------------------------------------

function formatSnapshot(snapshot: Record<string, unknown>): string {
  const sources = (snapshot.sources as Array<{ id: string; label: string; type: string }>) ?? [];
  const effective = (snapshot.effectiveSources as string[]) ?? [];
  const origin = (snapshot.origin as { injection: string; sources: string }) ?? {
    injection: "?",
    sources: "?",
  };
  const lines = [
    `Knowledge — injection: ${String(snapshot.injection)} (${origin.injection})`,
    `Sources in use: ${effective.length > 0 ? effective.join(", ") : "none"} (${origin.sources})`,
  ];
  const session = snapshot.session as { oneShot?: { sources?: string[]; injection?: string } } | undefined;
  if (session?.oneShot) {
    lines.push(
      `Next message only: ${session.oneShot.injection ?? "auto"}${session.oneShot.sources ? ` on ${session.oneShot.sources.join(", ")}` : ""}`,
    );
  }
  if (sources.length > 0) {
    lines.push("Available:");
    for (const src of sources) lines.push(`  • ${src.id} — ${src.label} (${src.type})`);
  }
  if (snapshot.overridesAllowed === false) lines.push("(overrides are disabled for this agent)");
  return lines.join("\n");
}

const COMMAND_HELP = [
  "/knowledge — show the current policy",
  "/knowledge auto | on — inject relevant documents automatically",
  "/knowledge hybrid — inject only for clear knowledge-base questions",
  "/knowledge tool — no automatic injection; the assistant searches on demand",
  "/knowledge off — disable knowledge for this conversation",
  "/knowledge use <id>[,<id>] — choose the sources (use all = agent default)",
  "/knowledge once <id>[,<id>] — use these sources for the next message only",
  "/knowledge reset — back to the agent default",
].join("\n");

export async function runKnowledgeCommand(
  deps: ControlPlaneDeps,
  ctx: { args?: string; agentId?: string; sessionKey?: string },
): Promise<string> {
  const agentId = ctx.agentId ?? agentIdFromSessionKey(ctx.sessionKey);
  const cmd = parseKnowledgeCommand(ctx.args);
  if (cmd.kind === "help") return COMMAND_HELP;
  if (cmd.kind === "error") return `${cmd.message}\n\n${COMMAND_HELP}`;
  if (cmd.kind === "status") {
    return formatSnapshot(readPolicySnapshot(deps, agentId, ctx.sessionKey));
  }
  if (!ctx.sessionKey) return "Knowledge: this conversation has no session to configure.";
  try {
    const patch = cmd.kind === "reset" ? { reset: true } : cmd.patch;
    await applyAndWrite(deps, agentId, ctx.sessionKey, patch, "command");
    return formatSnapshot(readPolicySnapshot(deps, agentId, ctx.sessionKey));
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      if (err.code === "unknown_source" || err.code === "source_not_allowed") {
        const ids = listSourcesForAgent(deps.config, agentId).map((s) => String(s.id));
        return `Knowledge: ${err.message}. Available: ${ids.join(", ") || "none"}`;
      }
      return `Knowledge: ${err.message}`;
    }
    return "Knowledge: could not update this conversation's policy.";
  }
}
