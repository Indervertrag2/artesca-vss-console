// The purchase runner (issue #59): each till purchase of an enabled multi-camera
// scenario is judged once, at close + windowAfterS + 30 s, into SQLite; the
// incident list hides the scenario cameras' own alerts and lists the purchase.
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const dir = mkdtempSync(path.join(tmpdir(), "purchase-runner-"));
process.env.CONSOLE_DATA_DIR = dir;

const store = vi.hoisted(() => ({ scenarios: [] as unknown[] }));
vi.mock("@/lib/reconcile/context", () => ({
  makeReconcileContext: vi.fn(async () => ({ instance: "lab", store: { readScenarios: async () => store.scenarios } })),
}));

import {
  evaluateDuePurchases,
  listPurchaseIncidents,
  purchaseStatus,
  reevaluatePurchase,
  scenarioPurchases,
  withPurchaseIncidents,
} from "@/lib/purchase-runner";
import type { ScenarioEntry } from "@/lib/config-store/types";
import type { Hint, TillEvent } from "@/lib/purchase-judge";
import type { Incident } from "@/lib/types";

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the database file may still be open on Windows */
  }
});

const D = "2026-11-18T";
const at = (t: string) => Date.parse(D + t);

const scenario = (id: string, extra: Partial<ScenarioEntry> = {}): ScenarioEntry => ({
  id,
  name: `Self-checkout ${id}`,
  severity: "high",
  channels: ["ui"],
  sensor_filter: "*",
  keywords: [],
  enabled: true,
  mode: "multi",
  cameras: [{ id: "overhead-cam" }, { id: "scanner-cam" }],
  sources: [{ id: "till-1", role: "clock" }],
  rules: { matchToleranceS: 3, windowBeforeS: 30, windowAfterS: 20 },
  ...extra,
});

/** Purchase 63 (theft) and 64 (honest) as the till's events. */
const EVENTS: TillEvent[] = [
  { event: "purchase_started", ts: `${D}17:43:18Z`, payload: { session_id: 63 } },
  { event: "item_scanned", ts: `${D}17:43:21Z`, payload: { session_id: 63, scan_id: 289, ean: "87126853" } },
  { event: "item_scanned", ts: `${D}17:43:26Z`, payload: { session_id: 63, scan_id: 290, ean: "8413164023471" } },
  { event: "item_scanned", ts: `${D}17:43:29Z`, payload: { session_id: 63, scan_id: 291, ean: "4004661080025" } },
  {
    event: "purchase_closed",
    ts: `${D}17:43:33Z`,
    payload: {
      session_id: 63,
      total_cents: 500,
      items: [
        { ean: "87126853", name: "Cola 0,33 l Flasche", qty: 1, price_cents: 200 },
        { ean: "8413164023471", name: "Green Pea Piselli 28 g", qty: 1, price_cents: 120 },
        { ean: "4004661080025", name: "Orangensaft 0,2 l", qty: 1, price_cents: 180 },
      ],
    },
  },
  { event: "purchase_started", ts: `${D}17:50:00Z`, payload: { session_id: 64 } },
  { event: "item_scanned", ts: `${D}17:50:10Z`, payload: { session_id: 64, scan_id: 294, ean: "4004661080025" } },
  {
    event: "purchase_closed",
    ts: `${D}17:50:15Z`,
    payload: { session_id: 64, total_cents: 180, items: [{ ean: "4004661080025", name: "Orangensaft 0,2 l", qty: 1 }] },
  },
];

const HINTS: Hint[] = [
  { cameraId: "scanner-cam", start: `${D}17:43:08Z`, end: `${D}17:43:18Z`, text: "Yes - snack packet - placed on the side table next to the scanner." },
  { cameraId: "scanner-cam", start: `${D}17:50:01Z`, end: `${D}17:50:11Z`, text: "Yes - The bottle is lifted and moved away without being scanned." },
];

const deps = (now: number, fetchHints: () => Promise<Hint[]> = async () => HINTS) => ({
  readScenarios: async () => store.scenarios as ScenarioEntry[],
  readTillEvents: (sourceId: string) => (sourceId === "till-1" ? EVENTS : []),
  fetchHints,
  now,
});

