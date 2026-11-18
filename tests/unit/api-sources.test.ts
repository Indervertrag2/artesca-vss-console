// External sources API: the event input (token, unknown source, seq gap), the
// proxy's one exemption, and the CRUD routes' token handling.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { NextRequest } from "next/server";
import type { SourceEntry } from "@/lib/config-store/types";

const store = vi.hoisted(() => ({
  sources: [] as SourceEntry[],
  readSources: vi.fn(),
  upsertSource: vi.fn(),
  deleteSource: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/helpers/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/reconcile/context", () => ({
  ReconcileContextError: class extends Error {},
  makeReconcileContext: vi.fn(async () => ({ store, instance: "inst" })),
}));

import { auth } from "@/lib/auth";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { hashToken } from "@/lib/source-events";
import { isEventInputRequest } from "@/lib/sources";
import { POST as postEvent, GET as getEvents } from "@/app/api/sources/[id]/events/route";
import { GET as list, POST as create } from "@/app/api/sources/route";
import { PUT as update } from "@/app/api/sources/[id]/route";
import { POST as rotate } from "@/app/api/sources/[id]/token/route";

const TOKEN = "secret-token";
const till = (extra: Partial<SourceEntry> = {}): SourceEntry => ({
  id: "till-1",
  name: "Till 1",
  type: "till",
  lane: "lane-1",
  tokenHash: hashToken(TOKEN),
  enabled: true,
  createdAt: "2026-11-18T10:00:00.000Z",
  ...extra,
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, init?: RequestInit) => new Request(`http://console${url}`, init) as unknown as NextRequest;
const event = (seq: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: "item_scanned", lane: "lane-1", ts_utc: "2026-11-18T17:43:21Z", seq, ...extra });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "api-sources-"));
  vi.stubEnv("CONSOLE_DATA_DIR", dir);
});
afterAll(() => {
  getDb().close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  getDb().exec("DELETE FROM source_events");
  store.sources = [till()];
  store.readSources.mockReset().mockImplementation(async () => store.sources);
  store.upsertSource.mockReset().mockResolvedValue(undefined);
  store.deleteSource.mockReset().mockResolvedValue(undefined);
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { email: "op@test" } } as never);
});

describe("POST /api/sources/[id]/events — the event input", () => {
  const send = (id: string, body: string, opts: { bearer?: string; query?: string } = {}) =>
    postEvent(
      req(`/api/sources/${id}/events${opts.query ?? ""}`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
      }),
      params(id),
    );

  it("needs no session but a token", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await send("till-1", event(1))).status).toBe(401);
    expect((await send("till-1", event(1), { bearer: TOKEN })).status).toBe(202);
    expect(auth).not.toHaveBeenCalled();
  });

  it("accepts the token as a query parameter, for a sender that only takes a URL", async () => {
    expect((await send("till-1", event(1), { query: `?token=${TOKEN}` })).status).toBe(202);
  });

  it("refuses a wrong token and an unknown source", async () => {
    expect((await send("till-1", event(1), { bearer: "nope" })).status).toBe(401);
    const unknown = await send("other", event(1), { bearer: TOKEN });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown source" });
  });

  it("refuses events for a disabled source", async () => {
    store.sources = [till({ enabled: false })];
    expect((await send("till-1", event(1), { bearer: TOKEN })).status).toBe(403);
  });

  it("requires a till's seq and ts_utc, and JSON", async () => {
    expect((await send("till-1", JSON.stringify({ event: "item_scanned" }), { bearer: TOKEN })).status).toBe(400);
    expect((await send("till-1", "not json", { bearer: TOKEN })).status).toBe(400);
  });

  it("records a gap in seq, visible in the event log", async () => {
    expect(await (await send("till-1", event(1), { bearer: TOKEN })).json()).toEqual({ ok: true, gap: 0 });
    expect(await (await send("till-1", event(4, { ean: "123" }), { bearer: TOKEN })).json()).toEqual({ ok: true, gap: 2 });

    const res = await getEvents(req("/api/sources/till-1/events?limit=10"), params("till-1"));
    const log = await res.json();
    expect(log.gaps).toBe(2);
    expect(log.events.map((e: { seq: number }) => e.seq)).toEqual([4, 1]);
    expect(log.events[0].payload.ean).toBe("123");
  });

  it("reads the log only with a session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await getEvents(req("/api/sources/till-1/events"), params("till-1"))).status).toBe(401);
  });
});

