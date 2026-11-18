import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { auth } from "@/lib/auth";
import { fromAlertBridge } from "@/lib/helpers/incident-wire";
import { AlertBridgeHttpError, listRealtimeIncidents } from "@/lib/helpers/alert-bridge";
import { withPurchaseIncidents } from "@/lib/purchase-runner";
import type { Incident } from "@/lib/types";

export const dynamic = "force-dynamic";

// k8s runtime: incidents come from the realtime alert-bridge
// (vss-alert-bridge) GET /api/v1/realtime/incidents — it's the service that
// actually produces incidents (into ES) for live RTSP alert rules. The older
// ALERT_WORKER_URL (vss-video-analytics-api) has no /api/incidents endpoint.

const SYNTHETIC_EVENTS_PATH =
  process.env.SYNTHETIC_EVENTS_PATH ?? "/data/synthetic-events.jsonl";

type CaptionsEnvelope = {
  ingestedAt: string;
  streamId: string;
  sensorName: string;
  vlmResponse: {
    id?: string;
    model?: string;
    media_info?: { start_timestamp?: string; end_timestamp?: string };
    chunk_responses?: { start_time?: string; end_time?: string; content?: string }[];
  };
};

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;


  try {
    const list = await listRealtimeIncidents(safeLimit);
    // Alerts of multi-camera scenario cameras are hints inside a purchase
    // incident, which is listed instead (purchase-runner.ts).
    const incidents = await withPurchaseIncidents(list.map(fromAlertBridge) as Incident[], safeLimit);
    return NextResponse.json({ incidents });
  } catch (err) {
    if (err instanceof AlertBridgeHttpError) {
      return NextResponse.json({ error: err.message, incidents: [] }, { status: 502 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `alert-bridge unreachable: ${msg}`, incidents: [] },
      { status: 503 }
    );
  }
}
