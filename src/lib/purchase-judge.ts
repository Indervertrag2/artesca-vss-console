// Multi-camera scenarios: one incident per purchase, judged against the till.
//
// The till is the clock: its purchases decide what "one purchase" is and which
// time window is looked at. The cameras are witnesses: their per-chunk VLM
// alerts ("Yes - snack packet - placed next to the scanner") are hints, and the
// rules here decide in code which hints the till explains. A VLM asked to judge
// a whole purchase alarmed on almost every honest one, so it never decides.
//
// Pure, no server-only: the scenarios form, the incident detail and the runner
// (purchase-runner.ts) share it.
import { z } from "zod";
import type { Incident } from "@/lib/types";

// ─── Scenario fields ──────────────────────────────────────────────────────────

export const PRODUCT_FORMS = ["bottle", "bag", "box", "can"] as const;
export type ProductForm = (typeof PRODUCT_FORMS)[number];

const ENTITY_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const PurchaseRulesSchema = z
  .object({
    matchToleranceS: z.number().min(0).max(60),
    windowBeforeS: z.number().min(0).max(600),
    windowAfterS: z.number().min(0).max(600),
    /** What `windowBeforeS` counts back from; absent = the first scan. */
    windowFrom: z.enum(["first-scan", "purchase-start"]).optional(),
  })
  .strict();
export type PurchaseRules = z.infer<typeof PurchaseRulesSchema>;

const ProductClassSchema = z
  .object({
    /** Name fragments separated by "|", matched case-insensitively. Not a regex. */
    pattern: z.string().min(1).max(500),
    form: z.enum(PRODUCT_FORMS),
    colour: z.string().max(40).optional(),
  })
  .strict();
export type ProductClass = z.infer<typeof ProductClassSchema>;

const PX = z.number().int().min(0).max(16384);
/** The part of a camera's picture the model is shown, in pixels of the source picture. */
const CropSchema = z.object({ x: PX, y: PX, width: PX, height: PX }).strict();

/**
 * The scenario fields of the multi-camera mode, shared by the client schema
 * (`ScenarioSchema`) and the strict restore schema (`FillScenarioSchema`). All
 * optional: a scenario without `mode` is a single-camera scenario, as before.
 */
export const ScenarioMultiFields = {
  mode: z.enum(["single", "multi"]).optional(),
  cameras: z
    .array(z.object({ id: ENTITY_ID, view: z.string().max(500).optional(), crop: CropSchema.optional() }).strict())
    .max(64)
    .optional(),
  sources: z
    .array(z.object({ id: ENTITY_ID, role: z.enum(["clock", "witness"]) }).strict())
    .max(16)
    .optional(),
  rules: PurchaseRulesSchema.optional(),
  productClasses: z.array(ProductClassSchema).max(100).optional(),
  // Where the hints come from. Absent or "live": the per-chunk alerts of the live
  // stream. "recording": the recording of the purchase, cut into overlapping
  // chunks (purchase-recording.ts). `evidenceError` checks the ranges, on every write.
  evidence: z.enum(["live", "recording"]).optional(),
  chunkS: z.number().optional(),
  overlapS: z.number().optional(),
  framesPerSecond: z.number().optional(),
  question: z.string().max(2000).optional(),
  systemPrompt: z.string().max(2000).optional(),
};
const ScenarioMultiSchema = z.object(ScenarioMultiFields);
export type ScenarioMulti = z.infer<typeof ScenarioMultiSchema>;
export type ScenarioCamera = NonNullable<ScenarioMulti["cameras"]>[number];

/** The multi-camera fields of a scenario, or none at all for a single-camera one,
 *  so a single-camera scenario is stored exactly as before. The evidence fields
 *  are stored only when set, so a scenario without them is stored as before too. */
export function multiFields(s: ScenarioMulti): ScenarioMulti {
  if (s.mode !== "multi") return {};
  const evidence: ScenarioMulti = {
    evidence: s.evidence,
    chunkS: s.chunkS,
    overlapS: s.overlapS,
    framesPerSecond: s.framesPerSecond,
    question: s.question,
    systemPrompt: s.systemPrompt,
  };
  return {
    mode: "multi",
    cameras: s.cameras ?? [],
    sources: s.sources ?? [],
    rules: s.rules ?? DEFAULT_RULES,
    ...(s.productClasses ? { productClasses: s.productClasses } : {}),
    ...Object.fromEntries(Object.entries(evidence).filter(([, v]) => v !== undefined)),
  };
}

