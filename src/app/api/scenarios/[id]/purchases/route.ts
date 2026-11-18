import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import type { ScenarioEntry } from "@/lib/config-store/types";

export const dynamic = "force-dynamic";

// The purchases a multi-camera scenario judges (its clock till's, from the event
// log) with their verdicts, and a re-evaluation of one of them (#59).

type Found = { scenario: ScenarioEntry } | { error: NextResponse };

async function findScenario(id: string): Promise<Found> {
  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  const ctx = await makeReconcileContext();
  const scenario = (await ctx.store.readScenarios(ctx.instance)).find((s) => s.id === id);
  if (!scenario) return { error: NextResponse.json({ error: "unknown scenario" }, { status: 404 }) };
  if (scenario.mode !== "multi") {
    return { error: NextResponse.json({ error: "not a multi-camera scenario" }, { status: 400 }) };
  }
  return { scenario };
}

async function readTillEvents(sourceId: string) {
  const { listSourceEvents } = await import("@/lib/source-events");
  return listSourceEvents(sourceId, { limit: 5000 }).events;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const found = await findScenario((await params).id);
  if ("error" in found) return found.error;
  const { scenarioPurchases } = await import("@/lib/purchase-runner");
  try {
    return NextResponse.json(await scenarioPurchases(found.scenario, readTillEvents));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

const EvaluateSchema = z.object({ purchaseId: z.string().min(1).max(64) });

/** Re-evaluate one purchase: `{ purchaseId }` → `{ verdict }`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;
  const parsed = EvaluateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "purchaseId required" }, { status: 400 });
  const { id } = await params;
  const found = await findScenario(id);
  if ("error" in found) return found.error;

  const { reevaluatePurchase, fetchHintsBetween } = await import("@/lib/purchase-runner");
  try {
    const verdict = await reevaluatePurchase(found.scenario, parsed.data.purchaseId, { readTillEvents, fetchHintsBetween });
    if (!verdict) return NextResponse.json({ error: "no finished purchase with this id in the event log" }, { status: 404 });
    await auditLog("purchase-reevaluate", `scenario/${id}`, { purchaseId: parsed.data.purchaseId, incident: verdict.incident });
    return NextResponse.json({ verdict });
  } catch (err) {
    // Most likely the alert bridge: judging without its hints would clear the purchase.
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
