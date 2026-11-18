import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { getDb } from "@/lib/db";
import type { SourceEvent, SourceHealth } from "@/lib/sources";

// Events pushed by (or pulled from) external sources, in SQLite on the
// `console-data` volume beside sessions and incident reports. Kept 7 days.

export const EVENT_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

// ─── Tokens ──────────────────────────────────────────────────────────────────

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** 32 random bytes. Only the hash is stored; the token is shown once. */
export function newSourceToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function tokenMatches(token: string, tokenHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Storing ─────────────────────────────────────────────────────────────────

export interface NewSourceEvent {
  event: string;
  /** The source's own timestamp (`ts_utc`). */
  ts: string | null;
  seq: number | null;
  lane: string | null;
  payload: Record<string, unknown>;
}

const END_EVENTS = new Set(["purchase_closed", "purchase_cancelled", "purchase_timeout"]);

/**
 * Identity of a till step across push and pull, so the step is stored once
 * whichever path delivers it first. Session and scan ids are the till's own row
 * ids; events without one (staff_called, weight_mismatch) are never deduplicated.
 */
export function dedupeKey(event: string, payload: Record<string, unknown>): string | null {
  const sid = payload.session_id;
  const scan = payload.scan_id;
  if (event === "purchase_started" && sid != null) return `start:${sid}`;
  if (END_EVENTS.has(event) && sid != null) return `end:${sid}`;
  if ((event === "item_scanned" || event === "item_voided") && scan != null) return `scan:${scan}`;
  return null;
}

/**
 * The stored row for the same step, matched by key AND a till time within an
 * hour: a till whose database was reset counts its ids from 1 again, and its new
 * purchase #1 is not the old one. Push and pull stamp the same step at most a
 * second apart.
 */
function findDuplicate(sourceId: string, key: string, ts: string): { id: number } | undefined {
  return getDb()
    .prepare(
      `SELECT id FROM source_events
       WHERE source_id = ? AND dedupe_key = ? AND ABS(julianday(ts) - julianday(?)) < 1.0 / 24
       LIMIT 1`,
    )
    .get(sourceId, key, ts) as { id: number } | undefined;
}

export function isStored(sourceId: string, event: string, payload: Record<string, unknown>, ts: string): boolean {
  const key = dedupeKey(event, payload);
  return !!key && !!findDuplicate(sourceId, key, ts);
}

function insert(sourceId: string, ev: NewSourceEvent, key: string | null, gap: number, now: Date): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO source_events (source_id, received_at, event, ts, seq, lane, gap, dedupe_key, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sourceId, now.toISOString(), ev.event, ev.ts, ev.seq, ev.lane, gap, key, JSON.stringify(ev.payload));
  db.prepare("DELETE FROM source_events WHERE received_at < ?").run(
    new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY_MS).toISOString(),
  );
}

/**
 * Store one pushed event. `gap` is how many events a jump in `seq` says were
 * lost just before it. seq counts up by one per event; a drop means the sender
 * restarted and counts from 1 again, which is not a loss.
 */
export function recordSourceEvent(
  sourceId: string,
  ev: NewSourceEvent,
  now = new Date(),
): { gap: number; duplicate: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const last = db
      .prepare("SELECT seq FROM source_events WHERE source_id = ? AND seq IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(sourceId) as { seq: number } | undefined;
    const gap = ev.seq != null && last && ev.seq > last.seq + 1 ? ev.seq - last.seq - 1 : 0;
    const key = dedupeKey(ev.event, ev.payload);
    const dup = key && ev.ts ? findDuplicate(sourceId, key, ev.ts) : undefined;
    if (dup) {
      // Pull stored it first. Keep the running number on that row, or the next
      // pushed event would read as a gap.
      db.prepare("UPDATE source_events SET seq = ?, gap = ? WHERE id = ? AND seq IS NULL").run(ev.seq, gap, dup.id);
      return { gap, duplicate: true };
    }
    insert(sourceId, ev, key, gap, now);
    return { gap, duplicate: false };
  })();
}

/** Store one event read from the till's API, unless push or an earlier poll already did. */
export function recordPulledEvent(sourceId: string, ev: Omit<NewSourceEvent, "seq">, now = new Date()): boolean {
  const key = dedupeKey(ev.event, ev.payload);
  if (key && ev.ts && findDuplicate(sourceId, key, ev.ts)) return false;
  insert(sourceId, { ...ev, seq: null }, key, 0, now);
  return true;
}

