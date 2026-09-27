// Opik trace export for retrieval timings (4.0.0).
//
// Why a plugin-side exporter: OpenClaw's `diagnostics-otel` exports run, model
// call and tool spans, but not plugin hook durations, and its OpenTelemetry span
// ids are private to its own tracer — this plugin cannot nest spans inside the
// run trace. Each retrieval therefore becomes its own Opik trace
// (`knowledge.retrieval` for the hook, `knowledge.search` for the tool) in the
// instance project, tagged with the agent and correlated by `runId` metadata.
//
// Content-free by construction: durations, route / reason, policy and source
// ids only — never the query, the retrieved text, document paths or the
// session key. Fire-and-forget: batched, bounded, never awaited on the turn
// path; an unreachable Opik only costs a rate-limited warning.

import { randomBytes } from "node:crypto";

import type { ResolvedOpikConfig } from "../types.js";

/** Minimal logger surface (the plugin logger satisfies it). */
export interface OpikLogger {
  warn(message: string): void;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface OpikSpanInput {
  name: string;
  startedAt: number;
  endedAt: number;
  metadata?: Record<string, JsonValue | undefined>;
  tags?: string[];
}

export interface OpikTraceInput {
  name: string;
  startedAt: number;
  endedAt: number;
  metadata: Record<string, JsonValue | undefined>;
  tags: string[];
  spans: OpikSpanInput[];
}

interface OpikTraceRow {
  id: string;
  project_name: string;
  name: string;
  start_time: string;
  end_time: string;
  metadata: Record<string, JsonValue>;
  tags: string[];
}

interface OpikSpanRow {
  id: string;
  trace_id: string;
  project_name: string;
  name: string;
  type: "general";
  start_time: string;
  end_time: string;
  metadata: Record<string, JsonValue>;
  tags: string[];
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Rows per HTTP request (Opik batch endpoints accept larger batches). */
const BATCH_SIZE = 200;
/** Per-request timeout: a hung Opik must not pile up in-flight requests. */
const REQUEST_TIMEOUT_MS = 10_000;
/** At most one export warning per minute. */
const WARN_INTERVAL_MS = 60_000;

/** RFC 9562 UUID version 7 (time-ordered), the id format Opik expects. */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(Math.max(0, Math.floor(nowMs)));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compact(record: Record<string, JsonValue | undefined> | undefined): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class OpikExporter {
  private traces: OpikTraceRow[] = [];
  private spans: OpikSpanRow[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private lastWarnAt = 0;
  private dropped = 0;

  constructor(
    readonly config: ResolvedOpikConfig,
    private readonly logger: OpikLogger,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  /** Queued trace count (tests / diagnostics). */
  get pending(): number {
    return this.traces.length;
  }

  /** Queue one trace with its spans. Never throws, never awaits. */
  record(input: OpikTraceInput): void {
    if (!this.config.enabled) return;
    try {
      const traceId = uuidv7(input.startedAt);
      const project = this.config.projectName;
      this.traces.push({
        id: traceId,
        project_name: project,
        name: input.name,
        start_time: iso(input.startedAt),
        end_time: iso(Math.max(input.startedAt, input.endedAt)),
        metadata: compact(input.metadata),
        tags: input.tags,
      });
      for (const span of input.spans) {
        this.spans.push({
          id: uuidv7(span.startedAt),
          trace_id: traceId,
          project_name: project,
          name: span.name,
          type: "general",
          start_time: iso(span.startedAt),
          end_time: iso(Math.max(span.startedAt, span.endedAt)),
          metadata: compact(span.metadata),
          tags: span.tags ?? [],
        });
      }
      this.enforceBound();
      this.schedule();
    } catch {
      // Telemetry must never affect retrieval.
    }
  }

  /** Send everything queued now (also used by tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.inFlight) await this.inFlight;
    if (this.traces.length === 0 && this.spans.length === 0) return;
    const traces = this.traces;
    const spans = this.spans;
    this.traces = [];
    this.spans = [];
    this.inFlight = this.send(traces, spans).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.config.flushIntervalMs);
    // Never keep the gateway (or a one-shot CLI run) alive for telemetry.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Drop the oldest traces (and their spans) beyond `maxQueue`. */
  private enforceBound(): void {
    const excess = this.traces.length - this.config.maxQueue;
    if (excess <= 0) return;
    const removed = new Set(this.traces.splice(0, excess).map((t) => t.id));
    this.spans = this.spans.filter((s) => !removed.has(s.trace_id));
    this.dropped += excess;
  }

  private async send(traces: OpikTraceRow[], spans: OpikSpanRow[]): Promise<void> {
    try {
      // Traces first: spans reference them.
      for (let i = 0; i < traces.length; i += BATCH_SIZE) {
        await this.post("/v1/private/traces/batch", { traces: traces.slice(i, i + BATCH_SIZE) });
      }
      for (let i = 0; i < spans.length; i += BATCH_SIZE) {
        await this.post("/v1/private/spans/batch", { spans: spans.slice(i, i + BATCH_SIZE) });
      }
    } catch (err) {
      // Dropped, not retried: the queue stays bounded during an outage.
      this.warn(`export failed — ${(err as Error)?.message ?? "Error"}; ${traces.length} trace(s) dropped`);
    }
    if (this.dropped > 0) {
      this.warn(`queue full — ${this.dropped} trace(s) dropped`);
      this.dropped = 0;
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: this.config.apiKey,
    };
    if (this.config.workspace) headers["Comet-Workspace"] = this.config.workspace;
    const resp = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Status only: an error body may echo request fields.
      throw new Error(`HTTP ${resp.status}`);
    }
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(`openclaw-knowledge: opik ${message}`);
  }
}
