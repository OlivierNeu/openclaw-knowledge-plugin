// `knowledge_search` agent tool (4.0.0).
//
// On-demand retrieval over the same named sources as the automatic hook,
// under the same per-agent allowlist. Registered as an OPTIONAL tool
// (manifest `toolMetadata.knowledge_search.optional: true`): an operator
// opts in with `tools.alsoAllow: ["knowledge_search"]` (global or per agent).
//
// Parameters use a plain JSON Schema object (the host validator compiles
// JSON Schema directly — packages/llm-core/src/validation.ts), so no
// TypeBox dependency is needed.

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { sessionScopeKey } from "./cache.js";
import { isLightRAGMode } from "./config.js";
import { agentIdFromSessionKey, type SessionPolicyStore } from "./control-plane.js";
import { resolveEffectivePolicy } from "./policy.js";
import {
  createVectorProvider,
  planRequests,
  renderSection,
  runSource,
  settleWithDeadline,
  type RetrievalDeps,
  type SourceResult,
} from "./retrieval.js";
import {
  emitProvenanceReports,
  type EmitAgentEventFn,
  type ProvenanceReportV1,
} from "./provenance.js";
import type { OpikExporter, OpikSpanInput } from "./tracing/opik.js";
import type { LightRAGQueryMode, ResolvedKnowledgeSource } from "./types.js";

export const KNOWLEDGE_SEARCH_TOOL = "knowledge_search";

/** Tool calls may run longer than the per-turn hook budget. */
const TOOL_LIGHTRAG_TIMEOUT_MS = 15_000;
const TOOL_PGVECTOR_TIMEOUT_MS = 8_000;
const TOOL_BUDGET_MS = 20_000;
const MAX_QUERY_CHARS = 2_000;

/**
 * Model-facing guidance. Kept stable (it is part of the cached tool block).
 */
export const KNOWLEDGE_SEARCH_DESCRIPTION = [
  "Search the user's private knowledge base (ingested documents and the knowledge graph built from them).",
  "Use it when the user asks about their own projects, clients, people, meetings, contracts, procedures or documents,",
  "when a <relevant-documents> block is missing or does not answer the question, or when you need a specific",
  "document, fact or relationship. Do not use it for general knowledge, small talk or questions about yourself.",
  "Write a focused query (key entities + intent) in the user's language. Cite the returned source document names.",
].join(" ");

export const KNOWLEDGE_SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 2,
      maxLength: MAX_QUERY_CHARS,
      description: "What to look for: entities, topic and intent, in the user's language.",
    },
    sources: {
      type: "array",
      items: { type: "string" },
      maxItems: 16,
      description:
        "Optional source ids to search (default: the conversation's configured sources). Unknown or unavailable ids are rejected.",
    },
    collection: {
      type: "string",
      description: "Optional document collection to restrict the document (pgvector) search to.",
    },
    mode: {
      type: "string",
      enum: ["naive", "local", "global", "hybrid", "mix"],
      description:
        "Knowledge-graph mode: naive = fast passage search (default); local = entities; global = themes/relations; hybrid/mix = deepest and slowest.",
    },
    topK: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of document passages per collection.",
    },
  },
} as const;

export interface KnowledgeToolDeps extends RetrievalDeps {
  store?: SessionPolicyStore;
  emitAgentEvent?: EmitAgentEventFn;
  /** Latest runId seen by the hook for a session (provenance correlation). */
  lookupRunId?: (sessionKey: string) => string | undefined;
  /** Opik trace exporter (content-free timings). */
  opik?: OpikExporter;
}

