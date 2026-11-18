import "server-only";
import { getDb } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { listRealtimeIncidents, listRealtimeIncidentsBetween } from "@/lib/helpers/alert-bridge";
import { fromAlertBridge } from "@/lib/helpers/incident-wire";
import {
  bookedCount,
  DEFAULT_RULES,
  EVALUATION_DELAY_S,
  judgePurchase,
  purchaseIncident,
  purchasesFromEvents,
  purchaseWindow,
  type Hint,
  type JudgeConfig,
  type Purchase,
  type PurchaseVerdict,
  type TillEvent,
} from "@/lib/purchase-judge";
import type { ScenarioEntry } from "@/lib/config-store/types";
import type { Incident } from "@/lib/types";

// Runs the purchase judge (purchase-judge.ts) for every enabled multi-camera
// scenario: each purchase of its clock till is judged once, at close +
// windowAfterS + 30 s, against the per-chunk alerts of its cameras, and the
// verdict lands in SQLite (`purchase_evaluations`). Started once per console
// process from instrumentation.ts, beside the source poller: the console pod
// owns the SQLite file and runs as a single replica.

const log = createLogger("purchase-runner");

export const RUNNER_INTERVAL_MS = Number(process.env.PURCHASE_RUNNER_INTERVAL_MS) || 10_000;
/** Purchases that closed longer ago are not judged: the bridge's latest incidents
 *  no longer reach back to them, and a judge without hints would clear them. */
const DUE_LOOKBACK_MS = 30 * 60_000;
/** Till events read per pass; a session can stay open for half an hour before its scans. */
const EVENTS_LOOKBACK_MS = 3 * 3_600_000;
/** Incidents read from the bridge per pass; it lists newest first. */
const HINT_LIMIT = 500;
const KEEP_DAYS = 30;

// On globalThis: instrumentation and the routes reading the state need not share a module instance.
interface RunnerState {
  errors: Map<string, string>;
  started?: boolean;
}
const g = globalThis as unknown as { __purchaseRunner?: RunnerState };
const shared: RunnerState = (g.__purchaseRunner ??= { errors: new Map() });

// ─── Storage ──────────────────────────────────────────────────────────────────

export function isEvaluated(scenarioId: string, sourceId: string, purchaseId: string, closedAt: string): boolean {
  return !!getDb()
    .prepare(
      "SELECT 1 FROM purchase_evaluations WHERE scenario_id = ? AND source_id = ? AND purchase_id = ? AND closed_at = ?",
    )
    .get(scenarioId, sourceId, purchaseId, closedAt);
}

/** Store a verdict once; a second pass over the same purchase is a no-op. `replace`
 *  (a re-evaluation) overwrites the stored verdict instead. */
export function saveVerdict(v: PurchaseVerdict, now = new Date(), replace = false): boolean {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT OR ${replace ? "REPLACE" : "IGNORE"} INTO purchase_evaluations
         (scenario_id, source_id, purchase_id, closed_at, evaluated_at, incident, verdict_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.scenarioId, v.sourceId, v.purchaseId, v.closedAt, now.toISOString(), v.incident ? 1 : 0, JSON.stringify(v));
  db.prepare("DELETE FROM purchase_evaluations WHERE evaluated_at < ?").run(
    new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString(),
  );
  return res.changes > 0;
}

/** The newest purchase incidents as incident rows. Never throws. */
export function listPurchaseIncidents(limit: number): Incident[] {
  try {
    const rows = getDb()
      .prepare("SELECT verdict_json FROM purchase_evaluations WHERE incident = 1 ORDER BY closed_at DESC LIMIT ?")
      .all(limit) as { verdict_json: string }[];
    return rows.map((r) => purchaseIncident(JSON.parse(r.verdict_json) as PurchaseVerdict));
  } catch (err) {
    log.warn("purchase incidents unreadable", { err: String(err) });
    return [];
  }
}

export interface PurchaseStatus {
  purchaseId?: string;
  closedAt?: string;
  evaluatedAt?: string;
  incident?: boolean;
  summary?: string;
  /** Why the last pass could not judge this scenario. */
  error?: string;
}

/** Per scenario: the last purchase judged and the last error. Never throws. */
export function purchaseStatus(scenarioIds: string[]): Record<string, PurchaseStatus> {
  const out: Record<string, PurchaseStatus> = {};
  for (const id of scenarioIds) {
    const error = shared.errors.get(id);
    try {
      const row = getDb()
        .prepare(
          `SELECT purchase_id, closed_at, evaluated_at, incident, verdict_json FROM purchase_evaluations
           WHERE scenario_id = ? ORDER BY evaluated_at DESC, closed_at DESC LIMIT 1`,
        )
        .get(id) as
        | { purchase_id: string; closed_at: string; evaluated_at: string; incident: number; verdict_json: string }
        | undefined;
      if (row) {
        out[id] = {
          purchaseId: row.purchase_id,
          closedAt: row.closed_at,
          evaluatedAt: row.evaluated_at,
          incident: row.incident === 1,
          summary: (JSON.parse(row.verdict_json) as PurchaseVerdict).summary,
          ...(error ? { error } : {}),
        };
        continue;
      }
    } catch (err) {
      out[id] = { error: `status unreadable: ${String(err)}` };
      continue;
    }
    if (error) out[id] = { error };
  }
  return out;
}

