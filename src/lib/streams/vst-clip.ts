// Shared VST clip-retrieval helpers used by the clip-serving routes
// (/api/clips/[sensor]/[ts] and /api/clips/preload).
//
// Incidents carry a sensor *name* (e.g. "checkout-1"); the VST clip-download
// API is keyed by stream id. We resolve the name to the active stream id, then
// download the clip window (clipWindow) as MP4 from /storage/file/{streamId}
// on the VST storage base.

import { z } from "zod";
import { CLUSTER } from "@/lib/cluster-refs";

/**
 * Resolves the active VST stream id for a sensor *name*.
 * Re-adds leave stale duplicate sensors of the same name, so prefer the one
 * that is online with a recorded timeline. Returns null when none match.
 */
export async function resolveStreamId(sensor: string): Promise<string | null> {
  try {
    const resp = await fetch(CLUSTER.vst.sensorListUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as unknown;
    const list = Array.isArray(data)
      ? data
      : ((data as { sensors?: unknown[]; data?: unknown[] }).sensors ??
         (data as { data?: unknown[] }).data ??
         []);
    const sensors = list as Array<{
      name?: string;
      sensorId?: string;
      state?: string;
      isTimelinePresent?: boolean;
    }>;
    const match =
      sensors.find(
        (s) => s.name === sensor && s.state === "online" && s.isTimelinePresent
      ) ?? sensors.find((s) => s.name === sensor);
    const sid = match?.sensorId;
    if (!sid) return null;

    // Resolve the stream id under this sensor; fall back to the sensor id
    // (on the current build streamId === sensorId for live RTSP sensors).
    try {
      const sr = await fetch(`${CLUSTER.vst.sensorBase}/${sid}/streams`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (sr.ok) {
        const sd = (await sr.json()) as unknown;
        const streams = (
          Array.isArray(sd)
            ? sd
            : ((sd as { streams?: unknown[]; data?: unknown[] }).streams ??
               (sd as { data?: unknown[] }).data ??
               [])
        ) as Array<{ streamId?: string }>;
        if (streams[0]?.streamId) return streams[0].streamId;
      }
    } catch {
      /* fall through to sensorId */
    }
    return sid;
  } catch {
    return null;
  }
}

const isoDatetime = z.string().datetime({ offset: true });

/**
 * Footage kept after an incident's chunk end. The VLM fires on the chunk in
 * which the act begins (a person walking up with the goods); the act itself
 * follows. Measured on a self-checkout loop: the alert chunk ended as the
 * person arrived, the items went past the scanner over the next 17 s.
 * `CLIP_TAIL_S` overrides it per deployment.
 */
const TAIL_MS = (Number(process.env.CLIP_TAIL_S) || 20) * 1_000;

/**
 * VST finalizes a recording late: measured, a window that ended 10 s ago 404s
 * (VMSNoDataError), 30 s ago returns 17 of 20 s, 50 s ago is complete.
 */
export const CLIP_SETTLE_MS = 60_000;

/**
 * The clip window for an incident. Without `end`: ±5 s around `ts`. With an
 * `end` (a valid ISO datetime after `ts`, anything else is ignored), the
 * incident's span — `ts` is the chunk start — padded to [ts - 2 s, end + tail]
 * and capped at 60 s. `key` names the PVC cache entry, so a span never reuses
 * the cached ±5 s clip of the same `ts`, nor a clip cut with another tail.
 * `thumbSecs`: thumbnail offset, the middle of a span. `settled`: VST has
 * finalized the whole window, so fetching it now neither misses nor truncates.
 */
export function clipWindow(
  ts: string,
  end?: string | null,
  now = Date.now(),
): { start: Date; end: Date; key: string; thumbSecs: number; settled: boolean } {
  const t = new Date(ts).getTime();
  const e = end && isoDatetime.safeParse(end).success ? new Date(end).getTime() : NaN;
  if (!(e > t)) {
    const stop = t + 5_000;
    return {
      start: new Date(t - 5_000),
      end: new Date(stop),
      key: ts,
      thumbSecs: 0,
      settled: stop <= now - CLIP_SETTLE_MS,
    };
  }
  const start = t - 2_000;
  const stop = Math.min(e + TAIL_MS, start + 60_000);
  return {
    start: new Date(start),
    end: new Date(stop),
    key: `${ts}_${end}_${TAIL_MS / 1_000}s`,
    thumbSecs: (stop - start) / 2_000,
    settled: stop <= now - CLIP_SETTLE_MS,
  };
}

/**
 * Builds the VST clip-download URL for a stream id over clipWindow(ts, end).
 * GET /storage/file/{streamId}?startTime=..&endTime=..&container=mp4 returns
 * binary MP4 bytes (verified on the live alerts build).
 */
export function buildVstClipUrl(streamId: string, ts: string, end?: string | null): string {
  const win = clipWindow(ts, end);
  return vstFileUrl(streamId, win.start, win.end);
}

/** The VST download URL of a stream's recording from `start` to `end`, as given:
 *  no padding and no 60 s cap (a purchase window can be longer). */
export function vstFileUrl(streamId: string, start: Date, end: Date): string {
  const base = process.env.VST_MS_URL ?? CLUSTER.vst.storageBase;
  return `${base}/storage/file/${encodeURIComponent(streamId)}?startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}&container=mp4&disableAudio=true`;
}
