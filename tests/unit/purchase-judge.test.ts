// The purchase judge (issue #59) against three recorded self-checkout purchases.
// Scans, times and baskets are the till's record; hints are the per-chunk alert
// texts the scanner camera raised live. Times are UTC, chunks 10 s.
import { describe, it, expect } from "vitest";
import {
  judgePurchase,
  recordedCameraIds,
  bookedCount,
  purchasesFromEvents,
  purchaseWindow,
  classify,
  purchaseIncident,
  purchaseVerdictOf,
  purchaseChatQuestion,
  multiFields,
  planChunks,
  evidenceError,
  recordingSettings,
  isNegative,
  DEFAULT_PRODUCT_CLASSES,
  DEFAULT_QUESTION,
  DEFAULT_RULES,
  DEFAULT_SYSTEM_PROMPT,
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
    expect(v.summary).toBe("Yes - snack packet - placed on the side table next to the scanner.");
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

  it("stores the evidence fields that are set and adds none (#60)", () => {
    const set = { evidence: "recording" as const, chunkS: 8, question: "Question: is a product carried away?" };
    const cameras = [{ id: "overhead-cam", crop: { x: 400, y: 200, width: 1100, height: 620 } }];
    expect(multiFields({ mode: "multi", cameras, ...set })).toEqual({
      mode: "multi",
      cameras,
      sources: [],
      rules: DEFAULT_RULES,
      ...set,
    });
    expect(multiFields({ mode: "single", ...set })).toEqual({});
  });
});

describe("back-to-back purchases: the customer before is still leaving", () => {
  const all = purchasesFromEvents([
    ...till(67, "19:35:10Z", [["19:35:20Z", ITEM.apple], ["19:35:22Z", ITEM.jelly], ["19:35:29Z", ITEM.pea]], "19:35:34Z"),
    ...till(68, "19:35:55Z", [["19:36:05Z", ITEM.jelly], ["19:36:09Z", ITEM.orange]], "19:36:13Z"),
  ]);
  const next = all.find((p) => p.id === "68")!;
  const leaving = hint("overhead-cam", "19:35:39Z", "Yes - The green packaged item is picked up and carried away without being scanned.");

  it("does not count a hint the previous purchase's basket explains", () => {
    const v = judgePurchase(next, [leaving], { ...CFG, neighbours: all });
    expect(v.incident).toBe(false);
    expect(v.hints[0].outcome).toBe("paid");
    expect(v.hints[0].reason).toContain("purchase 67");
  });

  it("counts it when the till record of the purchase before is unknown", () => {
    expect(judgePurchase(next, [leaving], CFG).incident).toBe(true);
  });

  it("still keeps a hint that no purchase explains", () => {
    const beside = hint("scanner-cam", "19:35:50Z", "Yes - snack packet - placed next to the scanner.");
    expect(judgePurchase(next, [beside], { ...CFG, neighbours: all }).incident).toBe(true);
  });
});

describe("bookedCount", () => {
  it("takes one scan back per void row", () => {
    expect(bookedCount([{ voided: false }, { voided: false }, { voided: true }])).toBe(1);
    expect(bookedCount([{ voided: true }])).toBe(0);
  });
});

