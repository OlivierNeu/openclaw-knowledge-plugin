// Circuit-breaker helpers shared by the hook handler and the retrieval engine.
//
// After MAX_CONSECUTIVE_ERRORS failures a scope pauses for COOLDOWN_MS, then
// resumes automatically. Scopes are independent so a Jina router outage does
// not trip the reranker (and vice versa).

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { emitEvent } from "./tracing/events.js";

export const MAX_CONSECUTIVE_ERRORS = 3;
export const COOLDOWN_MS = 5 * 60 * 1000;

export type CooldownScope = "global" | "router" | "pgvector_reranker";

export interface CooldownState {
  consecutiveErrors: number;
  cooldownUntil: number;
}

export function newCooldown(): CooldownState {
  return { consecutiveErrors: 0, cooldownUntil: 0 };
}

export function isInCooldown(state: CooldownState): boolean {
  return state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
}

export function maybeResetCooldown(
  state: CooldownState,
  scope: CooldownScope,
  logger: PluginLogger,
): void {
  if (!isInCooldown(state)) return;
  if (Date.now() < state.cooldownUntil) return;
  state.consecutiveErrors = 0;
  state.cooldownUntil = 0;
  logger.info(`openclaw-knowledge: ${scope} — resuming after cooldown`);
}

export function registerError(
  state: CooldownState,
  scope: CooldownScope,
  logger: PluginLogger,
): void {
  state.consecutiveErrors++;
  if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    logger.error(
      `openclaw-knowledge: ${state.consecutiveErrors} consecutive errors — ${scope} cooling down 5 min`,
    );
    emitEvent(logger, {
      type: "cooldown",
      scope,
      consecutiveErrors: state.consecutiveErrors,
    });
  }
}
