// The purchase judge (issue #59) against three recorded self-checkout purchases.
// Scans, times and baskets are the till's record; hints are the per-chunk alert
// texts the scanner camera raised live. Times are UTC, chunks 10 s.
import { describe, it, expect } from "vitest";
import {
  judgePurchase,
  purchasesFromEvents,
  purchaseWindow,
  classify,
  purchaseIncident,
  purchaseVerdictOf,
  purchaseChatQuestion,
  multiFields,
  DEFAULT_PRODUCT_CLASSES,
  DEFAULT_RULES,
  type Hint,
  type TillEvent,
} from "@/lib/purchase-judge";
import { IncidentSchema } from "@/lib/schemas";

const D = "2026-11-18T";
const CAMERAS = [
  { id: "overhead-cam", view: "Checkout from above and behind" },
  { id: "scanner-cam", view: "Scanner glass from the front" },
];
const CFG = { scenarioId: "sco", scenarioName: "Self-checkout", sourceId: "till-1", cameras: CAMERAS };

const ITEM = {
  cola: { ean: "87126853", name: "Cola 0,33 l Flasche", price_cents: 200 },
  pea: { ean: "8413164023471", name: "Green Pea Piselli 28 g", price_cents: 120 },
  orange: { ean: "4004661080025", name: "Orangensaft 0,2 l", price_cents: 180 },
  apple: { ean: "4004661080223", name: "Apfelsaft 0,2 l", price_cents: 150 },
  jelly: { ean: "8690840176205", name: "Super Jelly Gummybears 64 g", price_cents: 80 },
};
type Item = (typeof ITEM)[keyof typeof ITEM];

/** A purchase as the till's events: started, one item_scanned per scan, closed with the basket. */
function till(sid: number, started: string, scans: [string, Item][], closed: string, extra: TillEvent[] = []): TillEvent[] {
  const basket = scans.map(([, i]) => ({ ...i, qty: 1, line_cents: i.price_cents }));
  return [
    { event: "purchase_started", ts: D + started, payload: { session_id: sid } },
    ...scans.map(([t, i], k) => ({
      event: "item_scanned",
      ts: D + t,
      payload: { session_id: sid, scan_id: 1000 + k, ean: i.ean, qty: 1, source: "scanner" },
    })),
    ...extra,
    {
      event: "purchase_closed",
      ts: D + closed,
      payload: { session_id: sid, items: basket, total_cents: basket.reduce((s, i) => s + i.price_cents, 0) },
    },
  ];
}

const hint = (cameraId: string, start: string, text: string): Hint => ({
  cameraId,
  start: D + start,
  end: new Date(Date.parse(D + start) + 10_000).toISOString(),
  text,
});

const only = (events: TillEvent[]) => {
  const ps = purchasesFromEvents(events);
  expect(ps).toHaveLength(1);
  return ps[0];
};

describe("purchase 63, theft: an item went past the scanner", () => {
  const p = only(till(63, "17:43:18Z", [["17:43:21Z", ITEM.cola], ["17:43:26Z", ITEM.pea], ["17:43:29Z", ITEM.orange]], "17:43:33Z"));
  const hints = [hint("scanner-cam", "17:43:08Z", "Yes - snack packet - placed on the side table next to the scanner.")];

  it("raises one high incident, seen by the scanner camera", () => {
    const v = judgePurchase(p, hints, CFG);
    expect(v.window).toEqual({ start: `${D}17:42:51.000Z`, end: `${D}17:43:53.000Z` });
    expect(v.incident).toBe(true);
    expect(v.severity).toBe("high");
    expect(v.camerasSaw).toEqual(["scanner-cam"]);
    expect(v.hints[0]).toMatchObject({ outcome: "remains", forms: ["bag"] });
    expect(v.summary).toContain("seen by 1 of 2 cameras (scanner-cam)");
    expect(v.summary).toContain("total 5.00");
    // Names come from the paid basket; scans only carry an EAN.
    expect(v.scans.map((s) => s.name)).toEqual([ITEM.cola.name, ITEM.pea.name, ITEM.orange.name]);
  });

  it("is still an incident with the new witness prompt's German answer", () => {
    const v = judgePurchase(p, [hint("scanner-cam", "17:43:08Z", "Ja - gelbe Tuete - neben dem Scanner vorbei - 4")], CFG);
    expect(v.incident).toBe(true);
    expect(v.hints[0]).toMatchObject({ forms: ["bag"], colours: ["yellow"] });
  });

  it("is no incident when a bag was scanned within the tolerance of the chunk", () => {
    const early = only(till(63, "17:43:18Z", [["17:43:20Z", ITEM.pea]], "17:43:33Z"));
    const v = judgePurchase(early, hints, CFG);
    expect(v.incident).toBe(false);
    expect(v.hints[0].outcome).toBe("scanned");
    expect(v.hints[0].reason).toContain("Rule 1");
  });

  it("ignores hints of cameras the scenario does not name and hints outside the window", () => {
    const v = judgePurchase(
      p,
      [hint("other-cam", "17:43:08Z", "Yes - snack packet"), hint("scanner-cam", "17:40:00Z", "Yes - snack packet")],
      CFG,
    );
    expect(v.hints).toEqual([]);
    expect(v.incident).toBe(false);
  });
});

