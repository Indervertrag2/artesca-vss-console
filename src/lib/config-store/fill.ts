/**
 * Fill an emptied config store from a saved copy, never over what it holds.
 *
 * The AI Factory's GPU switch saves this console's cameras, scenarios and prompt
 * sets (`GET /api/config-store/export`) when the box leaves `vss` mode, and on its
 * way back hands the copy to `POST /api/config-store/restore`. The store on the
 * Pyramid showroom was found with `cameras: []` and `scenarios: []` on 2026-10-28,
 * cause unknown; this is the repair, and its one rule is that it only ever fills
 * a list that is empty. A list holding anything is kept exactly as it is, so an
 * operator's edit made while the box was in another mode always wins.
 *
 * Pure: `FileConfigStore.fillEmpty` runs it under the file's cross-process lock,
 * so the emptiness check and the write are one step.
 */
import { z } from "zod";
import { CONFIG_SCHEMA } from "@/lib/config-store/file";
import { CAMERA_ID_RE, CameraRecordingSchema, RTSP_URL_RE } from "@/lib/schemas";

export const FILL_LISTS = ["cameras", "scenarios", "promptSets"] as const;
export type FillList = (typeof FILL_LISTS)[number];

/** At most this many entries per list: a showroom holds 4 cameras and 4 scenarios. */
export const FILL_MAX_ENTRIES = 256;

export interface FillSource {
  cameras: Record<string, unknown>[];
  scenarios: Record<string, unknown>[];
  promptSets: Record<string, unknown>[];
  activePromptId: string | null;
}

export interface FillResult {
  /** The lists that were empty and are now the copy's. */
  restored: FillList[];
  /** The lists that held entries and were left as they are. */
  kept: FillList[];
  /** Whether `activePromptId` was set (only with the prompt sets it names, and only when unset). */
  activePromptId: boolean;
}

/**
 * Each entry, field by field, as the store holds it and as the normal routes would have written it: the camera id
 * and RTSP rule of POST /api/cameras, the scenario fields of the stored ScenarioEntry, the prompt set of PATCH
 * /api/prompt. Every object is strict: an unknown field is refused, so a restore cannot plant a field or a URL the
 * reconcile loop would act on that no route accepts. The store's own stamps (`updatedBy`, `updatedAt`) are accepted
 * and replaced by the restore's.
 */
const STAMPS = { updatedBy: z.string().max(256).optional(), updatedAt: z.string().max(64).optional() };
const ENTRY_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const SHORT = z.string().max(512);

export const FillCameraSchema = z
  .object({
    id: z.string().regex(CAMERA_ID_RE),
    rtspUrl: z.string().max(2048).regex(RTSP_URL_RE),
    description: SHORT.optional(),
    role: z.string().max(64).optional(),
    scenarioIds: z.array(ENTRY_ID).max(FILL_MAX_ENTRIES).optional(),
    promptId: ENTRY_ID.optional(),
    recording: CameraRecordingSchema.strict().optional(),
    ...STAMPS,
  })
  .strict();

export const FillScenarioSchema = z
  .object({
    id: ENTRY_ID,
    name: z.string().min(1).max(200),
    description: z.string().max(4096).optional(),
    severity: z.enum(["low", "medium", "high", "critical"]),
    channels: z.array(z.enum(["ui", "slack"])).max(2),
    sensor_filter: z.string().max(2048),
    keywords: z.array(z.string().max(200)).max(256),
    enabled: z.boolean(),
    cooldown_seconds: z.number().int().nonnegative().max(86400).optional(),
    ...STAMPS,
  })
  .strict();

export const FillPromptSetSchema = z
  .object({
    id: ENTRY_ID,
    name: z.string().min(1).max(200),
    text: z.string().max(65536),
    model: z.string().max(256).optional(),
    alertType: z.string().max(128).optional(),
    ...STAMPS,
  })
  .strict();

const ENTRY_SCHEMA: Record<FillList, z.ZodTypeAny> = { cameras: FillCameraSchema, scenarios: FillScenarioSchema, promptSets: FillPromptSetSchema };

export class FillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FillError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The request body, checked with the store's own shape rules (a list of mappings,
 * each with a unique non-empty string `id`). `schema` and `instance`, when present,
 * must be this store's: a copy of another instance is refused rather than written.
 */
export function parseFillSource(raw: unknown, instance: string): FillSource {
  if (!isObj(raw)) throw new FillError("body: expected a JSON object");
  const known = new Set<string>(["schema", "instance", "activePromptId", ...FILL_LISTS]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k)).sort();
  if (unknown.length) throw new FillError(`body: unknown field(s) ${unknown.join(", ")}`);
  if (raw.schema !== undefined && raw.schema !== CONFIG_SCHEMA) throw new FillError(`body: schema must be ${CONFIG_SCHEMA}`);
  if (raw.instance !== undefined && raw.instance !== instance) {
    throw new FillError(`body: a copy of instance ${JSON.stringify(raw.instance)}, this console is ${JSON.stringify(instance)}`);
  }
  const list = (key: FillList): Record<string, unknown>[] => {
    const v = raw[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new FillError(`body: ${key} must be a list`);
    if (v.length > FILL_MAX_ENTRIES) throw new FillError(`body: ${key} holds ${v.length} entries, at most ${FILL_MAX_ENTRIES}`);
    const ids = new Set<string>();
    return v.map((e, i) => {
      if (!isObj(e)) throw new FillError(`body: ${key}[${i}] must be an object`);
      const parsed = ENTRY_SCHEMA[key].safeParse(e);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new FillError(`body: ${key}[${i}]${issue.path.length ? "." + issue.path.join(".") : ""}: ${issue.message}`);
      }
      const { updatedBy: _by, updatedAt: _at, ...entry } = parsed.data as Record<string, unknown>;
      void _by;
      void _at;
      const id = entry.id as string;
      if (ids.has(id)) throw new FillError(`body: ${key} holds id ${JSON.stringify(id)} twice`);
      ids.add(id);
      return entry;
    });
  };
  const active = raw.activePromptId;
  if (active !== undefined && active !== null && (typeof active !== "string" || !active)) {
    throw new FillError("body: activePromptId must be a non-empty string or null");
  }
  return { cameras: list("cameras"), scenarios: list("scenarios"), promptSets: list("promptSets"), activePromptId: (active as string | undefined) ?? null };
}

/**
 * What a fill does to the stored lists: each empty list the copy has entries for
 * becomes the copy's; every other list is untouched. `activePromptId` is set only
 * when it is unset, the prompt sets were restored, and they hold that id.
 */
export function planFill(
  stored: { cameras: unknown[]; scenarios: unknown[]; promptSets: Record<string, unknown>[]; activePromptId?: string },
  src: FillSource,
): FillResult & { next: Partial<Pick<FillSource, FillList>> & { activePromptId?: string } } {
  const restored: FillList[] = [];
  const kept: FillList[] = [];
  const next: Partial<Pick<FillSource, FillList>> & { activePromptId?: string } = {};
  for (const key of FILL_LISTS) {
    if (src[key].length === 0) continue;
    if (stored[key].length > 0) {
      kept.push(key);
      continue;
    }
    next[key] = src[key];
    restored.push(key);
  }
  let active = false;
  if (restored.includes("promptSets") && !stored.activePromptId && src.activePromptId && src.promptSets.some((s) => s.id === src.activePromptId)) {
    next.activePromptId = src.activePromptId;
    active = true;
  }
  return { restored, kept, activePromptId: active, next };
}
