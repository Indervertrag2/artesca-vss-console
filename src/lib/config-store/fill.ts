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
import { CONFIG_SCHEMA } from "@/lib/config-store/file";

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
      if (typeof e.id !== "string" || !e.id) throw new FillError(`body: ${key}[${i}] has no string id`);
      if (ids.has(e.id)) throw new FillError(`body: ${key} holds id ${JSON.stringify(e.id)} twice`);
      ids.add(e.id);
      return { ...e };
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