describe("evaluateDuePurchases", () => {
  it("judges each purchase once, only after close + windowAfterS + 30 s", async () => {
    store.scenarios = [scenario("a")];
    // Purchase 63 closed 17:43:33: due at 17:44:23.
    expect(await evaluateDuePurchases(deps(at("17:44:22Z")))).toEqual([]);
    const first = await evaluateDuePurchases(deps(at("17:44:23Z")));
    expect(first.map((v) => [v.purchaseId, v.incident])).toEqual([["63", true]]);
    // 64 closed 17:50:15: due at 17:51:05; 63 is not judged again.
    const second = await evaluateDuePurchases(deps(at("17:51:05Z")));
    expect(second.map((v) => [v.purchaseId, v.incident])).toEqual([["64", false]]);
    expect(await evaluateDuePurchases(deps(at("17:52:00Z")))).toEqual([]);

    const incidents = listPurchaseIncidents(50).filter((i) => i.scenarioId === "a");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ ts: `${D}17:42:51.000Z`, severity: "high", sensorId: "overhead-cam", topic: "purchase" });
    expect(purchaseStatus(["a"]).a).toMatchObject({ purchaseId: "64", incident: false });
  });

  it("stores nothing while the alert bridge is down and judges on the next pass", async () => {
    store.scenarios = [scenario("b")];
    const down = await evaluateDuePurchases(deps(at("17:44:30Z"), async () => Promise.reject(new Error("bridge down"))));
    expect(down).toEqual([]);
    expect(purchaseStatus(["b"]).b).toEqual({ error: "bridge down" });
    const up = await evaluateDuePurchases(deps(at("17:44:40Z")));
    expect(up.map((v) => v.purchaseId)).toEqual(["63"]);
    expect(purchaseStatus(["b"]).b.error).toBeUndefined();
  });

  it("skips single-camera and disabled scenarios, and reports a missing clock", async () => {
    store.scenarios = [
      scenario("c", { mode: "single" }),
      scenario("d", { enabled: false }),
      scenario("e", { sources: [{ id: "till-1", role: "witness" }] }),
    ];
    expect(await evaluateDuePurchases(deps(at("17:44:30Z")))).toEqual([]);
    expect(purchaseStatus(["c", "d", "e"])).toEqual({ e: { error: expect.stringContaining("no clock source") } });
  });

  it("does not judge purchases that closed more than 30 minutes ago", async () => {
    store.scenarios = [scenario("f")];
    expect(await evaluateDuePurchases(deps(at("18:30:00Z")))).toEqual([]);
  });
});

describe("withPurchaseIncidents", () => {
  it("hides the alerts of multi-camera scenario cameras and lists the purchases, newest first", async () => {
    store.scenarios = [scenario("a"), scenario("g", { cameras: [{ id: "other-cam" }], enabled: false })];
    const alert = (sensorId: string, ts: string): Incident => ({
      ts: D + ts,
      scenarioId: "self-checkout-theft",
      scenarioName: "Self-checkout theft",
      severity: "high",
      sensorId,
      topic: "mdx-vlm-incidents",
      summary: "Yes - bag",
      raw: {},
    });
    const merged = await withPurchaseIncidents(
      [alert("scanner-cam", "17:43:08Z"), alert("other-cam", "17:40:00Z"), alert("shelf-cam", "18:00:00Z")],
      50,
    );
    expect(merged.map((i) => `${i.sensorId}@${i.ts.slice(11, 19)}`)).toEqual([
      "shelf-cam@18:00:00",
      "overhead-cam@17:42:51",
      "overhead-cam@17:42:51",
      "other-cam@17:40:00",
    ]);
  });
});

describe("re-evaluation", () => {
  it("lists the till's purchases and re-judges a past one from the alerts around its window, idempotently", async () => {
    const s = scenario("h");
    const read = deps(0).readTillEvents;
    const before = await scenarioPurchases(s, read);
    expect(before.sourceId).toBe("till-1");
    expect(before.purchases.map((p) => [p.purchaseId, p.scans, p.evaluatedAt])).toEqual([
      ["64", 1, undefined],
      ["63", 3, undefined],
    ]);

    const asked: string[][] = [];
    const between = async (a: string, b: string) => {
      asked.push([a, b]);
      return HINTS;
    };
    const later = new Date(at("23:00:00Z"));
    const v = await reevaluatePurchase(s, "63", { readTillEvents: read, fetchHintsBetween: between }, later);
    expect(v?.incident).toBe(true);
    // The window (17:42:51 to 17:43:53) with a minute on each side.
    expect(asked).toEqual([[`${D}17:41:51.000Z`, `${D}17:44:53.000Z`]]);
    await reevaluatePurchase(s, "63", { readTillEvents: read, fetchHintsBetween: between }, later);
    expect(listPurchaseIncidents(50).filter((i) => i.scenarioId === "h")).toHaveLength(1);
    expect((await scenarioPurchases(s, read)).purchases.find((p) => p.purchaseId === "63")).toMatchObject({ incident: true });

    // A new verdict replaces the old one: without hints the incident is gone.
    await reevaluatePurchase(s, "63", { readTillEvents: read, fetchHintsBetween: async () => [] }, later);
    expect(listPurchaseIncidents(50).filter((i) => i.scenarioId === "h")).toHaveLength(0);
    expect(await reevaluatePurchase(s, "99", { readTillEvents: read, fetchHintsBetween: between }, later)).toBeNull();
  });
});
