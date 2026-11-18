import "server-only";
import { CLUSTER } from "../cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("alert-bridge");

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RealtimeRule {
  id: string;
  live_stream_url: string;
  alert_type: string;
  prompt?: string;
  sensor_id?: string;
  sensor_name?: string;
}

// ─── listRealtimeIncidents ────────────────────────────────────────────────────

export class AlertBridgeHttpError extends Error {
  constructor(readonly status: number) {
    super(`alert-bridge returned HTTP ${status}`);
    this.name = "AlertBridgeHttpError";
  }
}

/** The bridge's latest incidents, raw (map them with `fromAlertBridge`). The bridge
 *  wraps the list as `{ status, incidents, count, total }`; a bare array is read too.
 *  Throws AlertBridgeHttpError on a non-2xx answer, the fetch error otherwise. */
export async function listRealtimeIncidents(limit: number, signal?: AbortSignal): Promise<unknown[]> {
  const resp = await fetch(
    `${CLUSTER.alertBridge.url}/api/v1/realtime/incidents?limit=${encodeURIComponent(String(limit))}`,
    { next: { revalidate: 0 }, signal: signal ?? AbortSignal.timeout(5_000) },
  );
  if (!resp.ok) throw new AlertBridgeHttpError(resp.status);
  return incidentList(await resp.json());
}

function incidentList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const list = (data as { incidents?: unknown } | null)?.incidents;
  return Array.isArray(list) ? list : [];
}

const bridgeTime = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The bridge's incidents between two times, page by page (`start_time`, `end_time`,
 * `limit`, `offset`; the bridge keeps them 7 days). Callers still filter by time:
 * a bridge that ignores `end_time` returns everything after `start_time`, which the
 * page cap bounds. Throws like listRealtimeIncidents.
 */
export async function listRealtimeIncidentsBetween(start: string, end: string, pageSize = 1000, maxPages = 10): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({
      start_time: bridgeTime(start),
      end_time: bridgeTime(end),
      limit: String(pageSize),
      offset: String(page * pageSize),
    });
    const resp = await fetch(`${CLUSTER.alertBridge.url}/api/v1/realtime/incidents?${q}`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new AlertBridgeHttpError(resp.status);
    const data = (await resp.json()) as { total?: unknown } | unknown[];
    const list = incidentList(data);
    out.push(...list);
    const total = !Array.isArray(data) && typeof data?.total === "number" ? data.total : 0;
    if (list.length < pageSize || out.length >= total) break;
  }
  return out;
}

// ─── listRealtimeRules ────────────────────────────────────────────────────────

/** List all realtime alert rules from the alert-bridge.
 *  Fail-soft: returns an empty array + warning string on any error; never throws. */
export async function listRealtimeRules(): Promise<{
  rules: RealtimeRule[];
  warning?: string;
}> {
  const url = CLUSTER.alertBridge.realtimeUrl;
  try {
    const resp = await fetch(url, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return {
        rules: [],
        warning: `alert-bridge returned HTTP ${resp.status} on GET ${url}`,
      };
    }

    const json = await resp.json();
    const rules: RealtimeRule[] = (json as { rules?: RealtimeRule[] }).rules ?? [];
    return { rules };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("unreachable", { err });
    return { rules: [], warning: `alert-bridge unreachable: ${msg}` };
  }
}

// ─── addRealtimeRule ──────────────────────────────────────────────────────────

/** Create a realtime alert rule. 409 is treated as success (idempotent).
 *  Returns the created rule's id on success.
 *  Fail-soft: returns ok:false + warning on any other error; never throws. */
export async function addRealtimeRule(input: {
  streamUrl: string;
  alertType: string;
  prompt: string;
  sensorName?: string;
  /** VST stream id (UUID). Lets the alert-bridge bind the rule to the exact
   *  recorded stream instead of resolving by name. */
  sensorId?: string;
  systemPrompt?: string;
  model?: string;
  /** Chunking / frame-sampling globals, mirrored from the realtime-alert-rules
   *  ConfigMap so a toggle-created rule matches the reconciler-seeded ones. */
  chunkDuration?: number;
  chunkOverlapDuration?: number;
  enableReasoning?: boolean;
  numFramesPerSecondOrFixedFramesChunk?: number;
  useFpsForChunking?: boolean;
}): Promise<{ ok: boolean; id?: string; warning?: string }> {
  const url = CLUSTER.alertBridge.realtimeUrl;

  const body: Record<string, string | number | boolean> = {
    live_stream_url: input.streamUrl,
    alert_type: input.alertType,
    prompt: input.prompt,
  };
  if (input.sensorName !== undefined) body.sensor_name = input.sensorName;
  if (input.sensorId !== undefined) body.sensor_id = input.sensorId;
  if (input.systemPrompt !== undefined) body.system_prompt = input.systemPrompt;
  if (input.model !== undefined) body.model = input.model;
  if (input.chunkDuration !== undefined) body.chunk_duration = input.chunkDuration;
  if (input.chunkOverlapDuration !== undefined) body.chunk_overlap_duration = input.chunkOverlapDuration;
  if (input.enableReasoning !== undefined) body.enable_reasoning = input.enableReasoning;
  if (input.numFramesPerSecondOrFixedFramesChunk !== undefined) body.num_frames_per_second_or_fixed_frames_chunk = input.numFramesPerSecondOrFixedFramesChunk;
  if (input.useFpsForChunking !== undefined) body.use_fps_for_chunking = input.useFpsForChunking;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });

    // 409 = already exists — treat as success (idempotent).
    if (resp.status === 409) return { ok: true };

    if (!resp.ok) {
      return {
        ok: false,
        warning: `alert-bridge returned HTTP ${resp.status} on POST`,
      };
    }

    const json = await resp.json();
    // The response shape is { status, rule: { id, ... } } but fall back to
    // a top-level id field in case the implementation differs.
    const id: string | undefined =
      (json as { rule?: { id?: string } }).rule?.id ??
      (json as { id?: string }).id;
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `alert-bridge add failed: ${msg}` };
  }
}

// ─── deleteRealtimeRule ───────────────────────────────────────────────────────

/** Delete a realtime alert rule by id. 404 is treated as success (idempotent).
 *  Fail-soft: returns ok:false + warning on any other error; never throws. */
export async function deleteRealtimeRule(
  id: string
): Promise<{ ok: boolean; warning?: string }> {
  const url = `${CLUSTER.alertBridge.realtimeUrl}/${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(url, {
      method: "DELETE",
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10_000),
    });

    // 404 = already gone — treat as success (idempotent).
    if (resp.status === 404) return { ok: true };

    if (!resp.ok) {
      return {
        ok: false,
        warning: `alert-bridge returned HTTP ${resp.status} on DELETE`,
      };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `alert-bridge delete failed: ${msg}` };
  }
}
