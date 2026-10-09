/**
 * Per-decision guard context (AsyncLocalStorage). The guarded executor runs each queue item inside
 * `withGuardContext`; every guard that fires during that item's tool calls appends its id to the
 * context's `guardsApplied` (which IS the Decision's array), and the reads a guard makes on its own
 * (prechecks, pagination, read-backs) are appended to the Decision's `effects`, so they stay visible.
 * Calls outside any context (ground-truth snapshots, tests) fire guards without recording them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Effect, Guard } from "../schema/index.js";

export interface GuardRunContext {
  guardsApplied: string[];
  effects: Effect[];
  now: () => Date;
}

const als = new AsyncLocalStorage<GuardRunContext>();

export function withGuardContext<T>(ctx: GuardRunContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function currentGuardContext(): GuardRunContext | undefined {
  return als.getStore();
}

/** Where `guarded()` reports firings and its own reads. */
export interface FiringRecorder {
  fired(guard: Guard, op: string): void;
  /** A call the guard layer made on its own (prechecks, pages, read-backs, failed write attempts). */
  effect(effect: Omit<Effect, "at">): void;
}

/** Default recorder: writes into the current AsyncLocalStorage context (no-op outside one). */
export const contextRecorder: FiringRecorder = {
  fired(guard) {
    const ctx = als.getStore();
    if (ctx && !ctx.guardsApplied.includes(guard.id)) ctx.guardsApplied.push(guard.id);
  },
  effect(effect) {
    const ctx = als.getStore();
    if (ctx) ctx.effects.push({ ...effect, at: ctx.now().toISOString() });
  },
};
