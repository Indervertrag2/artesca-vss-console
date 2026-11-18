// External sources: the event store (gaps, dedupe across push and pull,
// retention) and the till poller, against a real SQLite file in a temp dir.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  listSourceEvents,
  recordPulledEvent,
  recordSourceEvent,
  newSourceToken,
  tokenMatches,
} from "@/lib/source-events";
import { importTillHistory, pollTill } from "@/lib/source-poll";
import { getDb } from "@/lib/db";
import type { SourceEntry } from "@/lib/config-store/types";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "source-events-"));
  vi.stubEnv("CONSOLE_DATA_DIR", dir);
});
afterAll(() => {
  getDb().close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  getDb().exec("DELETE FROM source_events");
});

const push = (seq: number, extra: Record<string, unknown> = {}, event = "item_scanned") =>
  recordSourceEvent("till-1", {
    event,
    ts: "2026-11-18T17:43:21Z",
    seq,
    lane: "lane-1",
    payload: { event, seq, ...extra },
  });

describe("source events", () => {
  it("records a jump in seq as a gap, and a restart at seq 1 as none", () => {
    expect(push(1).gap).toBe(0);
    expect(push(2).gap).toBe(0);
    expect(push(5).gap).toBe(2);
    expect(push(1).gap).toBe(0); // sender restarted
    const log = listSourceEvents("till-1", { limit: 10 });
    expect(log.gaps).toBe(2);
    expect(log.events.map((e) => e.seq)).toEqual([1, 5, 2, 1]);
    expect(log.counts).toEqual({ item_scanned: 4 });
  });

  it("stores a till step once, whichever of pull and push delivers it first", () => {
    const step = { session_id: 63, scan_id: 7, ean: "87126853" };
    expect(
      recordPulledEvent("till-1", { event: "item_scanned", ts: "2026-11-18T17:43:21Z", lane: "lane-1", payload: step }),
    ).toBe(true);
    // The push stamps the same step a second later.
    const pushed = recordSourceEvent("till-1", {
      event: "item_scanned",
      ts: "2026-11-18T17:43:22Z",
      seq: 10,
      lane: "lane-1",
      payload: { event: "item_scanned", seq: 10, ...step },
    });
    expect(pushed.duplicate).toBe(true);
    const log = listSourceEvents("till-1", { limit: 10 });
    expect(log.events).toHaveLength(1);
    expect(log.events[0].seq).toBe(10); // kept, so the next push is not a gap
    expect(push(11, { session_id: 63, scan_id: 8 }).gap).toBe(0);
    // Pull reading the same step again stores nothing.
    expect(
      recordPulledEvent("till-1", { event: "item_scanned", ts: "2026-11-18T17:43:21Z", lane: "lane-1", payload: step }),
    ).toBe(false);
  });

  it("does not take a reset till's purchase #1 for the old one", () => {
    const start = (ts: string) =>
      recordPulledEvent("till-1", { event: "purchase_started", ts, lane: null, payload: { session_id: 1 } });
    expect(start("2026-11-18T08:00:00Z")).toBe(true);
    expect(start("2026-11-18T12:00:00Z")).toBe(true);
  });

  it("drops events older than 7 days", () => {
    recordSourceEvent("till-1", { event: "x", ts: null, seq: null, lane: null, payload: {} }, new Date(Date.now() - 8 * 86_400_000));
    recordSourceEvent("till-1", { event: "y", ts: null, seq: null, lane: null, payload: {} });
    expect(listSourceEvents("till-1", { limit: 10 }).events.map((e) => e.event)).toEqual(["y"]);
  });

  it("keeps only the token's hash, and checks a token against it", () => {
    const { token, tokenHash } = newSourceToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(tokenMatches(token, tokenHash)).toBe(true);
    expect(tokenMatches(`${token}x`, tokenHash)).toBe(false);
  });
});

describe("pollTill", () => {
  const till: SourceEntry = {
    id: "pull-till",
    name: "pull-till",
    type: "till",
    baseUrl: "http://till.example:8181",
    lane: "lane-1",
    mode: "pull",
    tokenHash: "00",
    enabled: true,
    createdAt: "2026-11-18T00:00:00.000Z",
  };
  const NOW = Date.parse("2026-11-18T17:50:00Z");

  function fakeTill() {
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname + url.search);
      const body =
        url.pathname === "/api/sessions"
          ? [{ id: 63, lane: "lane-1", started_utc: "2026-11-18T17:43:18Z", closed_utc: "2026-11-18T17:43:33Z", status: "closed" }]
          : url.pathname === "/api/scans"
            ? [
                { id: 1, session_id: 63, ts_utc: "2026-11-18T17:43:21Z", ean: "87126853", qty: 1, void_id: null, source: "scanner" },
                { id: 2, session_id: 63, ts_utc: "2026-11-18T17:43:25Z", ean: "87126853", qty: -1, void_id: 1, source: "void" },
              ]
            : url.pathname === "/api/sessions/63"
              ? { id: 63, items: [{ ean: "87126853" }], total_cents: 500 }
              : null;
      return body ? Response.json(body) : new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("turns purchases and bookings into the push events, oldest first, once", async () => {
    const { calls, fetchImpl } = fakeTill();
    expect(await pollTill(till, fetchImpl, NOW)).toBe(4);
    // A new source starts 15 minutes back, not at the till's whole history.
    expect(calls).toContain("/api/scans?since=2026-11-18T17%3A35%3A00Z");

    const log = listSourceEvents("pull-till", { limit: 10 });
    expect(log.events.map((e) => e.event).reverse()).toEqual([
      "purchase_started",
      "item_scanned",
      "item_voided",
      "purchase_closed",
    ]);
    const closed = log.events[0];
    expect(closed.payload).toMatchObject({ session_id: 63, total_cents: 500 });
    expect(log.events[1].payload).toMatchObject({ session_id: 63, scan_id: 2, ean: "87126853", qty: -1 });
    expect(log.events.every((e) => e.lane === "lane-1" && e.seq === null)).toBe(true);

    // The next pass reads the boundary again and stores nothing new.
    expect(await pollTill(till, fetchImpl, NOW + 2500)).toBe(0);
    expect(listSourceEvents("pull-till", { limit: 10 }).events).toHaveLength(4);
  });

  it("imports a till's history from a given time once, deduplicated against the poll (#59)", async () => {
    const { calls, fetchImpl } = fakeTill();
    const hist = { ...till, id: "hist-till", mode: "push" as const };
    expect(await importTillHistory(hist, "2026-11-18T15:00:00.000Z", fetchImpl)).toBe(4);
    expect(calls).toContain("/api/scans?since=2026-11-18T15%3A00%3A00Z");
    expect(await importTillHistory(hist, "2026-11-18T15:00:00Z", fetchImpl)).toBe(0);
    expect(listSourceEvents("hist-till", { limit: 10 }).events).toHaveLength(4);
  });

  it("throws when the till does not answer, so the poller can show it", async () => {
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(pollTill({ ...till, id: "down-till" }, down, NOW)).rejects.toThrow(/503/);
  });
});
