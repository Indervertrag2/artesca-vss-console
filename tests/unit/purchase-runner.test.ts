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
import { RecordingUnavailableError, type RecordingEvidence } from "@/lib/purchase-recording";
import { getDb } from "@/lib/db";
import type { ScenarioEntry } from "@/lib/config-store/types";
import type { Hint, PurchaseVerdict, TillEvent } from "@/lib/purchase-judge";
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

// Issue #60: a scenario with `evidence: "recording"` takes its hints from the
// recording of the purchase window. The recording itself (VST, ffmpeg, the VLM)
// is purchase-recording.test.ts; here it is a function the runner is given.
describe("evidence from the recording", () => {
  const THEFT: Hint = {
    cameraId: "scanner-cam",
    start: `${D}17:42:57.000Z`,
    end: `${D}17:43:07.000Z`,
    text: "Yes - snack packet - placed on the counter next to the scanner instead of scanning it",
  };
  const EVIDENCE: RecordingEvidence = { hints: [THEFT], chunksAsked: { "overhead-cam": 10, "scanner-cam": 10 } };
  const recorded = (id: string, extra: Partial<ScenarioEntry> = {}) => scenario(id, { evidence: "recording", ...extra });
  const bridge = vi.fn(async () => HINTS);
  const run = (now: number, recordingHints: typeof import("@/lib/purchase-recording").recordingHints) =>
    evaluateDuePurchases({ ...deps(now, bridge), recordingHints });
  const stored = (id: string) =>
    listPurchaseIncidents(50)
      .filter((i) => i.scenarioId === id)
      .map((i) => (i.raw as { verdict: PurchaseVerdict }).verdict);

  it("judges a purchase 60 s after its window closes, from the recording of the window and not the live alerts", async () => {
    store.scenarios = [recorded("r1")];
    const hints = vi.fn(async () => EVIDENCE);
    // Purchase 63 closed 17:43:33, its window 17:43:53: the recording is complete at 17:44:53.
    await run(at("17:44:52Z"), hints);
    expect(hints).not.toHaveBeenCalled();
    expect(await run(at("17:44:53Z"), hints)).toEqual([]);
    expect(hints).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "r1" }), {
      start: `${D}17:42:51.000Z`,
      end: `${D}17:43:53.000Z`,
    });
    await vi.waitFor(() => expect(purchaseStatus(["r1"]).r1).toMatchObject({ purchaseId: "63", incident: true }));
    expect(bridge).not.toHaveBeenCalled();

    const [v] = stored("r1");
    expect(v).toMatchObject({ evidence: "recording", chunkS: 10, overlapS: 4, chunksAsked: EVIDENCE.chunksAsked, incident: true });
    expect(v.hints).toEqual([expect.objectContaining({ ...THEFT, outcome: "remains" })]);
    // Judged once: a later pass does not ask again.
    await run(at("17:45:10Z"), hints);
    expect(hints).toHaveBeenCalledTimes(1);
  });

  it("stores the scenario's own chunking with the verdict, also when nothing was seen", async () => {
    store.scenarios = [recorded("r2", { chunkS: 8, overlapS: 2 })];
    await run(at("17:45:00Z"), async () => ({ hints: [], chunksAsked: { "overhead-cam": 11, "scanner-cam": 11 } }));
    await vi.waitFor(() => expect(purchaseStatus(["r2"]).r2).toMatchObject({ purchaseId: "63", incident: false }));
    const row = getDb()
      .prepare("SELECT verdict_json FROM purchase_evaluations WHERE scenario_id = 'r2'")
      .get() as { verdict_json: string };
    expect(JSON.parse(row.verdict_json)).toMatchObject({ evidence: "recording", chunkS: 8, overlapS: 2, chunksAsked: { "scanner-cam": 11 } });
  });

  it("does not hold up the pass and does not start a running purchase twice", async () => {
    store.scenarios = [recorded("r3"), scenario("r3-live")];
    let finish!: (e: RecordingEvidence) => void;
    const hints = vi.fn(() => new Promise<RecordingEvidence>((resolve) => (finish = resolve)));
    // The pass returns while the recording is still being asked about, and judges the live scenario.
    const first = await run(at("17:44:53Z"), hints);
    expect(first.map((v) => [v.scenarioId, v.purchaseId])).toEqual([["r3-live", "63"]]);
    await run(at("17:45:03Z"), hints);
    await run(at("17:45:13Z"), hints);
    expect(hints).toHaveBeenCalledTimes(1);
    expect(purchaseStatus(["r3"])).toEqual({});

    finish(EVIDENCE);
    await vi.waitFor(() => expect(purchaseStatus(["r3"]).r3).toMatchObject({ purchaseId: "63", incident: true }));
    await run(at("17:45:23Z"), hints);
    expect(hints).toHaveBeenCalledTimes(1);
  });

  it("stores no verdict when a recording is missing, shows why, and tries again later", async () => {
    store.scenarios = [recorded("r4")];
    const missing = new RecordingUnavailableError("VST has no recording of camera scanner-cam for the purchase window");
    const hints = vi.fn<() => Promise<RecordingEvidence>>().mockRejectedValueOnce(missing).mockResolvedValue(EVIDENCE);
    await run(at("17:44:53Z"), hints);
    await vi.waitFor(() => expect(purchaseStatus(["r4"]).r4).toEqual({ error: missing.message }));
    expect(stored("r4")).toEqual([]);

    // Not on the next pass, 10 s later, but 30 s after the failed one; the error stays until then.
    await run(at("17:45:03Z"), hints);
    expect(hints).toHaveBeenCalledTimes(1);
    expect(purchaseStatus(["r4"]).r4).toEqual({ error: missing.message });
    await run(at("17:45:23Z"), hints);
    expect(hints).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(purchaseStatus(["r4"]).r4).toMatchObject({ purchaseId: "63", incident: true }));
    expect(purchaseStatus(["r4"]).r4.error).toBeUndefined();
  });

  it("stores no verdict when the VLM fails, and gives the purchase up after 30 minutes", async () => {
    store.scenarios = [recorded("r5")];
    const hints = vi.fn(async (): Promise<RecordingEvidence> => Promise.reject(new Error("HTTP 500: model overloaded")));
    await run(at("17:44:53Z"), hints);
    await vi.waitFor(() => expect(purchaseStatus(["r5"]).r5).toEqual({ error: "HTTP 500: model overloaded" }));
    // The gaps between attempts double: 30 s, 30 s, 60 s, so a recording is not re-encoded on every pass.
    for (const [time, attempts] of [["17:45:13Z", 1], ["17:45:23Z", 2], ["17:45:53Z", 3], ["17:46:43Z", 3], ["17:46:53Z", 4]] as const) {
      await run(at(time), hints);
      await new Promise((r) => setImmediate(r));
      expect(hints).toHaveBeenCalledTimes(attempts);
    }
    expect(stored("r5")).toEqual([]);
    hints.mockClear();
    // 18:21: both purchases of the till closed more than 30 minutes ago.
    await run(at("18:21:00Z"), hints);
    expect(hints).not.toHaveBeenCalled();
    expect(purchaseStatus(["r5"])).toEqual({});
    expect(stored("r5")).toEqual([]);
  });

  it("re-evaluates from the recording, and says when VST no longer has it", async () => {
    const s = recorded("r6");
    const read = deps(0).readTillEvents;
    const between = vi.fn(async () => HINTS);
    const hints = vi.fn(async () => EVIDENCE);
    const v = await reevaluatePurchase(s, "63", { readTillEvents: read, fetchHintsBetween: between, recordingHints: hints }, new Date(at("18:00:00Z")));
    expect(v).toMatchObject({ incident: true, evidence: "recording", chunksAsked: EVIDENCE.chunksAsked });
    expect(hints).toHaveBeenCalledWith(s, { start: `${D}17:42:51.000Z`, end: `${D}17:43:53.000Z` });
    expect(between).not.toHaveBeenCalled();
    expect(stored("r6")).toHaveLength(1);

    // Hours later VST has dropped the recording: a clear error, and the stored verdict stays.
    const gone = async (): Promise<RecordingEvidence> =>
      Promise.reject(new RecordingUnavailableError("VST has no recording of camera overhead-cam for the purchase window"));
    await expect(
      reevaluatePurchase(s, "63", { readTillEvents: read, fetchHintsBetween: between, recordingHints: gone }, new Date(at("23:00:00Z"))),
    ).rejects.toThrow(/^recording no longer available \(VST has no recording of camera overhead-cam/);
    expect(stored("r6")).toHaveLength(1);
    // Inside the minute VST needs, a missing recording is late, not gone.
    await expect(
      reevaluatePurchase(s, "63", { readTillEvents: read, fetchHintsBetween: between, recordingHints: gone }, new Date(at("17:44:00Z"))),
    ).rejects.toThrow(/^VST has no recording/);
  });
});
