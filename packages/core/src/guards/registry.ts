/**
 * Guard registry: every compiled guard, active or retired, keyed by its deterministic id.
 *
 * Backed by the `guards` table in the Notary SQLite store when given a db (loaded on construction,
 * written through on every change), or purely in memory (e.g. loaded from a run bundle's `guards`).
 *
 * Lifecycle
 *   sync(compiled)         compiled guards become active (a retired guard whose belief is notarized
 *                          again is re-activated with a new compiledAt); any ACTIVE guard missing
 *                          from the compiled set (its belief is no longer notarized) is retired.
 *   retireForBelief(id)    active:false + retiredAt for every guard of that belief. Wired to
 *                          BeliefStore.onUnlearn (and onLeaveNotarized) by `wireRetirement`.
 */
import { DatabaseSync } from "node:sqlite";
import type { BeliefStore } from "../beliefs/store.js";
import { GuardSchema } from "../schema/index.js";
import type { Guard } from "../schema/index.js";
import type { NotaryDb } from "../store/db.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS guards (
  id          TEXT PRIMARY KEY,
  belief_id   TEXT NOT NULL,
  operation   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  class       TEXT NOT NULL,
  rule_json   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  active      INTEGER NOT NULL,
  compiled_at TEXT NOT NULL,
  retired_at  TEXT
);
CREATE INDEX IF NOT EXISTS guards_op ON guards (operation, active);
`;

/** Order in which guards of one op are applied by guarded(). */
export const KIND_ORDER: readonly Guard["kind"][] = ["block", "require_param", "transform", "precheck", "paginate_fully", "retry_policy"];

type Row = Record<string, unknown>;

export interface GuardRegistryOptions {
  now?: () => Date;
}

export class GuardRegistry {
  private readonly db: DatabaseSync | undefined;
  private readonly now: () => Date;
  private readonly guards = new Map<string, Guard>();

  constructor(db?: NotaryDb | DatabaseSync, opts: GuardRegistryOptions = {}) {
    this.db = db === undefined ? undefined : db instanceof DatabaseSync ? db : db.db;
    this.now = opts.now ?? (() => new Date());
    if (this.db) {
      this.db.exec(SCHEMA_SQL);
      for (const r of this.db.prepare("SELECT * FROM guards ORDER BY id").all() as Row[]) {
        const g = GuardSchema.parse({
          id: r.id,
          beliefId: r.belief_id,
          operation: r.operation,
          kind: r.kind,
          class: r.class,
          rule: JSON.parse(String(r.rule_json)),
          reason: r.reason,
          active: Number(r.active) === 1,
          compiledAt: r.compiled_at,
          ...(r.retired_at == null ? {} : { retiredAt: r.retired_at }),
        });
        this.guards.set(g.id, g);
      }
    }
  }

  /** In-memory registry from a bundle's guards. */
  static fromGuards(guards: readonly Guard[]): GuardRegistry {
    const reg = new GuardRegistry();
    for (const g of guards) reg.put(GuardSchema.parse(g));
    return reg;
  }

  private put(g: Guard): void {
    this.guards.set(g.id, g);
    this.db
      ?.prepare(
        `INSERT OR REPLACE INTO guards (id, belief_id, operation, kind, class, rule_json, reason, active, compiled_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(g.id, g.beliefId, g.operation, g.kind, g.class, JSON.stringify(g.rule), g.reason, g.active ? 1 : 0, g.compiledAt, g.retiredAt ?? null);
  }

  get(id: string): Guard | undefined {
    return this.guards.get(id);
  }

  /** Every guard, active and retired, by id. */
  all(): Guard[] {
    return [...this.guards.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Active guards for one op, in KIND_ORDER (then id). */
  active(op: string): Guard[] {
    return [...this.guards.values()]
      .filter((g) => g.active && g.operation === op)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Make `compiled` the active set; see header. Returns the guards retired by this call. */
  sync(compiled: readonly Guard[]): { activated: Guard[]; retired: Guard[] } {
    const at = this.now().toISOString();
    const ids = new Set(compiled.map((g) => g.id));
    const activated: Guard[] = [];
    for (const g of compiled) {
      const prev = this.guards.get(g.id);
      if (prev?.active) continue; // unchanged: keep the original compiledAt
      const next: Guard = GuardSchema.parse({ ...g, active: true });
      delete next.retiredAt;
      this.put(next);
      activated.push(next);
    }
    const retired: Guard[] = [];
    for (const g of [...this.guards.values()]) {
      if (g.active && !ids.has(g.id)) {
        const r = { ...g, active: false, retiredAt: at };
        this.put(r);
        retired.push(r);
      }
    }
    return { activated, retired };
  }

  /** Retire every active guard compiled from `beliefId`. */
  retireForBelief(beliefId: string, at: string = this.now().toISOString()): Guard[] {
    const out: Guard[] = [];
    for (const g of [...this.guards.values()]) {
      if (g.beliefId === beliefId && g.active) {
        const r = { ...g, active: false, retiredAt: at };
        this.put(r);
        out.push(r);
      }
    }
    return out;
  }
}

/**
 * Retire a belief's guards the moment it leaves `notarized`: on unlearn (TDD step 7) and when its
 * evidence fails the validity check. Returns a function that unwires both callbacks.
 */
export function wireRetirement(store: BeliefStore, registry: GuardRegistry, onRetired?: (guards: Guard[]) => void): () => void {
  const retire = (beliefId: string, at: string) => {
    const r = registry.retireForBelief(beliefId, at);
    if (r.length) onRetired?.(r);
  };
  store.setOnUnlearn((b, e) => retire(b.id, e.at));
  store.setOnLeaveNotarized((b, e) => retire(b.id, e.at));
  return () => {
    store.setOnUnlearn(undefined);
    store.setOnLeaveNotarized(undefined);
  };
}