/** Cameras of enabled multi-camera scenarios that are judged from the recording of a
 *  purchase: the model looks at them after each purchase, without a live rule. */
export function recordedCameraIds(scenarios: (ScenarioMulti & { enabled?: boolean })[]): Set<string> {
  return new Set(
    scenarios
      .filter((s) => s.enabled !== false && s.mode === "multi" && s.evidence === "recording")
      .flatMap((s) => (s.cameras ?? []).map((c) => c.id)),
  );
}

export const DEFAULT_RULES: PurchaseRules = { matchToleranceS: 3, windowBeforeS: 30, windowAfterS: 20 };

/**
 * Used while a scenario has no `productClasses` of its own. First match wins, so
 * "Cola Gummybears" is a bag and not a bottle. Fragments are deliberately long
 * enough not to hit produce or bakery names ("wasser" would hit "Wassermelone").
 */
export const DEFAULT_PRODUCT_CLASSES: ProductClass[] = [
  { pattern: "cracker|crispbread|knaecke|zwieback|biscuit|keks|sandwich", form: "box" },
  {
    pattern: "gummy|gummi|bears|jelly|snack|chips|crisps|piselli|green pea|peanut|candy|bonbon|schoko|chocolate",
    form: "bag",
  },
  { pattern: "saft|juice|cola|coke|water|radler|bier|beer|limo|drink|flasche|bottle", form: "bottle" },
];

// ─── Evidence from the recording ──────────────────────────────────────────────

export const DEFAULT_QUESTION =
  "Question: in these frames, does a person move a product past the scanner, or carry a product away from the checkout, without first moving that product over the scanner?\n" +
  "Answer with exactly No, or with Yes - <the product> - <what the person did with it, in one short sentence>.";
export const DEFAULT_SYSTEM_PROMPT =
  "You are a retail video monitoring assistant. Report only relevant events for the alert type.";
/** Frames the model takes per request: about 25.7 million pixels at 854x480. */
export const MAX_FRAMES_PER_CHUNK = 60;

export interface RecordingSettings {
  chunkS: number;
  overlapS: number;
  framesPerSecond: number;
  question: string;
  systemPrompt: string;
}

/** A scenario's recording settings with the defaults filled in. */
export function recordingSettings(s: ScenarioMulti): RecordingSettings {
  return {
    chunkS: s.chunkS ?? 10,
    overlapS: s.overlapS ?? 4,
    framesPerSecond: s.framesPerSecond ?? 4,
    question: s.question ?? DEFAULT_QUESTION,
    systemPrompt: s.systemPrompt || DEFAULT_SYSTEM_PROMPT,
  };
}

/** Why a scenario's evidence settings cannot be used, in words for the operator; null when they can. */
export function evidenceError(s: ScenarioMulti): string | null {
  const r = recordingSettings(s);
  const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (!whole(r.chunkS, 2, 30)) return "Chunk length must be a whole number of seconds from 2 to 30.";
  if (!whole(r.overlapS, 0, r.chunkS - 1)) {
    return `Overlap must be a whole number of seconds from 0 to ${r.chunkS - 1}: shorter than the ${r.chunkS} s chunk.`;
  }
  if (!whole(r.framesPerSecond, 1, 8)) return "Frames per second must be a whole number from 1 to 8.";
  const frames = r.chunkS * r.framesPerSecond;
  if (frames > MAX_FRAMES_PER_CHUNK) {
    return `${r.chunkS} s chunks at ${r.framesPerSecond} frames per second are ${frames} frames per request; the model takes at most ${MAX_FRAMES_PER_CHUNK}. Shorten the chunk or lower the frames per second.`;
  }
  if (!r.question.trim()) return "The question to the model is empty.";
  const cropped = (s.cameras ?? []).find((c) => c.crop && !(c.crop.width > 0 && c.crop.height > 0));
  if (cropped) return `The crop of camera ${cropped.id || "(no id)"} needs a width and a height.`;
  return null;
}