// ─── Incident list ────────────────────────────────────────────────────────────

let hiddenCache: { at: number; ids: Set<string> } | null = null;

/**
 * Cameras of enabled multi-camera scenarios. Their per-chunk alerts are hints
 * inside the purchase incident, not incidents of their own. Cached 30 s: the
 * live stream asks every 4 s per open page. Empty when the store is unreadable.
 */
export async function hiddenCameraIds(now = Date.now()): Promise<Set<string>> {
  if (hiddenCache && now - hiddenCache.at < 30_000) return hiddenCache.ids;
  let ids = new Set<string>();
  try {
    const { makeReconcileContext } = await import("@/lib/reconcile/context");
    const ctx = await makeReconcileContext();
    const scenarios = await ctx.store.readScenarios(ctx.instance);
    ids = new Set(scenarios.filter((s) => s.enabled && s.mode === "multi").flatMap((s) => (s.cameras ?? []).map((c) => c.id)));
  } catch (err) {
    log.warn("multi-camera scenarios unreadable; listing every alert", { err: String(err) });
  }
  hiddenCache = { at: now, ids };
  return ids;
}

/** The bridge's incidents without those of multi-camera scenario cameras, plus the
 *  purchase incidents, newest first. */
export async function withPurchaseIncidents(bridge: Incident[], limit: number): Promise<Incident[]> {
  const hidden = await hiddenCameraIds();
  return [...bridge.filter((i) => !hidden.has(i.sensorId)), ...listPurchaseIncidents(limit)].sort(
    (a, b) => Date.parse(b.ts) - Date.parse(a.ts),
  );
}

// ─── Runner ───────────────────────────────────────────────────────────────────

/** The per-chunk alerts as hints: camera, chunk span, the model's answer. Throws when
 *  the bridge does not answer, so a pass never judges a purchase without its hints. */
export async function fetchHints(): Promise<Hint[]> {
  return toHints(await listRealtimeIncidents(HINT_LIMIT));
}

/** Hints around a past window, for a re-evaluation (the bridge keeps 7 days). */
export async function fetchHintsBetween(start: string, end: string): Promise<Hint[]> {
  return toHints(await listRealtimeIncidentsBetween(start, end));
}

function toHints(list: unknown[]): Hint[] {
  return list.map((raw) => {
    const inc = (fromAlertBridge(raw) ?? {}) as Partial<Incident>;
    const end = (raw as { end?: unknown } | null)?.end;
    return {
      cameraId: String(inc.sensorId ?? ""),
      start: String(inc.ts ?? ""),
      ...(typeof end === "string" ? { end } : {}),
      text: typeof inc.summary === "string" ? inc.summary : "",
    };
  });
}

/** The source whose purchases a scenario judges. */
export function clockOf(s: ScenarioEntry): string {
  const clock = s.sources?.find((x) => x.role === "clock")?.id;
  if (!clock) throw new Error("no clock source (a till with role clock) configured");
  return clock;
}

const judgeConfig = (s: ScenarioEntry, clock: string, neighbours: Purchase[]): JudgeConfig => ({
  scenarioId: s.id,
  scenarioName: s.name,
  sourceId: clock,
  cameras: s.cameras ?? [],
  rules: s.rules ?? DEFAULT_RULES,
  ...(s.productClasses ? { productClasses: s.productClasses } : {}),
  neighbours,
});

export interface PurchaseRow {
  purchaseId: string;
  closedAt: string;
  status: Purchase["status"];
  scans: number;
  totalCents?: number;
  /** Absent until the purchase has been judged. */
  evaluatedAt?: string;
  incident?: boolean;
  summary?: string;
}

/** The clock till's finished purchases in the event log (7 days), newest first, each
 *  with its stored verdict: the list a re-evaluation is started from. */
export async function scenarioPurchases(
  s: ScenarioEntry,
  readTillEvents: RunnerDeps["readTillEvents"],
  limit = 50,
): Promise<{ sourceId: string; purchases: PurchaseRow[] }> {
  const clock = clockOf(s);
  const purchases = purchasesFromEvents(await readTillEvents(clock))
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, limit);
  const stored = getDb().prepare(
    `SELECT evaluated_at, incident, verdict_json FROM purchase_evaluations
     WHERE scenario_id = ? AND source_id = ? AND purchase_id = ? AND closed_at = ?`,
  );
  return {
    sourceId: clock,
    purchases: purchases.map((p) => {
      const row = stored.get(s.id, clock, p.id, p.closedAt) as
        | { evaluated_at: string; incident: number; verdict_json: string }
        | undefined;
      return {
        purchaseId: p.id,
        closedAt: p.closedAt,
        status: p.status,
        scans: bookedCount(p.scans),
        ...(p.totalCents !== undefined ? { totalCents: p.totalCents } : {}),
        ...(row
          ? {
              evaluatedAt: row.evaluated_at,
              incident: row.incident === 1,
              summary: (JSON.parse(row.verdict_json) as PurchaseVerdict).summary,
            }
          : {}),
      };
    }),
  };
}

