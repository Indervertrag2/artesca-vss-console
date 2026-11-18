import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";

export const dynamic = "force-dynamic";

const ImportSchema = z.object({ since: z.string().datetime({ offset: true }) });

/** Import a till's purchases and bookings since `since` into the event log, once
 *  (`importTillHistory`), so purchases from before the poll started can be judged. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;
  const { id } = await params;

  const parsed = ImportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "since must be an ISO date-time" }, { status: 400 });

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  const ctx = await makeReconcileContext();
  const source = (await ctx.store.readSources(ctx.instance)).find((s) => s.id === id);
  if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });
  if (source.type !== "till" || !source.baseUrl) {
    return NextResponse.json({ error: "history import needs a till with a base URL" }, { status: 400 });
  }

  const { importTillHistory } = await import("@/lib/source-poll");
  try {
    const added = await importTillHistory(source, parsed.data.since);
    await auditLog("source-import", `source/${id}`, { since: parsed.data.since, added });
    return NextResponse.json({ added });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