describe("evidence from the recording (#60)", () => {
  const spans = (durationS: number, chunkS: number, overlapS: number) =>
    planChunks(durationS, chunkS, overlapS).map((c) => [c.startS, c.endS]);

  it("cuts a chunk every chunkS - overlapS seconds from the window start", () => {
    expect(spans(22, 10, 4)).toEqual([[0, 10], [6, 16], [12, 22]]);
    // A 62 s window, the defaults: 10 chunks.
    expect(spans(62, 10, 4)).toHaveLength(10);
    expect(spans(62, 10, 4).slice(0, 3)).toEqual([[0, 10], [6, 16], [12, 22]]);
  });

  it("moves the last chunk back so it ends with the window at full length", () => {
    expect(spans(20, 10, 4)).toEqual([[0, 10], [6, 16], [10, 20]]);
    expect(spans(62, 10, 4).at(-1)).toEqual([52, 62]);
    // No chunk twice when the grid already ends with the window.
    expect(spans(16, 10, 4)).toEqual([[0, 10], [6, 16]]);
  });

  it("puts chunks end to end with overlap 0", () => {
    expect(spans(30, 10, 0)).toEqual([[0, 10], [10, 20], [20, 30]]);
    expect(spans(25, 10, 0)).toEqual([[0, 10], [10, 20], [15, 25]]);
  });

  it("makes one chunk of a window shorter than a chunk, and none of an empty one", () => {
    expect(spans(7, 10, 4)).toEqual([[0, 7]]);
    expect(spans(10, 10, 4)).toEqual([[0, 10]]);
    expect(spans(0, 10, 4)).toEqual([]);
  });

  it("rounds a window with a fraction of a second up, so every chunk starts on a whole second", () => {
    expect(spans(21.3, 10, 4)).toEqual([[0, 10], [6, 16], [12, 22]]);
  });

  it("ends on settings the schema would refuse instead of looping", () => {
    expect(spans(13, 10, 10).length).toBeLessThan(10);
  });

  it("fills the defaults: 10 s chunks, 4 s overlap, 4 frames per second, the stock question and system prompt", () => {
    expect(recordingSettings({})).toEqual({
      chunkS: 10,
      overlapS: 4,
      framesPerSecond: 4,
      question: DEFAULT_QUESTION,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    expect(recordingSettings({ chunkS: 6, systemPrompt: "Watch the scanner." })).toMatchObject({ chunkS: 6, overlapS: 4, systemPrompt: "Watch the scanner." });
    expect(DEFAULT_QUESTION).toContain("scanner?\nAnswer with exactly No, or with Yes - <the product> - ");
  });

  it("accepts the defaults and the edges of every range", () => {
    expect(evidenceError({})).toBeNull();
    expect(evidenceError({ chunkS: 2, overlapS: 1, framesPerSecond: 8 })).toBeNull();
    expect(evidenceError({ chunkS: 30, overlapS: 29, framesPerSecond: 2 })).toBeNull();
    expect(evidenceError({ chunkS: 15, overlapS: 0, framesPerSecond: 4 })).toBeNull();
  });

  it("refuses more frames per request than the model takes, in words", () => {
    expect(evidenceError({ chunkS: 16, framesPerSecond: 4 })).toMatch(/64 frames per request; the model takes at most 60/);
    expect(evidenceError({ chunkS: 30, overlapS: 4, framesPerSecond: 3 })).toMatch(/90 frames/);
  });

  it("refuses values out of range, an overlap as long as the chunk, an empty question and a crop without a size", () => {
    expect(evidenceError({ chunkS: 1 })).toMatch(/Chunk length/);
    expect(evidenceError({ chunkS: 31 })).toMatch(/Chunk length/);
    expect(evidenceError({ chunkS: 7.5 })).toMatch(/Chunk length/);
    expect(evidenceError({ chunkS: 10, overlapS: 10 })).toMatch(/Overlap .* 0 to 9/);
    expect(evidenceError({ chunkS: 3 })).toMatch(/Overlap .* 0 to 2/);
    expect(evidenceError({ overlapS: -1 })).toMatch(/Overlap/);
    expect(evidenceError({ framesPerSecond: 0 })).toMatch(/Frames per second/);
    expect(evidenceError({ framesPerSecond: 9, chunkS: 5 })).toMatch(/Frames per second/);
    expect(evidenceError({ question: "  " })).toMatch(/question/);
    expect(evidenceError({ cameras: [{ id: "overhead-cam", crop: { x: 10, y: 10, width: 0, height: 480 } }] })).toMatch(/crop of camera overhead-cam/);
  });

  it("reads an answer that starts with No as no hint", () => {
    expect(isNegative("No")).toBe(true);
    expect(isNegative(" No. The person scans every item.")).toBe(true);
    expect(isNegative("Yes - snack packet - placed on the counter next to the scanner instead of scanning it")).toBe(false);
    expect(isNegative("Nothing is scanned; a bottle is carried away.")).toBe(false);
  });
});

describe("rule 2 with overlapping chunks", () => {
  // Paid at 19:02:36. A chunk that starts a second earlier shows the customer leaving with paid goods.
  const p = only(till(64, "19:02:20Z", [["19:02:27Z", ITEM.orange], ["19:02:29Z", ITEM.pea]], "19:02:36Z"));
  const leaving = "Yes - The green bag of chips is carried away from the scanner without being moved over it.";

  it("explains a carrying-away hint whose chunk reaches past the payment", () => {
    const v = judgePurchase(p, [hint("scanner-cam", "19:02:35Z", leaving)], CFG);
    expect(v.incident).toBe(false);
    expect(v.hints[0].outcome).toBe("paid");
  });

  it("keeps it when the chunk ends before the payment", () => {
    const early = only(till(64, "19:02:20Z", [["19:02:27Z", ITEM.orange]], "19:02:50Z"));
    const v = judgePurchase(early, [hint("scanner-cam", "19:02:35Z", leaving)], CFG);
    expect(v.incident).toBe(true);
  });
});

describe("window counted from the start of the purchase", () => {
  const rules = { ...DEFAULT_RULES, windowBeforeS: 10, windowAfterS: 10, windowFrom: "purchase-start" as const };

  it("opens before the till's start of the purchase when that start belongs to the scans", () => {
    const p = only(till(63, "17:43:18Z", [["17:43:21Z", ITEM.cola], ["17:43:26Z", ITEM.pea]], "17:43:33Z"));
    expect(purchaseWindow(p, rules)).toEqual({ start: `${D}17:43:08.000Z`, end: `${D}17:43:43.000Z` });
    // Without the setting it counts from the first scan, as before.
    expect(purchaseWindow(p, { ...DEFAULT_RULES, windowBeforeS: 10, windowAfterS: 10 })?.start).toBe(`${D}17:43:11.000Z`);
  });

  it("falls back to the first scan when the purchase was opened long before it", () => {
    const p = only(till(62, "17:06:00Z", [["17:37:40Z", ITEM.apple]], "17:37:49Z"));
    expect(purchaseWindow(p, rules)?.start).toBe(`${D}17:37:30.000Z`);
  });
});

describe("rule 2: leaving the picture counts as carrying away", () => {
  it("explains a paid bottle that is moved out of frame after the payment", () => {
    const p = only(till(70, "00:07:13Z", [["00:07:16Z", ITEM.cola], ["00:07:24Z", ITEM.orange]], "00:07:28Z"));
    const v = judgePurchase(p, [hint("overhead-cam", "00:07:29Z", "Yes - A green bottle is moved by the person to their right side and then out of frame.")], CFG);
    expect(v.incident).toBe(false);
    expect(v.hints[0].outcome).toBe("paid");
  });
});

describe("recordedCameraIds", () => {
  it("names the cameras of enabled multi-camera scenarios that are judged from the recording", () => {
    const cams = [{ id: "a" }, { id: "b" }];
    expect([
      ...recordedCameraIds([
        { mode: "multi", evidence: "recording", cameras: cams, enabled: true },
        { mode: "multi", cameras: [{ id: "live" }], enabled: true },
        { mode: "multi", evidence: "recording", cameras: [{ id: "off" }], enabled: false },
      ]),
    ]).toEqual(["a", "b"]);
  });
});
