// RPM (requests-per-minute) soft monitor for Jina API calls.
//
// Why "soft" rather than a hard gate:
//   - Hard gates introduce latency or dropped retrievals. Both are
//     worse UX than letting the call through and absorbing a 429.
//   - Jina's 429 response is already handled by the cooldown breaker
//     (see `cooldown` in `src/index.ts`). When 3 consecutive 429s
//     occur, the corresponding scope (router or pgvector_reranker)
//     enters a 5-minute cooldown and the plugin falls open to legacy
//     retrieval.
//
// What this monitor adds:
//   - **Visibility.** Emits a `jina_rpm_exceeded` structured event when
//     the configured per-minute budget is overshot, so dashboards can
//     alert before the operator sees billing surprises (especially when
//     the API key is shared with another service like Hindsight).
//   - **No behavior change.** The monitor never blocks a call; it only
//     observes and reports.
//
// Sliding window of 60 seconds, single-instance state.

/**
 * Default RPM budget per plugin instance. Calibrated below the Jina
 * free-tier ceiling (100 RPM) to leave headroom for a shared key
 * (Hindsight + knowledge plugin). Override via
 * `jina.rpmBudget` in plugin config.
 */
export const DEFAULT_RPM_BUDGET = 60;

export interface RpmMonitorOptions {
  /** Requests-per-minute soft budget. Default {@link DEFAULT_RPM_BUDGET}. */
  budget?: number;
  /**
   * Called once per 60-second window in which the budget was overshot.
   * Receives the observed peak count and the configured budget.
   * Optional — when omitted, the overshoot is silent.
   */
  onExceeded?: (info: { count: number; budget: number }) => void;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}

/**
 * Lightweight sliding-window RPM monitor. Always `record()` BEFORE the
 * Jina call so the count reflects the actual outbound request, even
 * if the call later fails.
 */
export class RpmMonitor {
  private readonly budget: number;
  private readonly onExceeded?: (info: { count: number; budget: number }) => void;
  private readonly now: () => number;
  private readonly timestamps: number[] = [];
  /**
   * When the last exceeded callback fired (epoch ms). Prevents log spam.
   *
   * Initialized to `-Infinity` so the FIRST overshoot always satisfies
   * `t - lastExceededNotice >= 60_000` regardless of the clock origin.
   * Without this, a deterministic test clock starting at `0` (the
   * documented use case for `RpmMonitorOptions.now`) would silently
   * suppress the first alert during the first minute of simulated
   * time — surprising and contract-breaking for tests.
   */
  private lastExceededNotice = Number.NEGATIVE_INFINITY;

  constructor(options: RpmMonitorOptions = {}) {
    this.budget = options.budget ?? DEFAULT_RPM_BUDGET;
    this.onExceeded = options.onExceeded;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record one outbound Jina request. Returns the current count in the
   * sliding 60-second window (post-record).
   *
   * When `budget <= 0` the monitor is considered DISABLED: this method
   * is a no-op (no timestamp tracked, no overshoot callback fired) and
   * returns `0`. This matches the contract documented on
   * `JinaPluginConfig.rpmBudget`. Without this short-circuit, `budget=0`
   * would treat every call as an overshoot (`count > 0` is true on the
   * first record), defeating the "disable" semantics.
   */
  record(): number {
    if (this.budget <= 0) return 0;
    const t = this.now();
    const cutoff = t - 60_000;
    // Drop expired timestamps from the front of the queue. The array is
    // chronologically ordered by construction (we always append), so a
    // simple shift loop terminates in O(expired count).
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    this.timestamps.push(t);
    const count = this.timestamps.length;

    // Fire the overshoot callback at most ONCE per 60-second window to
    // avoid log spam during a sustained burst.
    if (count > this.budget && this.onExceeded && t - this.lastExceededNotice >= 60_000) {
      this.lastExceededNotice = t;
      this.onExceeded({ count, budget: this.budget });
    }
    return count;
  }

  /**
   * Current count in the sliding 60-second window (no recording).
   * Returns `0` when the monitor is disabled (`budget <= 0`).
   */
  peek(): number {
    if (this.budget <= 0) return 0;
    const cutoff = this.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    return this.timestamps.length;
  }
}