/**
 * Judge one finished purchase again now, with the bridge's alerts around its window
 * (a past purchase, or one judged before its hints were complete), and store the
 * verdict over the old one. Idempotent: the same inputs give the same verdict and
 * the same single row; the incident list shows it as soon as it is stored.
 */
export async function reevaluatePurchase(
  s: ScenarioEntry,
  purchaseId: string,
  deps: {
    readTillEvents: RunnerDeps["readTillEvents"];
    fetchHintsBetween: (start: string, end: string) => Promise<Hint[]>;
  },
  now = new Date(),
): Promise<PurchaseVerdict | null> {
  const clock = clockOf(s);
  const finished = purchasesFromEvents(await deps.readTillEvents(clock));
  const p = finished
    .filter((x) => x.id === purchaseId)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))[0];
  if (!p) return null;
  const w = purchaseWindow(p, s.rules ?? DEFAULT_RULES);
  // A chunk that starts before the window can still reach into it.
  const hints = w
    ? await deps.fetchHintsBetween(
        new Date(Date.parse(w.start) - 60_000).toISOString(),
        new Date(Date.parse(w.end) + 60_000).toISOString(),
      )
    : [];
  const v = judgePurchase(p, hints, judgeConfig(s, clock, finished));
  saveVerdict(v, now, true);
  log.info(`re-evaluated purchase ${p.id} of ${clock} for ${s.id}: ${v.incident ? "incident" : "no incident"}`);
  return v;
}

export interface RunnerDeps {
  readScenarios: () => Promise<ScenarioEntry[]>;
  /** The till's stored events (External Sources), any order. */
  readTillEvents: (sourceId: string) => TillEvent[] | Promise<TillEvent[]>;
  fetchHints: () => Promise<Hint[]>;
  now?: number;
}

/**
 * One pass: judge every purchase that is due and not yet judged. A scenario that
 * cannot be judged now (no clock source, bridge down) records an error and is
 * retried next pass; nothing is stored for it.
 */
export async function evaluateDuePurchases(deps: RunnerDeps): Promise<PurchaseVerdict[]> {
  const now = deps.now ?? Date.now();
  const done: PurchaseVerdict[] = [];
  let hints: Promise<Hint[]> | null = null;
  const scenarios = (await deps.readScenarios()).filter((s) => s.enabled && s.mode === "multi");
  for (const s of scenarios) {
    try {
      const clock = clockOf(s);
      const rules = s.rules ?? DEFAULT_RULES;
      const events = (await deps.readTillEvents(clock)).filter((e) => Date.parse(e.ts ?? "") >= now - EVENTS_LOOKBACK_MS);
      const finished = purchasesFromEvents(events);
      const due = finished.filter((p) => {
        const closed = Date.parse(p.closedAt);
        return (
          closed >= now - DUE_LOOKBACK_MS &&
          closed + (rules.windowAfterS + EVALUATION_DELAY_S) * 1000 <= now &&
          !isEvaluated(s.id, clock, p.id, p.closedAt)
        );
      });
      if (due.length) {
        hints ??= deps.fetchHints();
        const all = await hints;
        for (const p of due) {
          const v = judgePurchase(p, all, judgeConfig(s, clock, finished));
          if (saveVerdict(v, new Date(now))) {
            done.push(v);
            log.info(`judged purchase ${p.id} of ${clock} for ${s.id}: ${v.incident ? "incident" : "no incident"}`);
          }
        }
      }
      shared.errors.delete(s.id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (shared.errors.get(s.id) !== error) log.warn(`purchase judge: ${s.id} not judged`, { error });
      shared.errors.set(s.id, error);
    }
  }
  return done;
}

export function startPurchaseRunner(
  instance: string,
  readTillEvents: RunnerDeps["readTillEvents"],
  intervalMs = RUNNER_INTERVAL_MS,
): void {
  if (shared.started) return;
  shared.started = true;
  let busy = false;
  const deps: RunnerDeps = {
    readScenarios: async () => {
      const { makeConfigStore } = await import("@/lib/config-store");
      return (await makeConfigStore()).readScenarios(instance);
    },
    readTillEvents,
    fetchHints,
  };
  setInterval(() => {
    if (busy) return;
    busy = true;
    void evaluateDuePurchases({ ...deps, now: Date.now() })
      .catch((err) => log.warn("purchase runner pass failed", { err: String(err) }))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  log.info(`purchase runner started, every ${intervalMs / 1000}s`);
}
