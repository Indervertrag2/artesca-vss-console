import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { newSourceToken } from "@/lib/source-events";

export const dynamic = "force-dynamic";

/** Rotate the source's token. The old one stops working at once; the new one is
 *  in this answer and nowhere else. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;
  const { id } = await params;

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  const ctx = await makeReconcileContext();
  const source = (await ctx.store.readSources(ctx.instance)).find((s) => s.id === id);
  if (!source) return NextResponse.json({ error: "unknown source" }, { status: 404 });

  const { token, tokenHash } = newSourceToken();
  await ctx.store.upsertSource(ctx.instance, { ...source, tokenHash }, session.user?.email ?? "console");
  await auditLog("source-token-rotate", `source/${id}`, {});
  return NextResponse.json({ token });
}