/** The newest source timestamp stored for a source; where a restarted poller resumes. */
export function latestEventTs(sourceId: string): string | null {
  const row = getDb().prepare("SELECT MAX(ts) AS ts FROM source_events WHERE source_id = ?").get(sourceId) as
    | { ts: string | null }
    | undefined;
  return row?.ts ?? null;
}

export function deleteSourceEvents(sourceId: string): void {
  getDb().prepare("DELETE FROM source_events WHERE source_id = ?").run(sourceId);
}

// ─── Reading ─────────────────────────────────────────────────────────────────

interface Row {
  id: number;
  received_at: string;
  event: string;
  ts: string | null;
  seq: number | null;
  lane: string | null;
  gap: number;
  payload_json: string;
}

const toEvent = (r: Row): SourceEvent => ({
  id: r.id,
  receivedAt: r.received_at,
  event: r.event,
  ts: r.ts,
  seq: r.seq,
  lane: r.lane,
  gap: r.gap,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
});

/** Newest first, plus a count per event type and the total of seq gaps over the retained window. */
export function listSourceEvents(
  sourceId: string,
  opts: { limit: number; type?: string },
): { events: SourceEvent[]; counts: Record<string, number>; gaps: number } {
  const db = getDb();
  const rows = (
    opts.type
      ? db
          .prepare("SELECT * FROM source_events WHERE source_id = ? AND event = ? ORDER BY id DESC LIMIT ?")
          .all(sourceId, opts.type, opts.limit)
      : db.prepare("SELECT * FROM source_events WHERE source_id = ? ORDER BY id DESC LIMIT ?").all(sourceId, opts.limit)
  ) as Row[];
  const counts = Object.fromEntries(
    (
      db
        .prepare("SELECT event, COUNT(*) AS n FROM source_events WHERE source_id = ? GROUP BY event")
        .all(sourceId) as { event: string; n: number }[]
    ).map((c) => [c.event, c.n]),
  );
  const gaps = (
    db.prepare("SELECT COALESCE(SUM(gap), 0) AS g FROM source_events WHERE source_id = ?").get(sourceId) as { g: number }
  ).g;
  return { events: rows.map(toEvent), counts, gaps };
}

/** The latest event of every source, for the list's "Last event" column. */
export function lastSourceEvents(): Map<string, { event: string; receivedAt: string; sessionId?: string | number }> {
  const rows = getDb()
    .prepare(
      `SELECT source_id, event, received_at, payload_json FROM source_events
       WHERE id IN (SELECT MAX(id) FROM source_events GROUP BY source_id)`,
    )
    .all() as { source_id: string; event: string; received_at: string; payload_json: string }[];
  return new Map(
    rows.map((r) => {
      const sid = (JSON.parse(r.payload_json) as Record<string, unknown>).session_id;
      return [
        r.source_id,
        {
          event: r.event,
          receivedAt: r.received_at,
          ...(typeof sid === "string" || typeof sid === "number" ? { sessionId: sid } : {}),
        },
      ];
    }),
  );
}

// ─── Health ──────────────────────────────────────────────────────────────────

/** `<base>/<path>`, keeping any path the base URL already has. */
export const sourceUrl = (baseUrl: string, path: string) =>
  new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

/**
 * `GET <baseUrl>/api/health`. scanlog answers `{db, lane, time_utc, uptime_s,
 * version}`; `time_utc` gives the clock offset against this console, measured at
 * the midpoint of the request. Never throws.
 */
export async function probeSourceHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<SourceHealth> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(sourceUrl(baseUrl, "api/health"), {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const t1 = Date.now();
    if (!res.ok) return { reachable: false, status: res.status };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    let remote = typeof body.time_utc === "string" ? Date.parse(body.time_utc) : NaN;
    // scanlog stamps whole seconds, so its true time lies in [t, t + 1 s).
    if (typeof body.time_utc === "string" && !/\.\d+/.test(body.time_utc)) remote += 500;
    return {
      reachable: true,
      status: res.status,
      ...(Number.isFinite(remote) ? { clockOffsetMs: Math.round(remote - (t0 + t1) / 2) } : {}),
      ...(typeof body.lane === "string" ? { lane: body.lane } : {}),
      ...(typeof body.version === "string" ? { version: body.version } : {}),
    };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
