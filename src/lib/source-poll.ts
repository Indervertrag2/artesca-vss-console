import "server-only";
import { makeConfigStore } from "@/lib/config-store";
import { createLogger } from "@/lib/logger";
import { pulls, type PullState } from "@/lib/sources";
import type { SourceEntry } from "@/lib/config-store/types";
import { isStored, latestEventTs, recordPulledEvent, sourceUrl } from "@/lib/source-events";

// Pull mode for tills: for a till that cannot push (no webhook configured), the
// console reads its sessions and scans every few seconds and stores the same
// events the push would have sent, in the same log. Started once per console
// process from instrumentation.ts (not in the reconcile-agent pod, which does not
// own the SQLite file). Its state is shown on /cameras/sources.

const log = createLogger("source-poll");

export const POLL_INTERVAL_MS = Number(process.env.SOURCE_POLL_INTERVAL_MS) || 2500;

// On globalThis rather than in module scope: instrumentation and the route
// handlers that report this state are not guaranteed to share a module instance.
interface Shared {
  states: Map<string, PullState>;
  cursors: Map<string, string>;
  started?: boolean;
}
const g = globalThis as unknown as { __sourcePull?: Shared };
const shared: Shared = (g.__sourcePull ??= { states: new Map(), cursors: new Map() });

export const getPullStates = (): ReadonlyMap<string, PullState> => shared.states;

interface TillSession {
  id: number | string;
  lane?: string;
  started_utc: string;
  closed_utc?: string | null;
  status: string;
  items?: unknown;
  total_cents?: number;
}

interface TillScan {
  id: number | string;
  session_id: number | string;
  ts_utc: string;
  ean?: string;
  qty?: number;
  void_id?: number | string | null;
  source?: string;
  category?: string;
  weight_g?: number;
}

const END_BY_STATUS: Record<string, string> = {
  closed: "purchase_closed",
  cancelled: "purchase_cancelled",
  timeout: "purchase_timeout",
};

