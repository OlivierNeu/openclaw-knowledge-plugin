// HTTP client for the Jina AI cloud API.
//
// Centralized so every endpoint wrapper (classifier, reranker) shares the
// same auth, timeout, and error handling. The client is intentionally tiny
// and dependency-free — `fetch` + `AbortController` only.
//
// Design choices:
//
// 1. **Bearer-only auth.** The API key is sent in the `Authorization` header,
//    never in the URL or in error messages. Operators copy the key from the
//    Jina console into the plugin config (with `${JINA_API_KEY}` env
//    substitution) and that's the only place it touches.
//
// 2. **Hard timeout via AbortController, covering BOTH the connection AND
//    the body read.** A stalled connection — or, worse, an endpoint that
//    sends headers immediately but never finishes streaming the body —
//    would otherwise hold the agent turn open until the SDK's outer
//    timeout kicks in (usually too long). The internal `controller`
//    remains armed until JSON.parse completes, so `resp.text()` is
//    cancelled by the same `controller.abort()` call as the underlying
//    fetch. Default 8 s — comfortable for cross-Atlantic Jina latency but
//    short enough to keep `before_prompt_build` snappy.
//
// 3. **Defensive JSON parsing.** Some upstream errors (502 from a CDN, 503
//    from a load balancer in front of Jina) return HTML, not JSON. Treating
//    the body as JSON without try/catch would crash the plugin with a
//    SyntaxError. We always read as text first, then try to parse; failures
//    become `JinaApiError` with a 200-char body preview.
//
// 4. **No automatic retry on 5xx.** The plugin's outer circuit breaker
//    already handles repeated failures (3 errors → 5 min cooldown). Retrying
//    here would just consume more tokens during an outage. Callers that want
//    retries should layer them above this client.

import {
  errorForStatus,
  JinaApiError,
  JinaNetworkError,
  previewBody,
} from "./errors.js";
import type { RpmMonitor } from "./rate-limit.js";

const DEFAULT_TIMEOUT_MS = 8_000;

/** Options accepted by every Jina request helper. */
export interface JinaRequestOptions {
  /** Bearer token sent in `Authorization`. Required. */
  apiKey: string;
  /** Override the default 8 s timeout. */
  timeoutMs?: number;
  /**
   * Optional AbortSignal from the caller. Composed with the internal timeout
   * signal so either source can cancel the request.
   */
  signal?: AbortSignal;
  /**
   * Optional RPM monitor. When supplied, `record()` is called BEFORE the
   * outbound fetch so the count reflects the actual request even if the
   * call later fails. Soft monitor — never blocks the call (see
   * `src/jina/rate-limit.ts` for the design rationale).
   *
   * @since 3.2.4
   */
  rpmMonitor?: RpmMonitor;
}

interface PostJsonParams<Req> extends JinaRequestOptions {
  url: string;
  body: Req;
}

/**
 * POST `body` to `url` as JSON, return the parsed JSON response as `unknown`.
 *
 * The response is `unknown` on purpose: callers MUST narrow it with their
 * own defensive parser (Jina occasionally changes response shapes).
 *
 * @throws {JinaAuthError}      on 401/403
 * @throws {JinaRateLimitError} on 429
 * @throws {JinaApiError}       on any other non-OK status (incl. HTML
 *                              bodies from upstream CDNs/LBs)
 * @throws {JinaNetworkError}   on fetch failure, abort, or timeout
 */
export async function postJson<Req>({
  url,
  body,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal: callerSignal,
  rpmMonitor,
}: PostJsonParams<Req>): Promise<unknown> {
  // Record BEFORE fetch so the count tracks the real outbound request,
  // even if it later fails or times out. The monitor is purely
  // observational; it never blocks the call.
  rpmMonitor?.record();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If the caller supplied a signal, abort the local controller when it
  // fires so both signals merge into one.
  const onCallerAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new JinaNetworkError(networkErrorReason(controller, timeoutMs), err);
    }

    // IMPORTANT: the body read happens BEFORE the timeout is cleared. If
    // the upstream server sends headers immediately but stalls or slowly
    // streams the body, `controller.abort()` (still armed) will reject
    // `resp.text()` with the underlying fetch's abort reason. Without
    // this, the hook could hang for the SDK's outer timeout window.
    const rawBody = await safeReadText(resp, controller, timeoutMs);

    if (!resp.ok) {
      throw errorForStatus(resp.status, previewBody(rawBody));
    }

    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      // Upstream sometimes returns HTML on partial failures even with HTTP 200.
      throw new JinaApiError(resp.status, previewBody(rawBody));
    }
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Read the response body as text under the same abort controller as the
 * underlying fetch. A connection that delivered headers but stalls on the
 * body is the failure mode this guards against: when `controller.abort()`
 * fires (timeout OR caller-initiated), the WHATWG fetch spec rejects the
 * pending `resp.text()` promise with the abort reason.
 *
 * Errors during read are mapped:
 *   - aborted by timeout/caller → re-throw as `JinaNetworkError`
 *   - any other I/O failure     → empty string (we still want to attempt
 *                                  error mapping based on the HTTP status)
 */
async function safeReadText(
  resp: Response,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  try {
    return await resp.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new JinaNetworkError(networkErrorReason(controller, timeoutMs), err);
    }
    return "";
  }
}

/**
 * Format a consistent reason string for a network-level failure.
 * The two distinct cases (timeout vs. raw fetch error) need different
 * wording for log readability.
 */
function networkErrorReason(controller: AbortController, timeoutMs: number): string {
  return controller.signal.aborted ? `timed out after ${timeoutMs}ms` : "fetch failed";
}