/** `evidenceError` as a schema check, for the schemas a scenario is written through. */
export function refineEvidence(s: ScenarioMulti, ctx: z.RefinementCtx): void {
  const message = evidenceError(s);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["evidence"] });
}

/**
 * The chunks a recording of `durationS` seconds is cut into, as offsets from its
 * start: one every `chunkS - overlapS` seconds from 0, each `chunkS` long. The
 * last one ends with the recording, moved back so that it is full length too. A
 * recording shorter than a chunk is one chunk. Whole seconds, because the
 * recording is cut at its keyframes, one per second.
 */
export function planChunks(durationS: number, chunkS: number, overlapS: number): { startS: number; endS: number }[] {
  const total = Math.ceil(durationS);
  if (total <= chunkS) return total > 0 ? [{ startS: 0, endS: total }] : [];
  const step = Math.max(1, chunkS - overlapS);
  const out: { startS: number; endS: number }[] = [];
  for (let startS = 0; startS + chunkS < total; startS += step) out.push({ startS, endS: startS + chunkS });
  out.push({ startS: total - chunkS, endS: total });
  return out;
}

/** Gap that splits a purchase's scans into blocks; the window starts at the last block. */
export const SCAN_BLOCK_GAP_S = 60;
/** Judged this long after the window closes, so the last chunk answers have arrived. */
export const EVALUATION_DELAY_S = 30;
/** Chunk length assumed for an alert that carries no end. */
const DEFAULT_CHUNK_S = 10;

// ─── Till ─────────────────────────────────────────────────────────────────────

/** One stored till event (External Sources): event name, the till's own time, payload. */
export interface TillEvent {
  event: string;
  ts: string | null;
  payload: Record<string, unknown>;
}

export interface TillScan {
  ts: string;
  ean: string;
  name: string;
  voided: boolean;
}

export interface TillItem {
  name: string;
  ean?: string;
  qty: number;
  priceCents?: number;
}

export interface Purchase {
  id: string;
  startedAt?: string;
  closedAt: string;
  status: "closed" | "cancelled" | "timeout";
  scans: TillScan[];
  /** The paid basket; empty unless the purchase was closed. */
  items: TillItem[];
  totalCents?: number;
}

const END_STATUS: Record<string, Purchase["status"]> = {
  purchase_closed: "closed",
  purchase_cancelled: "cancelled",
  purchase_timeout: "timeout",
};

const ms = (iso: string | undefined | null) => (iso ? Date.parse(iso) : NaN);
const iso = (t: number) => new Date(t).toISOString();

function parseItems(raw: unknown): TillItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const ean = typeof o.ean === "string" ? o.ean : undefined;
    const name = typeof o.name === "string" && o.name ? o.name : ean;
    if (!name) return [];
    return [
      {
        name,
        ...(ean ? { ean } : {}),
        qty: typeof o.qty === "number" ? o.qty : 1,
        ...(typeof o.price_cents === "number" ? { priceCents: o.price_cents } : {}),
      },
    ];
  });
}

/**
 * The finished purchases in a till's event log, grouped by the till's session
 * id. A purchase without an end event is still open and not returned. Scans
 * carry only an EAN; the name comes from the paid basket of the end event.
 */
export function purchasesFromEvents(events: TillEvent[]): Purchase[] {
  const bySession = new Map<string, TillEvent[]>();
  for (const e of events) {
    const sid = e.payload?.session_id;
    if (!Number.isFinite(ms(e.ts)) || (typeof sid !== "string" && typeof sid !== "number")) continue;
    const list = bySession.get(String(sid)) ?? [];
    list.push(e);
    bySession.set(String(sid), list);
  }
  const out: Purchase[] = [];
  for (const [id, evs] of bySession) {
    evs.sort((a, b) => ms(a.ts) - ms(b.ts));
    const end = evs.findLast((e) => END_STATUS[e.event]);
    if (!end) continue;
    const items = END_STATUS[end.event] === "closed" ? parseItems(end.payload.items) : [];
    const nameOf = new Map(items.flatMap((i) => (i.ean ? [[i.ean, i.name] as const] : [])));
    const scans = evs
      .filter((e) => e.event === "item_scanned" || e.event === "item_voided")
      .map((e) => {
        const ean = typeof e.payload.ean === "string" || typeof e.payload.ean === "number" ? String(e.payload.ean) : "";
        const name = typeof e.payload.name === "string" && e.payload.name ? e.payload.name : nameOf.get(ean) || ean || "unknown item";
        return { ts: e.ts as string, ean, name, voided: e.event === "item_voided" };
      });
    const started = evs.find((e) => e.event === "purchase_started");
    out.push({
      id,
      ...(started?.ts ? { startedAt: started.ts } : {}),
      closedAt: end.ts as string,
      status: END_STATUS[end.event],
      scans,
      items,
      ...(typeof end.payload.total_cents === "number" ? { totalCents: end.payload.total_cents } : {}),
    });
  }
  return out;
}

