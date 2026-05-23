// Typed errors for Jina API calls.
//
// We distinguish three failure modes the caller may want to react to
// differently:
//
//   - `JinaAuthError`      → API key invalid/expired. Permanent until the
//                            operator fixes the config; no point retrying.
//   - `JinaRateLimitError` → 429 from Jina. Transient; the circuit breaker
//                            should back off but the plugin remains usable
//                            on the next turn.
//   - `JinaApiError`       → generic non-OK response. Catches every 4xx/5xx
//                            that isn't auth or rate-limit.
//   - `JinaNetworkError`   → fetch threw / aborted before we got a response.
//                            Includes timeouts.
//
// All concrete classes extend `JinaError` so callers can `catch (e instanceof
// JinaError)` to handle them uniformly when they don't care about the
// subtype.
//
// IMPORTANT: error messages NEVER include the API key, the full request body,
// or the user query verbatim. Bodies are truncated to 200 chars to match the
// existing pattern in `embeddings.ts` and `lightrag.ts`.

const ERROR_BODY_PREVIEW_CHARS = 200;

/** Truncate an upstream error body to a safe length for logging. */
export function previewBody(body: string): string {
  if (body.length <= ERROR_BODY_PREVIEW_CHARS) return body;
  return body.slice(0, ERROR_BODY_PREVIEW_CHARS);
}

/** Base class for any Jina-related error. */
export class JinaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JinaError";
  }
}

/** 401/403 — operator must rotate or refill the API key. */
export class JinaAuthError extends JinaError {
  constructor(status: number, bodyPreview: string) {
    super(`Jina auth failed (${status}): ${bodyPreview}`);
    this.name = "JinaAuthError";
  }
}

/** 429 — Jina backed off; transient. */
export class JinaRateLimitError extends JinaError {
  constructor(bodyPreview: string) {
    super(`Jina rate-limited (429): ${bodyPreview}`);
    this.name = "JinaRateLimitError";
  }
}

/** Any other non-OK HTTP response. */
export class JinaApiError extends JinaError {
  readonly status: number;
  constructor(status: number, bodyPreview: string) {
    super(`Jina request failed (${status}): ${bodyPreview}`);
    this.status = status;
    this.name = "JinaApiError";
  }
}

/** Network failure, abort, timeout. `cause` carries the original error. */
export class JinaNetworkError extends JinaError {
  constructor(reason: string, cause?: unknown) {
    super(`Jina network error: ${reason}`);
    this.name = "JinaNetworkError";
    if (cause !== undefined) {
      // `Error.cause` is standard since ES2022; keep it readable in stack
      // traces without leaking sensitive context.
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Classify an HTTP status code into the appropriate Jina error class.
 * Centralized so every endpoint wrapper produces consistent errors.
 */
export function errorForStatus(status: number, bodyPreview: string): JinaError {
  if (status === 401 || status === 403) {
    return new JinaAuthError(status, bodyPreview);
  }
  if (status === 429) {
    return new JinaRateLimitError(bodyPreview);
  }
  return new JinaApiError(status, bodyPreview);
}

/**
 * Build a privacy-safe one-line description of any thrown value, suitable
 * for `logger.error(...)` in the hook handler.
 *
 * IMPORTANT: this MUST NOT include the upstream body preview that
 * `JinaError.message` carries — that preview can echo the user query or
 * document chunks if Jina's error path mirrors the request. We expose
 * only the error CLASS and (when applicable) the HTTP status code.
 *
 * Non-Jina errors fall through to `error.name`, which is safe by design
 * (it's a class name, not a message). The raw message of an unknown
 * error is NEVER logged here.
 */
export function summarizeJinaError(err: unknown): string {
  if (err instanceof JinaApiError) return `JinaApiError(status=${err.status})`;
  if (err instanceof JinaAuthError) return "JinaAuthError";
  if (err instanceof JinaRateLimitError) return "JinaRateLimitError";
  if (err instanceof JinaNetworkError) return "JinaNetworkError";
  if (err instanceof JinaError) return err.name;
  if (err instanceof Error) return err.name;
  return "unknown-error";
}