describe("the proxy lets exactly the event input through", () => {
  it("POST on /api/sources/<id>/events, nothing else", () => {
    expect(isEventInputRequest("POST", "/api/sources/till-1/events")).toBe(true);
    expect(isEventInputRequest("GET", "/api/sources/till-1/events")).toBe(false);
    expect(isEventInputRequest("POST", "/api/sources/till-1")).toBe(false);
    expect(isEventInputRequest("POST", "/api/sources")).toBe(false);
    expect(isEventInputRequest("POST", "/api/sources/till-1/events/x")).toBe(false);
    expect(isEventInputRequest("POST", "/api/sources/till-1/token")).toBe(false);
  });
});

describe("source CRUD", () => {
  const post = (body: unknown) =>
    create(req("/api/sources", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

  it("returns the token once on create and stores only its hash", async () => {
    store.sources = [];
    const res = await post({ name: "Lane 2 Till", type: "till", baseUrl: "", lane: "lane-2" });
    expect(res.status).toBe(201);
    const { source, token } = await res.json();
    expect(source).toMatchObject({ id: "lane-2-till", name: "Lane 2 Till", mode: "push", enabled: true });
    expect(source.tokenHash).toBeUndefined();
    const stored = store.upsertSource.mock.calls[0][1] as SourceEntry;
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(stored).not.toHaveProperty("token");
    expect(stored).not.toHaveProperty("baseUrl"); // empty string means absent

    store.sources = [stored];
    const listed = await (await list(req("/api/sources"))).json();
    expect(JSON.stringify(listed)).not.toContain(stored.tokenHash);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it("refuses a duplicate id, and pull on anything but a till with an address", async () => {
    expect((await post({ name: "till-1", type: "till" })).status).toBe(409);
    expect((await post({ name: "scale-1", type: "scale", baseUrl: "http://s:8181", mode: "pull" })).status).toBe(400);
    expect((await post({ name: "till-2", type: "till", mode: "pull" })).status).toBe(400);
  });

  it("refuses writes in kiosk mode", async () => {
    vi.mocked(cookies).mockResolvedValueOnce(new Map([["kiosk", { value: "1" }]]) as never);
    expect((await post({ name: "x", type: "till" })).status).toBe(403);
  });

  it("PUT keeps id, token and createdAt, and clears a field left out", async () => {
    const res = await update(
      req("/api/sources/till-1", {
        method: "PUT",
        body: JSON.stringify({ name: "Renamed", type: "till", baseUrl: "http://till:8181", mode: "both" }),
      }),
      params("till-1"),
    );
    expect(res.status).toBe(200);
    const stored = store.upsertSource.mock.calls[0][1] as SourceEntry;
    expect(stored).toMatchObject({ id: "till-1", name: "Renamed", mode: "both", tokenHash: hashToken(TOKEN), createdAt: "2026-11-18T10:00:00.000Z" });
    expect(stored).not.toHaveProperty("lane");
  });

  it("rotating the token returns a new one and replaces the hash", async () => {
    const res = await rotate(req("/api/sources/till-1/token", { method: "POST" }), params("till-1"));
    const { token } = await res.json();
    expect(token).not.toBe(TOKEN);
    expect((store.upsertSource.mock.calls[0][1] as SourceEntry).tokenHash).toBe(hashToken(token));
  });
});