/**
 * The time looked at for one purchase: from the first scan of the last block of
 * scans (gaps of at most 60 s) minus `windowBeforeS`, to the end of the purchase
 * plus `windowAfterS`. A session can stay open for half an hour before anyone
 * scans, so it is not the session start. With `windowFrom: "purchase-start"` it
 * counts back from the till's start of the purchase instead, when that start
 * belongs to the same block (at most 60 s before its first scan): an item put
 * aside just before the first scan then lies well inside the window.
 * Null when nothing was scanned.
 */
export function purchaseWindow(p: Purchase, rules: PurchaseRules): { start: string; end: string } | null {
  const times = p.scans
    .map((s) => ms(s.ts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!times.length) return null;
  let first = times[times.length - 1];
  for (let i = times.length - 1; i > 0 && times[i] - times[i - 1] <= SCAN_BLOCK_GAP_S * 1000; i--) first = times[i - 1];
  const begun = ms(p.startedAt);
  const from =
    rules.windowFrom === "purchase-start" && begun <= first && first - begun <= SCAN_BLOCK_GAP_S * 1000 ? begun : first;
  return { start: iso(from - rules.windowBeforeS * 1000), end: iso(ms(p.closedAt) + rules.windowAfterS * 1000) };
}

// ─── Words ────────────────────────────────────────────────────────────────────

/** Lower case, German umlauts spelled out, so "Tüte", "Tuete" and "TUETE" read the same. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

const FORM_WORDS: Record<ProductForm, RegExp> = {
  bottle: /bottle|flasche|juice|saft|drink|getraenk/,
  bag: /\bbags?\b|packet|package|\bpack\b|pouch|snack|tuete|beutel|gumm|chips|crisps|candy|sweets/,
  box: /\bbox(es)?\b|carton|karton|schachtel|cracker/,
  can: /\bcans?\b|\bdosen?\b/,
};

const COLOUR_WORDS: Record<string, RegExp> = {
  yellow: /yellow|\bgelb/,
  red: /\bred\b|\brot(e|en|er|es)?\b/,
  green: /green|\bgruen/,
  blue: /\bblue|\bblau/,
  orange: /\borange\b/,
  white: /white|\bweiss/,
  black: /black|schwarz/,
  brown: /brown|\bbraun/,
  purple: /purple|violet|\blila\b/,
  pink: /\bpink|\brosa\b/,
  silver: /silver|silber/,
};

/** A hint about something leaving: after payment that is the customer going home. */
const CARRY_AWAY =
  /\baway\b|walks? off|\bleav(es|ing)\b|\bcarr(y|ies|ied|ying)\b|\btak(es|en|ing)\b|\btook\b|picks? up|picked up|\bremov(es|ed|ing)\b|pocket|out of (the )?(frame|view|picture|shot)|\bweg\b|mitgenommen|\bnimmt\b|traegt|\bgeht\b/;

/** A "No" answer is not a hint, whatever else it says. */
const NEGATIVE = /^\W*(no|nein)\b/;

/** Whether a model's answer is a "No": then it is not a hint. */
export const isNegative = (text: string) => NEGATIVE.test(normalize(text));

const formsIn = (n: string) => PRODUCT_FORMS.filter((f) => FORM_WORDS[f].test(n));
const coloursIn = (n: string) => Object.keys(COLOUR_WORDS).filter((c) => COLOUR_WORDS[c].test(n));

/** The class of a product name: the first matching rule's form and colour. */
export function classify(name: string, classes: ProductClass[]): { form?: ProductForm; colour?: string } {
  const n = normalize(name);
  const hit = classes.find((c) =>
    c.pattern
      .split("|")
      .map((p) => normalize(p.trim()))
      .some((p) => p && n.includes(p)),
  );
  if (!hit) return {};
  const colour = hit.colour ? coloursIn(normalize(hit.colour))[0] : undefined;
  return { form: hit.form, ...(colour ? { colour } : {}) };
}

/** A hint and an item match unless their words contradict: a hint without form or
 *  colour words, or an item of unknown class, cannot rule the other out. */
function compatible(h: { forms: ProductForm[]; colours: string[] }, c: { form?: ProductForm; colour?: string }): boolean {
  const formOk = !h.forms.length || !c.form || h.forms.includes(c.form);
  const colourOk = !h.colours.length || !c.colour || h.colours.includes(c.colour);
  return formOk && colourOk;
}

// ─── Judge ────────────────────────────────────────────────────────────────────

/** One per-chunk camera alert: camera, chunk span, the model's answer. */
export interface Hint {
  cameraId: string;
  start: string;
  end?: string;
  text: string;
}

/** remains = unexplained; scanned = rule 1; paid = rule 2; negative = a "No" answer. */
export type HintOutcome = "remains" | "scanned" | "paid" | "negative";

export interface JudgedHint {
  cameraId: string;
  start: string;
  end: string;
  text: string;
  forms: ProductForm[];
  colours: string[];
  outcome: HintOutcome;
  reason: string;
}

export interface PurchaseVerdict {
  scenarioId: string;
  scenarioName: string;
  sourceId: string;
  purchaseId: string;
  status: Purchase["status"];
  startedAt?: string;
  closedAt: string;
  window: { start: string; end: string } | null;
  scans: (TillScan & { form?: ProductForm; colour?: string })[];
  items: TillItem[];
  totalCents?: number;
  cameras: ScenarioCamera[];
  hints: JudgedHint[];
  incident: boolean;
  severity: "high" | null;
  /** Cameras with at least one unexplained hint. */
  camerasSaw: string[];
  summary: string;
  /** Set when the hints came from the recording of the purchase; absent on a verdict
   *  from the live alerts. With it: the chunking, and the chunks put to the model per camera. */
  evidence?: "recording";
  chunkS?: number;
  overlapS?: number;
  chunksAsked?: Record<string, number>;
}

export interface JudgeConfig {
  scenarioId: string;
  scenarioName: string;
  sourceId: string;
  cameras: ScenarioCamera[];
  rules?: PurchaseRules;
  productClasses?: ProductClass[];
  /** The till's other finished purchases. Windows of back-to-back purchases overlap:
   *  the customer before is still carrying paid goods away when the next window
   *  opens, so a hint a neighbour's till record explains does not count here. */
  neighbours?: Purchase[];
}

/** Items booked net of voids: a void row takes one scan back. */
export const bookedCount = (scans: { voided: boolean }[]) =>
  Math.max(0, scans.length - 2 * scans.filter((s) => s.voided).length);

export const clock = (t: string) => `${iso(ms(t)).slice(11, 19)} UTC`;
export const money = (cents: number | undefined) => (cents === undefined ? "unknown" : (cents / 100).toFixed(2));
const what = (forms: string[], colours: string[]) => [...colours, ...forms].join(" ") || "item";
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Judge one finished purchase. Hints outside the purchase window or from a camera
 * the scenario does not name are ignored; every other hint either is explained by
 * the till (rule 1: an item of a matching class was scanned within
 * `matchToleranceS` of the hint's chunk; rule 2: after payment, a paid item of a
 * matching class is being carried away) or remains. A neighbouring purchase's till
 * record explains a hint by the same two rules. Any remaining hint makes the
 * purchase one incident, high because the till and at least one camera agree that
 * something went past the till. No cooldown: every purchase is judged on its own.
 */
export function judgePurchase(p: Purchase, hints: Hint[], cfg: JudgeConfig): PurchaseVerdict {
  const rules = cfg.rules ?? DEFAULT_RULES;
  const classes = cfg.productClasses ?? DEFAULT_PRODUCT_CLASSES;
  const window = purchaseWindow(p, rules);
  const tol = rules.matchToleranceS * 1000;
  const closedAt = ms(p.closedAt);
  /** What one purchase's till record can explain: its scans, its paid basket, and until when. */
  const record = (x: Purchase, other: boolean) => ({
    id: x.id,
    other,
    scans: x.scans.map((s) => ({ ...s, ...classify(s.name, classes) })),
    paid: x.items.map((i) => ({ name: i.name, ...classify(i.name, classes) })),
    closedAt: ms(x.closedAt),
    end: ms(x.closedAt) + rules.windowAfterS * 1000,
  });
  const own = record(p, false);
  const scans = own.scans;
  const cameraIds = new Set(cfg.cameras.map((c) => c.id));
  // Neighbours whose time at the till touches this window, the nearest first.
  const neighbours = !window
    ? []
    : (cfg.neighbours ?? [])
        .filter((o) => !(o.id === p.id && o.closedAt === p.closedAt))
        .filter((o) => {
          const w = purchaseWindow(o, rules);
          return !!w && ms(w.end) + tol >= ms(window.start) && ms(w.start) - tol <= ms(window.end);
        })
        .map((o) => record(o, true))
        .sort((a, b) => Math.abs(a.closedAt - closedAt) - Math.abs(b.closedAt - closedAt));

  /** Rule 1 or rule 2 of one till record for one hint, or nothing. */
  const explain = (
    rec: ReturnType<typeof record>,
    seen: { forms: ProductForm[]; colours: string[] },
    n: string,
    s: number,
    e: number,
  ): { outcome: HintOutcome; reason: string } | null => {
    const scanned = rec.scans.find((sc) => {
      const t = ms(sc.ts);
      return !sc.voided && t >= s - tol && t <= e + tol && compatible(seen, sc);
    });
    if (scanned) {
      return {
        outcome: "scanned",
        reason: `Rule 1: ${scanned.name}${scanned.form ? ` (${scanned.form})` : ""} was scanned at ${clock(scanned.ts)}${rec.other ? ` in purchase ${rec.id}` : ""}, within ${rules.matchToleranceS} s of this chunk.`,
      };
    }
    // "After payment" is a chunk that reaches past it, not one that starts after it:
    // an overlapping chunk that begins a second before the payment shows the same
    // customer leaving with the paid goods.
    const carried =
      e > rec.closedAt && s <= rec.end && CARRY_AWAY.test(n) ? rec.paid.find((i) => compatible(seen, i)) : undefined;
    if (carried) {
      return {
        outcome: "paid",
        reason: rec.other
          ? `Rule 2: after the payment of purchase ${rec.id}, and it describes carrying away a ${what(seen.forms, seen.colours)}; ${carried.name} was paid there.`
          : `Rule 2: after payment, and it describes carrying away a ${what(seen.forms, seen.colours)}; ${carried.name} was paid.`,
      };
    }
    return null;
  };

  const judged: JudgedHint[] = !window
    ? []
    : hints
        .filter((h) => cameraIds.has(h.cameraId))
        .map((h) => {
          const s = ms(h.start);
          const e = ms(h.end);
          return { h, s, e: Number.isFinite(e) && e >= s ? e : s + DEFAULT_CHUNK_S * 1000 };
        })
        .filter(({ s, e }) => Number.isFinite(s) && e >= ms(window.start) && s <= ms(window.end))
        .sort((a, b) => a.s - b.s)
        .map(({ h, s, e }): JudgedHint => {
          const text = typeof h.text === "string" ? h.text : "";
          const n = normalize(text);
          const forms = formsIn(n);
          const colours = coloursIn(n);
          const base = { cameraId: h.cameraId, start: iso(s), end: iso(e), text, forms, colours };
          if (NEGATIVE.test(n)) return { ...base, outcome: "negative", reason: "The camera answered no." };
          for (const rec of [own, ...neighbours]) {
            const explained = explain(rec, base, n, s, e);
            if (explained) return { ...base, ...explained };
          }
          return {
            ...base,
            outcome: "remains",
            reason: `No ${what(forms, colours)} was scanned within ${rules.matchToleranceS} s of this chunk${s >= closedAt ? ", and no paid item matches it" : ""}.`,
          };
        });

  const remaining = judged.filter((j) => j.outcome === "remains");
  const camerasSaw = [...new Set(remaining.map((j) => j.cameraId))];
  const incident = remaining.length > 0;
  const booked = bookedCount(scans);
  const till = `Till: ${booked} item${booked === 1 ? "" : "s"} scanned, total ${money(p.totalCents)}.`;
  const summary = !window
    ? `Purchase ${p.id}: nothing scanned, nothing to judge.`
    : incident
      ? // What triggered it, in the camera's own words: the first hint the till does not explain.
        // Which cameras saw it and what the till booked are the detail view's "Why".
        remaining[0].text
      :`Purchase ${p.id}: ${judged.length ? `all ${judged.length} camera hint${judged.length === 1 ? "" : "s"} explained by the till` : "no camera hints"}. ${till}`;

  return {
    scenarioId: cfg.scenarioId,
    scenarioName: cfg.scenarioName,
    sourceId: cfg.sourceId,
    purchaseId: p.id,
    status: p.status,
    ...(p.startedAt ? { startedAt: p.startedAt } : {}),
    closedAt: p.closedAt,
    window,
    scans,
    items: p.items,
    ...(p.totalCents !== undefined ? { totalCents: p.totalCents } : {}),
    cameras: cfg.cameras,
    hints: judged,
    incident,
    severity: incident ? "high" : null,
    camerasSaw,
    summary,
  };
}

// ─── As an incident ───────────────────────────────────────────────────────────

/** `raw.kind` of an incident the purchase judge raised. */
export const PURCHASE_KIND = "purchase";

/**
 * The verdict as a row of the incident list. `ts` and `raw.end` are the purchase
 * window, so the clip and chat code that reads an alert's chunk span reads the
 * whole purchase. The sensor is the scenario's first camera.
 */
export function purchaseIncident(v: PurchaseVerdict): Incident {
  const w = v.window ?? { start: v.closedAt, end: v.closedAt };
  return {
    ts: w.start,
    scenarioId: v.scenarioId,
    scenarioName: v.scenarioName,
    severity: v.severity ?? "low",
    sensorId: v.cameras[0]?.id ?? v.sourceId,
    topic: PURCHASE_KIND,
    summary: v.summary,
    raw: { kind: PURCHASE_KIND, end: w.end, verdict: v },
  };
}

export function purchaseVerdictOf(incident: { raw: unknown } | null | undefined): PurchaseVerdict | null {
  const raw = incident?.raw as { kind?: unknown; verdict?: unknown } | null | undefined;
  return raw?.kind === PURCHASE_KIND && raw.verdict && typeof raw.verdict === "object"
    ? (raw.verdict as PurchaseVerdict)
    : null;
}

/** First message of "Chat about this incident": the till record and every camera, in
 *  the agent's timestamp format, so later questions ("what was scanned?") have it. */
export function purchaseChatQuestion(v: PurchaseVerdict): string {
  const w = v.window ?? { start: v.closedAt, end: v.closedAt };
  const at = (t: string) => iso(ms(t));
  const scans = v.scans.filter((s) => !s.voided).map((s) => `${s.name} at ${at(s.ts)}`);
  const voids = v.scans.filter((s) => s.voided).map((s) => `${s.name} at ${at(s.ts)}`);
  const cams = v.cameras.map((c) => (c.view ? `${c.id} (${c.view})` : c.id)).join(", ");
  const hints = v.hints
    .filter((h) => h.outcome === "remains")
    .map((h) => `${h.cameraId} at ${at(h.start)}: "${short(h.text)}"`);
  return (
    `Tell me about purchase ${v.purchaseId} at till ${v.sourceId} (scenario ${v.scenarioName}). ` +
    `Till record: ${v.startedAt ? `started ${at(v.startedAt)}; ` : ""}` +
    `scanned ${scans.length ? scans.join(", ") : "nothing"}; ` +
    (voids.length ? `voided ${voids.join(", ")}; ` : "") +
    `${v.status} at ${at(v.closedAt)}, total ${money(v.totalCents)}. ` +
    `Cameras: ${cams || "none"}. ` +
    (hints.length ? `Camera hints the till does not explain: ${hints.join("; ")}. ` : "") +
    `Use the incidents from rtvi_vlm_alert get_incidents for these cameras and run video understanding on each camera from ${w.start} to ${w.end}. ` +
    `What happened, and was anything taken without being scanned?`
  );
}
