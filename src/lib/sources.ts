// External sources: inputs that are not cameras (a till, a scale). Shared by the
// API routes, the proxy and the /cameras/sources page, so nothing here may be
// server-only. Storage of the events is in `source-events.ts`.
import { z } from "zod";
import type { SourceEntry } from "@/lib/config-store/types";

export const SOURCE_TYPES = ["till", "scale", "generic"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  till: "Till / POS",
  scale: "Scale",
  generic: "Generic",
};

/** What a till sends (scanlog's webhook). Other event names are stored as they come. */
export const TILL_EVENTS = [
  "purchase_started",
  "item_scanned",
  "item_voided",
  "purchase_closed",
  "purchase_cancelled",
  "weight_mismatch",
  "staff_called",
] as const;

/** A source id is a URL path segment, and the till is configured with that URL,
 *  so it is fixed at create time and survives a rename. */
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function sourceIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 63);
}

export const eventInputPath = (id: string) => `/api/sources/${id}/events`;

const EVENT_INPUT = /^\/api\/sources\/[^/]+\/events$/;

/**
 * The one request the proxy lets through without a session: a source posting an
 * event. The route authenticates it by the source's token. Reading the log
 * (GET on the same path) still needs a session.
 */
export function isEventInputRequest(method: string, pathname: string): boolean {
  return method === "POST" && EVENT_INPUT.test(pathname);
}

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => v || undefined);

export const SOURCE_MODES = ["push", "pull", "both"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

export const SOURCE_MODE_LABEL: Record<SourceMode, string> = {
  push: "Push (source sends)",
  pull: "Pull (console reads)",
  both: "Push + pull",
};

/** Whether the console reads this source's API itself (source-poll.ts). */
export const pulls = (s: { type: SourceType; baseUrl?: string; mode?: SourceMode; enabled: boolean }) =>
  s.enabled && s.type === "till" && !!s.baseUrl && (s.mode === "pull" || s.mode === "both");

const httpUrl = /^https?:\/\/[^\s/]+[^\s]*$/i;

/** Body of POST /api/sources and PUT /api/sources/[id]. Empty strings mean absent. */
export const SourceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(SOURCE_TYPES),
    baseUrl: optionalText(300).refine((v) => !v || httpUrl.test(v), {
      message: "baseUrl must be an http:// or https:// URL",
    }),
    lane: optionalText(64),
    mode: z.enum(SOURCE_MODES).default("push"),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.mode === "push" || (v.type === "till" && !!v.baseUrl), {
    message: "pull needs a till with a base URL",
    path: ["mode"],
  });

export const ProbeUrlSchema = z.string().trim().max(300).regex(httpUrl);

/** An incoming event. A till must carry scanlog's running number and timestamp. */
export const SourceEventInputSchema = z
  .object({
    event: z.string().trim().min(1).max(64),
    seq: z.number().int().nonnegative().optional(),
    ts_utc: z.string().max(64).optional(),
    lane: z.string().max(128).optional(),
  })
  .passthrough();

export const TillEventInputSchema = SourceEventInputSchema.extend({
  seq: z.number().int().nonnegative(),
  ts_utc: z.string().min(1).max(64),
});

// ─── Wire shapes the page validates ──────────────────────────────────────────

export const SourceHealthSchema = z.object({
  reachable: z.boolean(),
  status: z.number().optional(),
  /** Source clock minus console clock. */
  clockOffsetMs: z.number().optional(),
  lane: z.string().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const LastEventSchema = z.object({
  event: z.string(),
  receivedAt: z.string(),
  sessionId: z.union([z.string(), z.number()]).optional(),
});

/** The poller's last pass over one source, from memory in the console process. */
export const PullStateSchema = z.object({
  lastPollAt: z.string(),
  lastOkAt: z.string().optional(),
  error: z.string().optional(),
  /** New events stored by the last pass. */
  added: z.number(),
});
export type PullState = z.infer<typeof PullStateSchema>;

export const SourceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(SOURCE_TYPES),
  baseUrl: z.string().optional(),
  lane: z.string().optional(),
  mode: z.enum(SOURCE_MODES),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  lastEvent: LastEventSchema.nullable().optional(),
  health: SourceHealthSchema.optional(),
  /** Present once the poller has run for a pulling source. */
  pull: PullStateSchema.optional(),
});
export type SourceView = z.infer<typeof SourceViewSchema>;

export const SourceEventSchema = z.object({
  id: z.number(),
  receivedAt: z.string(),
  event: z.string(),
  ts: z.string().nullable(),
  seq: z.number().nullable(),
  lane: z.string().nullable(),
  /** Events missing just before this one, from a jump in `seq`. */
  gap: z.number(),
  payload: z.record(z.unknown()),
});
export type SourceEvent = z.infer<typeof SourceEventSchema>;

export const SourceEventsResponseSchema = z.object({
  events: z.array(SourceEventSchema),
  counts: z.record(z.number()),
  gaps: z.number(),
});

/** A source as the API returns it: everything but the token hash. */
export function toSourceView(s: SourceEntry): SourceView {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
    ...(s.lane ? { lane: s.lane } : {}),
    mode: s.mode ?? "push",
    enabled: s.enabled,
    createdAt: s.createdAt,
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
  };
}

const ENVELOPE = new Set(["event", "lane", "ts_utc", "seq", "session_id"]);

/** One line for the log's Details column, from whatever fields the event carries. */
export function eventDetails(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof payload.name === "string") parts.push(payload.name);
  for (const [k, v] of Object.entries(payload)) {
    if (ENVELOPE.has(k) || k === "name" || v === null) continue;
    if (Array.isArray(v)) parts.push(`${v.length} ${k}`);
    else if (typeof v === "object") continue;
    else if (k === "total_cents" && typeof v === "number") parts.push(`total ${(v / 100).toFixed(2)}`);
    else parts.push(`${k} ${String(v)}`);
  }
  return parts.join(" · ");
}
