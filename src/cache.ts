// Bounded per-session result cache (4.0.0).
//
// Chat turns frequently re-ask the same thing ("et pour Hélios ?" → retry,
// edit-and-resend, a tool call repeating the auto-injected query). Caching
// the raw per-source retrieval result for a few minutes removes a full
// LightRAG / Gemini + pgvector round-trip for those turns.
//
// Keys always include (agentId, sessionKey) so one conversation can never be
// served another conversation's results, plus the normalized query and a
// fingerprint of everything that changes the retrieval (source id, query
// mode, top-K, collections, keyword flag).
//
// Bounded three ways: entry count (LRU eviction), approximate byte size
// (UTF-16 length × 2 of the JSON serialization), and TTL (checked on read).
// Pure in-memory, process-local; nothing is persisted.

export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  bytes: number;
  expiresAt: number;
  sessionScope: string;
}

/** Normalize a query for cache keying: case, whitespace, trailing punctuation. */
export function normalizeQueryForCache(query: string): string {
  return query
    .normalize("NFC")
    .toLocaleLowerCase("fr")
    .replace(/\s+/g, " ")
    .replace(/[\s?!.…]+$/u, "")
    .trim();
}

/** Stable session scope component of a cache key. */
export function sessionScopeKey(agentId: string | undefined, sessionKey: string | undefined): string {
  return `${agentId ?? "-"}\u0000${sessionKey ?? "-"}`;
}

export class KnowledgeResultCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private totalBytes = 0;
  private readonly now: () => number;

  constructor(private readonly options: CacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get enabled(): boolean {
    return this.options.maxEntries > 0 && this.options.maxBytes > 0 && this.options.ttlMs > 0;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Refresh recency (Map preserves insertion order → re-insert at the end).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, sessionScope: string): void {
    if (!this.enabled) return;
    let bytes: number;
    try {
      bytes = JSON.stringify(value).length * 2;
    } catch {
      return; // non-serializable → never cached
    }
    if (bytes > this.options.maxBytes) return;
    this.delete(key);
    this.entries.set(key, {
      value,
      bytes,
      expiresAt: this.now() + this.options.ttlMs,
      sessionScope,
    });
    this.totalBytes += bytes;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** Drop every entry of one session (used on session reset / delete). */
  purgeSession(sessionScope: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.sessionScope === sessionScope) {
        this.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Drop every entry whose session scope ends with this session key. */
  purgeSessionKey(sessionKey: string): number {
    let removed = 0;
    const suffix = `\u0000${sessionKey}`;
    for (const [key, entry] of this.entries) {
      if (entry.sessionScope.endsWith(suffix)) {
        this.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private evict(): void {
    const now = this.now();
    // Expired entries first, then least-recently-used.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
    while (
      this.entries.size > this.options.maxEntries ||
      this.totalBytes > this.options.maxBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
