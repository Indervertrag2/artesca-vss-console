// GET /api/incidents/live
// SSE: stream realtime incidents to connected operators.
//
// The realtime alert-bridge (vss-alert-bridge) writes incidents to
// Elasticsearch and serves them at /api/v1/realtime/incidents — it does NOT
// publish them to any Kafka topic, so this SSE POLLS the bridge and pushes
// newly-seen incidents (rather than consuming Kafka). The first poll primes the
// seen-set without emitting (latest-only semantics — the page refetches
// GET /api/incidents each time the stream opens, which covers that poll).
// Auth required.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createSseResponse } from "@/lib/streams/sse";
import { IncidentSchema } from "@/lib/schemas";
import { fromAlertBridge, alertBridgeIncidentKey } from "@/lib/helpers/incident-wire";
import { listRealtimeIncidents } from "@/lib/helpers/alert-bridge";
import { hiddenCameraIds, listPurchaseIncidents } from "@/lib/purchase-runner";
import { PURCHASE_KIND } from "@/lib/purchase-judge";
import type { Incident } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 4_000;
const SEEN_CAP = 2_000;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return createSseResponse<Incident>(req.signal, async (write) => {
    const seen = new Set<string>();
    let primed = false;

    const poll = async () => {
      try {
        // Bound each poll so a slow/unreachable bridge can't stall the
        // stream open (the initial poll is awaited before the interval).
        const list = await listRealtimeIncidents(
          50,
          AbortSignal.any([req.signal, AbortSignal.timeout(POLL_MS)]),
        );
        // Alerts of multi-camera scenario cameras are hints inside a purchase
        // incident; those come from SQLite (purchase-runner.ts).
        const hidden = await hiddenCameraIds();
        const items = [
          ...[...list].reverse().map((raw) => ({ key: alertBridgeIncidentKey(raw), inc: fromAlertBridge(raw) })),
          ...listPurchaseIncidents(50)
            .reverse()
            .map((inc) => ({ key: `purchase:${inc.ts}::${inc.sensorId}`, inc })),
        ];
        // Oldest-first so events arrive in chronological order.
        for (const { key, inc } of items) {
          if (seen.has(key)) continue;
          seen.add(key);
          if (!primed) continue; // first pass: record only, don't replay the backlog
          const result = IncidentSchema.safeParse(inc);
          if (result.success && (result.data.topic === PURCHASE_KIND || !hidden.has(result.data.sensorId))) {
            write(result.data as Incident);
          }
        }
        primed = true;
        // Bound memory on long-lived connections (oldest keys first; the live
        // window of incidents is always re-added so it's never pruned).
        if (seen.size > SEEN_CAP) {
          for (const k of [...seen].slice(0, seen.size - SEEN_CAP)) seen.delete(k);
        }
      } catch {
        // Transient (bridge blip / request abort) — the next tick retries.
      }
    };

    await poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  });
}