/** RFC 3339 to the second: the form scanlog stamps, and its `since` filter compares as text. */
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname} answered ${res.status}`);
  return res.json();
}

function startCursor(sourceId: string, now: number): string {
  const kept = shared.cursors.get(sourceId);
  if (kept) return kept;
  // After a restart: a little before the newest stored event (the overlap is
  // deduplicated). A new source: the last 15 minutes, not the till's history.
  const stored = Date.parse(latestEventTs(sourceId) ?? "");
  return isoSeconds(Number.isFinite(stored) ? stored - 10 * 60_000 : now - 15 * 60_000);
}

interface Pulled {
  rank: number;
  event: string;
  ts: string;
  lane: string | null;
  payload: Record<string, unknown>;
}

/**
 * One pass over one till: read its purchases and bookings since the cursor and
 * store them as the events the till would have pushed, with the same fields.
 * Returns how many were new. Throws when the till does not answer.
 */
export async function pollTill(source: SourceEntry, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<number> {
  const base = source.baseUrl;
  if (!base) return 0;
  const cursor = startCursor(source.id, now);
  // A purchase that started before the cursor can still end after it.
  const sessionsSince = isoSeconds(Date.parse(cursor) - 2 * 3_600_000);
  const [sessionsRaw, scansRaw] = await Promise.all([
    getJson(fetchImpl, sourceUrl(base, `api/sessions?since=${encodeURIComponent(sessionsSince)}`)),
    getJson(fetchImpl, sourceUrl(base, `api/scans?since=${encodeURIComponent(cursor)}`)),
  ]);
  const sessions = (Array.isArray(sessionsRaw) ? sessionsRaw : []) as TillSession[];
  const scans = (Array.isArray(scansRaw) ? scansRaw : []) as TillScan[];

  const laneOf = new Map(sessions.map((s) => [String(s.id), s.lane ?? source.lane ?? null]));
  const out: Pulled[] = [];
  for (const s of sessions) {
    const lane = laneOf.get(String(s.id)) ?? null;
    if (s.started_utc >= cursor) {
      out.push({ rank: 0, event: "purchase_started", ts: s.started_utc, lane, payload: { session_id: s.id } });
    }
    const end = END_BY_STATUS[s.status];
    if (end && s.closed_utc && s.closed_utc >= cursor) {
      const basket = end === "purchase_closed" ? { items: s.items, total_cents: s.total_cents } : {};
      out.push({ rank: 2, event: end, ts: s.closed_utc, lane, payload: { session_id: s.id, ...basket } });
    }
  }
  for (const sc of scans) {
    const lane = laneOf.get(String(sc.session_id)) ?? source.lane ?? null;
    out.push(
      sc.void_id != null
        ? {
            rank: 1,
            event: "item_voided",
            ts: sc.ts_utc,
            lane,
            payload: { session_id: sc.session_id, scan_id: sc.id, ean: sc.ean, qty: sc.qty ?? -1 },
          }
        : {
            rank: 1,
            event: "item_scanned",
            ts: sc.ts_utc,
            lane,
            payload: {
              session_id: sc.session_id,
              scan_id: sc.id,
              ean: sc.ean,
              qty: sc.qty ?? 1,
              source: sc.source,
              category: sc.category,
              weight_g: sc.weight_g,
            },
          },
    );
  }
  // Oldest first, and within one second: started, then bookings, then the end.
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.rank - b.rank);

  let added = 0;
  for (const ev of out) {
    // A paid purchase carries its basket and total, as the push does. The list
    // above has neither, so the purchase is read once, when it is new.
    if (ev.event === "purchase_closed" && ev.payload.total_cents === undefined && !isStored(source.id, ev.event, ev.payload, ev.ts)) {
      const view = (await getJson(fetchImpl, sourceUrl(base, `api/sessions/${ev.payload.session_id}`)).catch(
        () => null,
      )) as { items?: unknown; total_cents?: number } | null;
      if (view) ev.payload = { ...ev.payload, items: view.items, total_cents: view.total_cents };
    }
    if (recordPulledEvent(source.id, ev)) added++;
  }
  const newest = out.length ? out[out.length - 1].ts : cursor;
  shared.cursors.set(source.id, newest > cursor ? newest : cursor);
  return added;
}

/**
 * Read a till's purchases and bookings since `since` once, with the same events and
 * deduplication as the poll. The poll starts 15 minutes back when a source is new,
 * so purchases from before that are only in the log after this. Works for a push
 * source too, as long as it has a base URL. Returns how many events were new.
 */
export async function importTillHistory(source: SourceEntry, since: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  shared.cursors.set(source.id, isoSeconds(Date.parse(since)));
  return pollTill(source, fetchImpl);
}

/** One pass over every pulling source. Records each source's outcome for the page. */
export async function pollAllSources(instance: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let sources: SourceEntry[];
  try {
    // ponytail: reads the store every pass, a file read on the default backend;
    // cache the list if Firestore read volume ever matters.
    sources = (await (await makeConfigStore()).readSources(instance)).filter(pulls);
  } catch (err) {
    log.warn("source poll: config store unavailable", { err: String(err) });
    return;
  }
  const ids = new Set(sources.map((s) => s.id));
  for (const id of [...shared.states.keys()]) {
    if (!ids.has(id)) {
      shared.states.delete(id);
      shared.cursors.delete(id);
    }
  }
  await Promise.all(
    sources.map(async (s) => {
      const at = new Date().toISOString();
      const prev = shared.states.get(s.id);
      try {
        const added = await pollTill(s, fetchImpl);
        shared.states.set(s.id, { lastPollAt: at, lastOkAt: at, added });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (prev?.error !== error) log.warn(`source poll: ${s.id} failed`, { error });
        shared.states.set(s.id, { lastPollAt: at, ...(prev?.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}), error, added: 0 });
      }
    }),
  );
}

export function startSourcePoller(instance: string, intervalMs = POLL_INTERVAL_MS): void {
  if (shared.started) return;
  shared.started = true;
  let busy = false;
  setInterval(() => {
    if (busy) return; // a slow till must not stack passes
    busy = true;
    void pollAllSources(instance).finally(() => {
      busy = false;
    });
  }, intervalMs);
  log.info(`source poller started, every ${intervalMs / 1000}s`);
}