describe("purchase 64, honest: two false alarms the till explains", () => {
  // Session opened 12 min earlier, with a tile booking and its void; the window
  // starts at the last block of scans, not there.
  const events = till(
    64,
    "18:50:01Z",
    [["19:02:27Z", ITEM.orange], ["19:02:29Z", ITEM.pea], ["19:02:31Z", ITEM.jelly]],
    "19:02:36Z",
    [
      { event: "item_scanned", ts: `${D}18:50:04Z`, payload: { session_id: 64, scan_id: 292, ean: "9103", source: "tile" } },
      { event: "item_voided", ts: `${D}19:00:15Z`, payload: { session_id: 64, scan_id: 293, ean: "9103", qty: -1 } },
    ],
  );
  const hints = [
    hint("scanner-cam", "19:02:18Z", "Yes - The bottle is lifted and moved away without being scanned."),
    hint("scanner-cam", "19:02:38Z", "Yes - The person picks up the bottle and walks away without scanning it."),
  ];

  it("discards both hints and raises nothing", () => {
    const v = judgePurchase(only(events), hints, CFG);
    expect(v.window).toEqual({ start: `${D}19:01:57.000Z`, end: `${D}19:02:56.000Z` });
    expect(v.hints.map((h) => h.outcome)).toEqual(["scanned", "paid"]);
    expect(v.hints[0].reason).toContain("Orangensaft 0,2 l (bottle) was scanned at 19:02:27 UTC");
    expect(v.hints[1].reason).toContain("Rule 2");
    expect(v.incident).toBe(false);
    expect(v.severity).toBeNull();
    expect(v.summary).toContain("all 2 camera hints explained by the till");
  });

  it("keeps the after-payment hint when nothing of its class was paid", () => {
    const bagsOnly = only(till(64, "18:50:01Z", [["19:02:29Z", ITEM.pea]], "19:02:36Z"));
    const v = judgePurchase(bagsOnly, [hints[1]], CFG);
    expect(v.hints[0].outcome).toBe("remains");
    expect(v.incident).toBe(true);
  });
});

describe("purchase 62, honest without hints", () => {
  it("raises nothing", () => {
    const p = only(till(62, "17:06:07Z", [["17:37:40Z", ITEM.apple], ["17:37:42Z", ITEM.cola], ["17:37:45Z", ITEM.jelly]], "17:37:49Z"));
    const v = judgePurchase(p, [], CFG);
    expect(v.window).toEqual({ start: `${D}17:37:10.000Z`, end: `${D}17:38:09.000Z` });
    expect(v.incident).toBe(false);
    expect(v.summary).toContain("no camera hints");
  });
});

describe("robustness", () => {
  const p = only(till(1, "10:00:00Z", [["10:00:10Z", ITEM.cola]], "10:00:20Z"));

  it("never crashes on unknown or empty hint text", () => {
    for (const text of ["", "%%%", "Yes", "Ja - ??? - 9", "\u0000￿", "x".repeat(5000)]) {
      expect(() => judgePurchase(p, [hint("scanner-cam", "10:00:30Z", text)], CFG)).not.toThrow();
    }
    // A hint without form or colour words cannot rule a scanned item out.
    expect(judgePurchase(p, [hint("scanner-cam", "10:00:05Z", "Yes - item moved")], CFG).hints[0].outcome).toBe("scanned");
  });

  it("drops a No answer", () => {
    const v = judgePurchase(p, [hint("scanner-cam", "10:00:30Z", "No - nothing happens")], CFG);
    expect(v.hints[0].outcome).toBe("negative");
    expect(v.incident).toBe(false);
  });

  it("assumes a 10 s chunk when an alert has no end", () => {
    const v = judgePurchase(p, [{ cameraId: "scanner-cam", start: `${D}10:00:00Z`, text: "Yes - bottle" }], CFG);
    expect(v.hints[0]).toMatchObject({ end: `${D}10:00:10.000Z`, outcome: "scanned" });
  });

  it("does not return a purchase that has not ended, and judges one without scans as nothing", () => {
    expect(purchasesFromEvents([{ event: "purchase_started", ts: `${D}10:00:00Z`, payload: { session_id: 2 } }])).toEqual([]);
    const empty = only([
      { event: "purchase_started", ts: `${D}10:00:00Z`, payload: { session_id: 3 } },
      { event: "purchase_cancelled", ts: `${D}10:01:00Z`, payload: { session_id: 3 } },
    ]);
    const v = judgePurchase(empty, [hint("scanner-cam", "10:00:30Z", "Yes - bag")], CFG);
    expect(v).toMatchObject({ status: "cancelled", window: null, incident: false, hints: [] });
  });

  it("starts the window at the last block of scans", () => {
    const p2 = only(till(4, "09:00:00Z", [["09:00:10Z", ITEM.cola], ["09:05:00Z", ITEM.cola], ["09:05:50Z", ITEM.cola]], "09:06:00Z"));
    expect(purchaseWindow(p2, DEFAULT_RULES)?.start).toBe(`${D}09:04:30.000Z`);
  });
});