export interface KnowledgeToolContext {
  agentId?: string;
  sessionKey?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/** Build the concrete tool bound to one agent / session context. */
export function createKnowledgeSearchTool(deps: KnowledgeToolDeps, toolCtx: KnowledgeToolContext) {
  return {
    name: KNOWLEDGE_SEARCH_TOOL,
    label: "Knowledge search",
    description: KNOWLEDGE_SEARCH_DESCRIPTION,
    parameters: KNOWLEDGE_SEARCH_PARAMETERS,
    async execute(_toolCallId: string, rawParams: unknown, signal?: AbortSignal): Promise<ToolResult> {
      return executeKnowledgeSearch(deps, toolCtx, rawParams, signal);
    },
  };
}

export async function executeKnowledgeSearch(
  deps: KnowledgeToolDeps,
  toolCtx: KnowledgeToolContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { config, logger } = deps;
  const params = (rawParams ?? {}) as Record<string, unknown>;
  const query = typeof params.query === "string" ? params.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  if (query.length < 2) {
    return textResult("knowledge_search: `query` is required.", { status: "invalid" });
  }
  const agentId = toolCtx.agentId ?? agentIdFromSessionKey(toolCtx.sessionKey);
  const sessionKey = toolCtx.sessionKey;
  const { policy } = resolveEffectivePolicy({
    config,
    agentId,
    sessionState: sessionKey && deps.store ? deps.store.read(agentId, sessionKey) : undefined,
    now: Date.now(),
    consumeOneShot: false,
  });
  if (policy.injection === "off") {
    return textResult("Knowledge search is disabled for this conversation.", { status: "disabled" });
  }

  // Source selection: explicit ids must be allowed for this agent.
  const enabled = new Map<string, ResolvedKnowledgeSource>(
    config.sources.filter((s) => s.enabled).map((s) => [s.id, s]),
  );
  let ids = policy.sources;
  if (Array.isArray(params.sources) && params.sources.length > 0) {
    const requested = params.sources.filter((v): v is string => typeof v === "string");
    const rejected = requested.filter((id) => !policy.allowedSources.includes(id) || !enabled.has(id));
    if (rejected.length > 0) {
      return textResult(
        `knowledge_search: unavailable source(s): ${rejected.join(", ")}. Available: ${policy.allowedSources.join(", ") || "none"}.`,
        { status: "invalid", rejected },
      );
    }
    ids = requested;
  }
  const selected = ids.map((id) => enabled.get(id)).filter((s): s is ResolvedKnowledgeSource => !!s);
  if (selected.length === 0) {
    return textResult("knowledge_search: no knowledge source is available for this conversation.", {
      status: "no_sources",
    });
  }

  let collection: string | undefined;
  if (typeof params.collection === "string" && params.collection.trim()) {
    collection = params.collection.trim();
    const known = selected.filter((s) => s.type === "pgvector").flatMap((s) => s.collections);
    if (!known.includes(collection)) {
      return textResult(
        `knowledge_search: unknown collection "${collection}". Available: ${known.join(", ") || "none"}.`,
        { status: "invalid" },
      );
    }
  }
  const mode: LightRAGQueryMode | undefined = isLightRAGMode(params.mode) ? params.mode : undefined;
  const requestedTopK = typeof params.topK === "number" && params.topK >= 1 ? Math.floor(params.topK) : undefined;
  const topK = Math.min(
    requestedTopK ?? config.tool.defaultTopK ?? policy.topK ?? config.topK,
    config.tool.maxTopK,
  );

  const requests = planRequests({
    config,
    selected,
    route: "ALL",
    routeKey: "tool",
    ...(mode ? { policyMode: mode } : {}),
    topK,
    ...(collection ? { collection } : {}),
  });
  if (requests.length === 0) {
    return textResult("knowledge_search: nothing to search with these parameters.", { status: "no_sources" });
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const startedAt = Date.now();
  const cacheScope =
    config.cache.enabled && sessionKey ? sessionScopeKey(agentId, sessionKey) : undefined;
  const hasPgvector = requests.some((r) => r.source.type === "pgvector");
  const runCtx = {
    query,
    signal: controller.signal,
    ...(cacheScope ? { cacheScope } : {}),
    ...(hasPgvector && !config.testModeEnabled
      ? { vector: createVectorProvider(query, config.geminiApiKey, controller.signal) }
      : {}),
    timeouts: { lightragMs: TOOL_LIGHTRAG_TIMEOUT_MS, pgvectorMs: TOOL_PGVECTOR_TIMEOUT_MS },
  };
  try {
    const launched = requests.map((request) => ({
      request,
      promise: runSource(deps, request, runCtx),
    }));
    launched.forEach(({ promise }) => promise.catch(() => undefined));
    const { settled, budgetExceeded } = await settleWithDeadline(launched, startedAt + TOOL_BUDGET_MS);
    const settledAt = Date.now();
    controller.abort();

    const sections: string[] = [];
    const reports: (ProvenanceReportV1 | null)[] = [];
    const perSource: Array<Record<string, unknown>> = [];
    for (const s of settled) {
      if (s.status !== "fulfilled") {
        perSource.push({ id: s.request.source.id, status: s.status === "pending" ? "timeout" : "error" });
        if (s.status === "rejected") {
          const reason = s.reason as { name?: string } | undefined;
          logger.warn(
            `openclaw-knowledge: knowledge_search source "${s.request.source.id}" failed — ${reason?.name ?? "Error"}`,
          );
        }
        continue;
      }
      const value: SourceResult = s.value;
      const rendered = renderSection(value, config, logger, "tool_result");
      perSource.push({
        id: value.sourceId,
        status: rendered ? "ok" : "empty",
        ...(value.cached ? { cached: true } : {}),
        ...(value.source === "lightrag" ? { mode: value.mode } : {}),
      });
      if (rendered) {
        sections.push(rendered.text);
        reports.push(rendered.provenance);
      }
    }

    const runId = sessionKey ? deps.lookupRunId?.(sessionKey) : undefined;
    exportToolCall(deps.opik, {
      agentId,
      runId,
      startedAt,
      endedAt: settledAt,
      budgetExceeded,
      injected: sections.length > 0,
      perSource,
      requests,
    });

    if (sections.length === 0) {
      return textResult(
        budgetExceeded
          ? "knowledge_search: the knowledge base did not answer in time. Try a narrower query or mode \"naive\"."
          : "knowledge_search: no relevant document found.",
        { status: budgetExceeded ? "timeout" : "empty", sources: perSource },
      );
    }

    emitProvenanceReports(deps.emitAgentEvent, logger as PluginLogger, runId, sessionKey, reports);
    return textResult(
      ["Knowledge search results (cite the source document names):", "", ...sections].join("\n"),
      { status: "ok", sources: perSource, ...(budgetExceeded ? { partial: true } : {}) },
    );
  } catch (err) {
    logger.warn(`openclaw-knowledge: knowledge_search failed — ${(err as Error)?.name ?? "Error"}`);
    return textResult("knowledge_search: the knowledge base is unavailable right now.", { status: "error" });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** Export one tool call to Opik (content-free: ids, statuses, durations). */
function exportToolCall(
  opik: OpikExporter | undefined,
  call: {
    agentId: string | undefined;
    runId: string | undefined;
    startedAt: number;
    endedAt: number;
    budgetExceeded: boolean;
    injected: boolean;
    perSource: Array<Record<string, unknown>>;
    requests: Array<{ source: ResolvedKnowledgeSource; mode: string }>;
  },
): void {
  if (!opik) return;
  const spans: OpikSpanInput[] = call.requests.map((req, i) => {
    const status = String(call.perSource[i]?.status ?? "unknown");
    return {
      name: `${req.source.type}:${req.source.id}`,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      metadata: {
        sourceId: req.source.id,
        type: req.source.type,
        mode: req.source.type === "lightrag" ? req.mode : undefined,
        status,
        cached: call.perSource[i]?.cached === true,
      },
      tags: [status],
    };
  });
  const tags = ["knowledge", "tool", call.injected ? "found" : "empty"];
  if (call.agentId) tags.push(`agent:${call.agentId}`);
  if (call.budgetExceeded) tags.push("budget-exceeded");
  opik.record({
    name: "knowledge.search",
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    tags,
    spans,
    metadata: {
      runId: call.runId,
      agentId: call.agentId,
      totalMs: call.endedAt - call.startedAt,
      budgetExceeded: call.budgetExceeded,
      sources: call.requests.map((r) => r.source.id),
    },
  });
}