describe("product classes", () => {
  it("derives forms from the names by default", () => {
    const form = (n: string) => classify(n, DEFAULT_PRODUCT_CLASSES).form;
    expect(form("Cola 0,33 l Flasche")).toBe("bottle");
    expect(form("Orangensaft 0,2 l")).toBe("bottle");
    expect(form("Natur Radler")).toBe("bottle");
    expect(form("Cola Gummybears 80 g")).toBe("bag");
    expect(form("Green Pea Piselli 28 g")).toBe("bag");
    expect(form("Peanut 45 g")).toBe("bag");
    expect(form("Sandwich Cheese and Chives 37 g")).toBe("box");
    expect(form("Wassermelone")).toBeUndefined();
    expect(form("Kaiserbrötchen")).toBeUndefined();
  });

  it("takes the operator's mapping, colour included, and a colour contradiction keeps the hint", () => {
    const classes = [{ pattern: "jelly", form: "bag" as const, colour: "Gelb" }, ...DEFAULT_PRODUCT_CLASSES];
    expect(classify("Super Jelly Gummybears 64 g", classes)).toEqual({ form: "bag", colour: "yellow" });
    const p = only(till(5, "10:00:00Z", [["10:00:10Z", ITEM.jelly]], "10:00:20Z"));
    const green = judgePurchase(p, [hint("scanner-cam", "10:00:05Z", "Yes - green bag")], { ...CFG, productClasses: classes });
    expect(green.hints[0].outcome).toBe("remains");
    const yellow = judgePurchase(p, [hint("scanner-cam", "10:00:05Z", "Ja - gelbe Tuete")], { ...CFG, productClasses: classes });
    expect(yellow.hints[0].outcome).toBe("scanned");
  });
});

describe("as an incident", () => {
  const p = only(till(63, "17:43:18Z", [["17:43:21Z", ITEM.cola]], "17:43:33Z"));
  const v = judgePurchase(p, [hint("scanner-cam", "17:43:08Z", "Yes - snack packet")], CFG);

  it("is a valid incident row spanning the purchase window, and round-trips its verdict", () => {
    const inc = purchaseIncident(v);
    expect(IncidentSchema.safeParse(inc).success).toBe(true);
    expect(inc).toMatchObject({ ts: v.window!.start, sensorId: "overhead-cam", severity: "high", topic: "purchase" });
    expect((inc.raw as { end: string }).end).toBe(v.window!.end);
    expect(purchaseVerdictOf(inc)).toEqual(v);
    expect(purchaseVerdictOf({ raw: { end: "x" } })).toBeNull();
  });

  it("opens the chat with the till record and every camera", () => {
    const q = purchaseChatQuestion(v);
    expect(q).toContain("purchase 63");
    expect(q).toContain(`Cola 0,33 l Flasche at ${D}17:43:21.000Z`);
    expect(q).toContain("total 2.00");
    expect(q).toContain("overhead-cam (Checkout from above and behind), scanner-cam (Scanner glass from the front)");
    expect(q).toContain(`from ${v.window!.start} to ${v.window!.end}`);
  });
});

describe("multiFields", () => {
  it("stores nothing extra for a single-camera scenario and fills defaults for a multi one", () => {
    expect(multiFields({ mode: "single", cameras: [{ id: "a" }] })).toEqual({});
    expect(multiFields({})).toEqual({});
    expect(multiFields({ mode: "multi" })).toEqual({ mode: "multi", cameras: [], sources: [], rules: DEFAULT_RULES });
  });
});
